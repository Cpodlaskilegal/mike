// The MCP server an agent token talks to. One is built per request.
//
// It only serves tools. tools/list shows what the token may call. tools/call
// checks the policy, then runs Docket's own MCP client path against the
// user's connector, so the address guard, the user's stored sign-in and the
// audit rows are the same ones Docket chat uses.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { boxToolRequiresApproval } from "../mcp/boxAccessPolicy";
import { normalizeJsonSchema } from "../mcp/client";
import { McpOAuthRequiredError } from "../mcp/oauth";
import { classifyMcpAction } from "../mcp/practicePantherAttribution";
import { executeResolvedMcpToolCall } from "../mcp/servers";
import type { ConnectorRow, Db, ToolCacheRow } from "../mcp/types";
import { redactSensitiveText, safeErrorLog } from "../safeError";
import {
  agentBoxOrganizeEnabled,
  agentPracticePantherWritesEnabled,
  type AgentSource,
} from "./config";
import type { AgentGatewayDeps } from "./deps";
import {
  authorizeAgentTool,
  boxOrganizeTargetRefs,
  isAgentBoxOrganizeTool,
} from "./policy";
import type { AgentPrincipal } from "./tokens";

export const AGENT_UPSTREAM_TIMEOUT_MS = 75_000;

const SERVER_INFO = { name: "docket-agent-gateway", version: "1.0.0" };
const DENIED_TEXT = "This tool is not available to Docket Agent.";

const SOURCE_LABELS: Record<AgentSource, string> = {
  practicepanther: "PracticePanther",
  box: "Box",
  quo: "Quo",
};

type AgentServerContext = {
  principal: AgentPrincipal;
  source: AgentSource;
  connector: ConnectorRow;
  db: Db;
  deps: Pick<AgentGatewayDeps, "withUpstreamClient" | "refreshTools">;
};

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function loadCachedTools(
  connectorId: string,
  db: Db,
): Promise<ToolCacheRow[]> {
  const { data, error } = await db
    .from("user_mcp_connector_tools")
    .select("*")
    .eq("connector_id", connectorId)
    .order("tool_name", { ascending: true });
  if (error) throw new Error("Tool cache lookup failed.");
  return (data ?? []) as ToolCacheRow[];
}

async function loadCachedTool(
  connectorId: string,
  toolName: string,
  db: Db,
): Promise<ToolCacheRow | null> {
  const { data, error } = await db
    .from("user_mcp_connector_tools")
    .select("*")
    .eq("connector_id", connectorId)
    .eq("tool_name", toolName)
    .maybeSingle();
  if (error) throw new Error("Tool cache lookup failed.");
  return (data as ToolCacheRow | null) ?? null;
}

function toMcpTool(row: ToolCacheRow): Tool {
  const annotations = isPlainObject(row.annotations) ? row.annotations : null;
  return {
    name: row.tool_name,
    ...(row.title ? { title: row.title } : {}),
    ...(row.description ? { description: row.description } : {}),
    inputSchema: normalizeJsonSchema(row.input_schema) as Tool["inputSchema"],
    // No outputSchema on purpose: results are passed on as upstream sent them.
    ...(annotations && Object.keys(annotations).length
      ? { annotations: annotations as Tool["annotations"] }
      : {}),
  };
}

function actionKindOf(
  ctx: AgentServerContext,
  tool: ToolCacheRow | null,
  toolName: string,
  args: Record<string, unknown>,
): "read" | "mutation" {
  if (ctx.source === "box" && tool) {
    return boxToolRequiresApproval(tool, args) ? "mutation" : "read";
  }
  return classifyMcpAction(toolName, args, tool?.annotations);
}

/**
 * The audit row for a call the gateway itself stopped: a denial, or a
 * connection that could not be opened. A failed insert is logged and does
 * not change the answer. No arguments and no results are stored.
 */
async function insertAgentAuditLog(
  ctx: AgentServerContext,
  row: {
    tool: ToolCacheRow | null;
    toolName: string;
    actionKind: "read" | "mutation";
    errorMessage: string;
  },
): Promise<void> {
  try {
    const { error } = await ctx.db.from("user_mcp_tool_audit_logs").insert({
      user_id: ctx.principal.userId,
      connector_id: ctx.connector.id,
      tool_id: row.tool?.id ?? null,
      tool_name: row.toolName.slice(0, 200),
      openai_tool_name: (row.tool?.openai_tool_name ?? row.toolName).slice(
        0,
        200,
      ),
      actor_email: ctx.principal.email,
      action_kind: row.actionKind,
      status: "error",
      error_message: row.errorMessage,
      duration_ms: 0,
      result_size_chars: 0,
      practicepanther_audit_status: "not_required",
      origin: "docket_agent",
      agent_token_id: ctx.principal.tokenId,
    });
    if (error) throw new Error("audit insert failed");
  } catch (err) {
    console.error("[agent-gateway] failed to write audit log", {
      userId: ctx.principal.userId,
      tokenId: ctx.principal.tokenId,
      source: ctx.source,
      error: safeErrorLog(err),
    });
  }
}

/**
 * Puts the Box ids an organize call named on its audit row. Docket's own
 * writer fills that column for PracticePanther records only; without this a
 * move would be on record with nothing saying what was moved. Ids only. A
 * failed update is logged and does not change the answer.
 */
async function recordBoxOrganizeRefs(
  ctx: AgentServerContext,
  auditId: string | undefined,
  args: Record<string, unknown>,
): Promise<void> {
  if (!auditId) return;
  try {
    const { error } = await ctx.db
      .from("user_mcp_tool_audit_logs")
      .update({ target_refs: boxOrganizeTargetRefs(args) })
      .eq("id", auditId);
    if (error) throw new Error("audit update failed");
  } catch (err) {
    console.error("[agent-gateway] failed to record Box ids on audit log", {
      userId: ctx.principal.userId,
      tokenId: ctx.principal.tokenId,
      error: safeErrorLog(err),
    });
  }
}

async function listTools(ctx: AgentServerContext): Promise<{ tools: Tool[] }> {
  let rows = await loadCachedTools(ctx.connector.id, ctx.db);
  if (!rows.length) {
    // An empty cache: read the tool list from upstream once. Never when
    // rows exist; for Box this is the row Docket chat uses.
    try {
      await ctx.deps.refreshTools(ctx.principal.userId, ctx.connector.id, ctx.db);
      rows = await loadCachedTools(ctx.connector.id, ctx.db);
    } catch (err) {
      console.warn("[agent-gateway] tool list refresh failed", {
        userId: ctx.principal.userId,
        source: ctx.source,
        error: safeErrorLog(err),
      });
      return { tools: [] };
    }
  }
  const writesEnabled = agentPracticePantherWritesEnabled();
  const organizeEnabled = agentBoxOrganizeEnabled();
  return {
    tools: rows
      .filter(
        (tool) =>
          authorizeAgentTool({
            source: ctx.source,
            role: ctx.principal.role,
            connector: ctx.connector,
            tool,
            toolName: tool.tool_name,
            args: {},
            practicePantherWritesEnabled: writesEnabled,
            boxOrganizeEnabled: organizeEnabled,
            forListing: true,
          }).effect === "allow",
      )
      .map(toMcpTool),
  };
}

async function callTool(
  ctx: AgentServerContext,
  name: string,
  rawArgs: unknown,
): Promise<CallToolResult> {
  if (rawArgs !== undefined && rawArgs !== null && !isPlainObject(rawArgs)) {
    return toolError("Tool arguments must be an object.");
  }
  const args: Record<string, unknown> = isPlainObject(rawArgs) ? rawArgs : {};

  const tool = await loadCachedTool(ctx.connector.id, name, ctx.db);
  const decision = authorizeAgentTool({
    source: ctx.source,
    role: ctx.principal.role,
    connector: ctx.connector,
    tool,
    toolName: name,
    args,
    practicePantherWritesEnabled: agentPracticePantherWritesEnabled(),
    boxOrganizeEnabled: agentBoxOrganizeEnabled(),
  });

  if (decision.effect === "deny" || !tool) {
    const reason = decision.effect === "deny" ? decision.reason : "unknown_tool";
    await insertAgentAuditLog(ctx, {
      tool,
      toolName: name,
      actionKind: actionKindOf(ctx, tool, name, args),
      errorMessage: `Denied by Docket Agent gateway: ${reason}`,
    });
    return toolError(DENIED_TEXT);
  }

  // Docket's own writer decides "read" or "change" from the tool's name.
  // "Users_Me" has no verb in it, so it would go on record as a change. The
  // policy above has already decided it is a read; say so, unless the tool's
  // own hints say otherwise. A name with a change verb in it is still
  // recorded as a change whatever the hint says.
  const executedTool: ToolCacheRow =
    ctx.source === "practicepanther" &&
    decision.kind === "read" &&
    tool.annotations?.readOnlyHint === undefined
      ? { ...tool, annotations: { ...tool.annotations, readOnlyHint: true } }
      : tool;

  let upstream: unknown;
  let upstreamSet = false;
  let outcome: Awaited<ReturnType<typeof executeResolvedMcpToolCall>>;
  try {
    outcome = await ctx.deps.withUpstreamClient(
      ctx.connector,
      (client) =>
        executeResolvedMcpToolCall({
          userId: ctx.principal.userId,
          connector: ctx.connector,
          tool: executedTool,
          args,
          db: ctx.db,
          context: {
            actorEmail: ctx.principal.email,
            origin: "docket_agent",
            agentTokenId: ctx.principal.tokenId,
          },
          callTool: async (toolName, toolArgs) => {
            const result = await client.callTool(
              { name: toolName, arguments: toolArgs },
              undefined,
              {
                timeout: AGENT_UPSTREAM_TIMEOUT_MS,
                maxTotalTimeout: AGENT_UPSTREAM_TIMEOUT_MS,
              },
            );
            if (toolName === tool.tool_name) {
              upstream = result;
              upstreamSet = true;
            }
            return result;
          },
        }),
      ctx.db,
    );
  } catch (err) {
    // The connection could not be opened, or the stored sign-in was refused.
    const needsReconnect = err instanceof McpOAuthRequiredError;
    const label = SOURCE_LABELS[ctx.source];
    const message = needsReconnect
      ? `The ${label} connection in Docket needs to be reconnected.`
      : `The ${label} service could not be reached.`;
    console.error("[agent-gateway] upstream call failed", {
      userId: ctx.principal.userId,
      tokenId: ctx.principal.tokenId,
      source: ctx.source,
      tool: tool.tool_name,
      error: safeErrorLog(err),
    });
    await insertAgentAuditLog(ctx, {
      tool,
      toolName: tool.tool_name,
      actionKind: decision.kind === "read" ? "read" : "mutation",
      errorMessage: message,
    });
    return toolError(message);
  }

  if (ctx.source === "box" && isAgentBoxOrganizeTool(tool.tool_name)) {
    await recordBoxOrganizeRefs(ctx, outcome.event.docket_audit_id, args);
  }

  // The upstream answer goes back as it came, tool errors included.
  if (upstreamSet && isPlainObject(upstream)) {
    return upstream as CallToolResult;
  }

  // The call was blocked before it was sent, or the connection broke.
  let text = redactSensitiveText(
    outcome.event.error ?? "MCP tool call failed.",
  );
  if (outcome.event.execution_outcome === "indeterminate") {
    text += " The outcome is uncertain. Check the record before trying again.";
  }
  return toolError(text);
}

export function buildAgentMcpServer(ctx: AgentServerContext): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => listTools(ctx));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(ctx, request.params.name, request.params.arguments),
  );
  return server;
}
