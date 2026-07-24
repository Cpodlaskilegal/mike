import crypto from "node:crypto";
import { pool } from "../supabase";
import { decryptString, encryptString } from "./client";
import type {
  ConnectorRow,
  McpExecutionContext,
  McpToolEvent,
  ToolCacheRow,
} from "./types";

const MCP_APPROVAL_TTL_MS = 30 * 60 * 1000;
const MCP_APPROVAL_EXECUTION_STALE_MS = 5 * 60 * 1000;
const MAX_PREVIEW_DEPTH = 100;
const SENSITIVE_ARGUMENT_KEY_RE =
  /authorization|bearer|token|secret|password|api[_-]?key|client[_-]?secret|cookie|headers?/i;

export type McpApprovalStatus =
  | "pending"
  | "executing"
  | "succeeded"
  | "failed"
  | "indeterminate"
  | "rejected"
  | "expired";

export type McpApprovalRow = {
  id: string;
  request_key: string;
  user_id: string;
  actor_email: string;
  connector_id: string;
  tool_id: string | null;
  connector_name: string;
  tool_name: string;
  openai_tool_name: string;
  encrypted_arguments: string;
  arguments_iv: string;
  arguments_tag: string;
  arguments_hash: string;
  arguments_preview: Record<string, unknown>;
  policy_version: string;
  status: McpApprovalStatus;
  chat_id: string | null;
  assistant_message_id: string | null;
  assistant_run_id: string | null;
  trace_id: string | null;
  project_id: string | null;
  tool_call_id: string | null;
  expires_at: string | Date;
  decided_at: string | Date | null;
  executed_at: string | Date | null;
  error_message: string | null;
  result_event: McpToolEvent | null;
  result_content: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type McpApprovalSummary = {
  id: string;
  status: McpApprovalStatus;
  actorEmail: string;
  connectorName: string;
  toolName: string;
  openaiToolName: string;
  argumentsPreview: Record<string, unknown>;
  policyVersion: string;
  expiresAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  errorMessage: string | null;
  resultEvent: McpToolEvent | null;
  resultContent: string | null;
  createdAt: string;
};

type ApprovalQueryResult<T> = Promise<{ rows: T[] }>;
type ApprovalClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): ApprovalQueryResult<T>;
  release(): void;
};
export type McpApprovalPool = {
  connect(): Promise<ApprovalClient>;
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): ApprovalQueryResult<T>;
};

const approvalPool = pool as unknown as McpApprovalPool;

export class McpApprovalError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "not_pending"
      | "expired"
      | "integrity_failed",
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "McpApprovalError";
  }
}

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalMcpArguments(
  args: Record<string, unknown>,
): string {
  return JSON.stringify(canonicalize(args));
}

export function mcpArgumentsHash(args: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(canonicalMcpArguments(args))
    .digest("hex");
}

function previewValue(value: unknown, key: string, depth: number): unknown {
  if (SENSITIVE_ARGUMENT_KEY_RE.test(key)) {
    throw new Error(
      `Docket cannot request approval because the '${key}' argument would be hidden from review.`,
    );
  }
  if (depth >= MAX_PREVIEW_DEPTH) {
    throw new Error(
      "Docket cannot request approval because this action is too deeply nested to review safely.",
    );
  }
  if (typeof value === "string") return value;
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => previewValue(child, "", depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [
          childKey,
          previewValue(child, childKey, depth + 1),
        ]),
    );
  }
  return String(value);
}

export function mcpArgumentsPreview(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return previewValue(args, "", 0) as Record<string, unknown>;
}

export function mcpApprovalRequestKey(input: {
  userId: string;
  connectorId: string;
  toolId: string;
  context: McpExecutionContext;
}): string {
  const callIdentity =
    input.context.toolCallId ??
    input.context.assistantRunId ??
    input.context.assistantMessageId ??
    crypto.randomUUID();
  return crypto
    .createHash("sha256")
    .update(
      [
        input.userId,
        input.connectorId,
        input.toolId,
        input.context.assistantRunId ?? "",
        input.context.assistantMessageId ?? "",
        callIdentity,
      ].join("\u0000"),
    )
    .digest("hex");
}

export function serializeMcpApproval(
  row: McpApprovalRow,
): McpApprovalSummary {
  return {
    id: row.id,
    status: row.status,
    actorEmail: row.actor_email,
    connectorName: row.connector_name,
    toolName: row.tool_name,
    openaiToolName: row.openai_tool_name,
    argumentsPreview: row.arguments_preview ?? {},
    policyVersion: row.policy_version,
    expiresAt: iso(row.expires_at)!,
    decidedAt: iso(row.decided_at),
    executedAt: iso(row.executed_at),
    errorMessage: row.error_message,
    resultEvent: row.result_event,
    resultContent: row.result_content,
    createdAt: iso(row.created_at)!,
  };
}

export async function createPendingMcpApproval(input: {
  userId: string;
  connector: ConnectorRow;
  tool: ToolCacheRow;
  args: Record<string, unknown>;
  context: McpExecutionContext;
  policyVersion: string;
  now?: Date;
  pool?: McpApprovalPool;
}): Promise<McpApprovalRow> {
  const db = input.pool ?? approvalPool;
  const now = input.now ?? new Date();
  const actorEmail = input.context.actorEmail?.trim();
  if (!actorEmail) {
    throw new Error(
      "Docket cannot request approval because the initiating user's actor email is unavailable.",
    );
  }
  const id = crypto.randomUUID();
  const canonicalArguments = canonicalMcpArguments(input.args);
  const encrypted = encryptString(canonicalArguments);
  const argumentsHash = mcpArgumentsHash(input.args);
  const requestKey = mcpApprovalRequestKey({
    userId: input.userId,
    connectorId: input.connector.id,
    toolId: input.tool.id,
    context: input.context,
  });
  const values: unknown[] = [
    id,
    requestKey,
    input.userId,
    input.connector.id,
    input.tool.id,
    input.connector.name,
    input.tool.tool_name,
    input.tool.openai_tool_name,
    encrypted.encrypted,
    encrypted.iv,
    encrypted.tag,
    argumentsHash,
    JSON.stringify(mcpArgumentsPreview(input.args)),
    input.policyVersion,
    input.context.chatId ?? null,
    input.context.assistantMessageId ?? null,
    input.context.assistantRunId ?? null,
    input.context.traceId ?? null,
    input.context.projectId ?? null,
    input.context.toolCallId ?? null,
    new Date(now.getTime() + MCP_APPROVAL_TTL_MS),
    now,
    actorEmail,
  ];
  const inserted = await db.query<McpApprovalRow>(
    `insert into user_mcp_tool_approvals (
       id, request_key, user_id, connector_id, tool_id, connector_name,
       tool_name, openai_tool_name, encrypted_arguments, arguments_iv,
       arguments_tag, arguments_hash, arguments_preview, policy_version,
       chat_id, assistant_message_id, assistant_run_id, trace_id, project_id,
       tool_call_id, expires_at, created_at, updated_at, actor_email
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
       $14, $15, $16, $17, $18, $19, $20, $21, $22, $22, $23
     )
     on conflict (request_key) do nothing
     returning *`,
    values,
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await db.query<McpApprovalRow>(
    `select *
       from user_mcp_tool_approvals
      where request_key = $1 and user_id = $2`,
    [requestKey, input.userId],
  );
  if (!existing.rows[0]) {
    throw new Error("Docket could not persist the required write approval.");
  }
  const row = existing.rows[0];
  const matchesExactCall =
    row.connector_id === input.connector.id &&
    row.tool_id === input.tool.id &&
    row.tool_name === input.tool.tool_name &&
    row.openai_tool_name === input.tool.openai_tool_name &&
    row.actor_email === actorEmail &&
    row.arguments_hash === argumentsHash &&
    row.policy_version === input.policyVersion;
  if (!matchesExactCall) {
    throw new Error(
      "Docket blocked this repeated tool call because it no longer matches the original approval request.",
    );
  }
  if (row.status !== "pending") {
    throw new Error(
      "This exact tool call already has a completed or in-progress approval decision and cannot be requested again.",
    );
  }
  return row;
}

export async function getMcpApprovalForUser(
  approvalId: string,
  userId: string,
  db: McpApprovalPool = approvalPool,
): Promise<McpApprovalRow | null> {
  await db.query(
    `update user_mcp_tool_approvals
        set status = 'indeterminate',
            executed_at = coalesce(executed_at, now()),
            error_message = 'Execution status is indeterminate because Docket did not receive a final completion record. Verify the action in PracticePanther before attempting it again.',
            updated_at = now()
      where id = $1 and user_id = $2 and status = 'executing'
        and updated_at <= now() - ($3::bigint * interval '1 millisecond')`,
    [approvalId, userId, MCP_APPROVAL_EXECUTION_STALE_MS],
  );
  await db.query(
    `update user_mcp_tool_approvals
        set status = 'expired', updated_at = now()
      where id = $1 and user_id = $2 and status = 'pending'
        and expires_at <= now()`,
    [approvalId, userId],
  );
  const result = await db.query<McpApprovalRow>(
    `select *
       from user_mcp_tool_approvals
      where id = $1 and user_id = $2`,
    [approvalId, userId],
  );
  return result.rows[0] ?? null;
}

function decryptApprovalArguments(
  row: McpApprovalRow,
): Record<string, unknown> | null {
  const text = decryptString(
    row.encrypted_arguments,
    row.arguments_iv,
    row.arguments_tag,
  );
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const args = parsed as Record<string, unknown>;
    const actualHash = mcpArgumentsHash(args);
    const expected = Buffer.from(row.arguments_hash, "hex");
    const actual = Buffer.from(actualHash, "hex");
    if (
      expected.length !== actual.length ||
      !crypto.timingSafeEqual(expected, actual)
    ) {
      return null;
    }
    return args;
  } catch {
    return null;
  }
}

export async function claimMcpApprovalForExecution(input: {
  approvalId: string;
  userId: string;
  pool?: McpApprovalPool;
}): Promise<{ row: McpApprovalRow; args: Record<string, unknown> }> {
  const db = input.pool ?? approvalPool;
  const client = await db.connect();
  let committed = false;
  try {
    await client.query("begin");
    const selected = await client.query<McpApprovalRow>(
      `select *
         from user_mcp_tool_approvals
        where id = $1 and user_id = $2
        for update`,
      [input.approvalId, input.userId],
    );
    const row = selected.rows[0];
    if (!row) {
      throw new McpApprovalError(
        "Approval request was not found.",
        "not_found",
        404,
      );
    }
    if (row.status !== "pending") {
      throw new McpApprovalError(
        "This approval request is no longer pending.",
        "not_pending",
        409,
      );
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(
        `update user_mcp_tool_approvals
            set status = 'expired', updated_at = now()
          where id = $1`,
        [row.id],
      );
      await client.query("commit");
      committed = true;
      throw new McpApprovalError(
        "This approval request has expired.",
        "expired",
        409,
      );
    }

    const args = decryptApprovalArguments(row);
    if (!args) {
      await client.query(
        `update user_mcp_tool_approvals
            set status = 'failed',
                error_message = 'Stored approval arguments failed integrity validation',
                updated_at = now()
          where id = $1`,
        [row.id],
      );
      await client.query("commit");
      committed = true;
      throw new McpApprovalError(
        "Docket blocked this approval because its stored arguments failed integrity validation.",
        "integrity_failed",
        409,
      );
    }

    const claimed = await client.query<McpApprovalRow>(
      `update user_mcp_tool_approvals
          set status = 'executing', decided_at = now(), updated_at = now()
        where id = $1 and status = 'pending'
        returning *`,
      [row.id],
    );
    if (!claimed.rows[0]) {
      throw new McpApprovalError(
        "This approval request is no longer pending.",
        "not_pending",
        409,
      );
    }
    await client.query("commit");
    committed = true;
    return { row: claimed.rows[0], args };
  } catch (error) {
    if (!committed) await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectMcpApproval(input: {
  approvalId: string;
  userId: string;
  pool?: McpApprovalPool;
}): Promise<McpApprovalRow> {
  const db = input.pool ?? approvalPool;
  const client = await db.connect();
  let committed = false;
  try {
    await client.query("begin");
    const selected = await client.query<McpApprovalRow>(
      `select *
         from user_mcp_tool_approvals
        where id = $1 and user_id = $2
        for update`,
      [input.approvalId, input.userId],
    );
    const row = selected.rows[0];
    if (!row) {
      throw new McpApprovalError(
        "Approval request was not found.",
        "not_found",
        404,
      );
    }
    if (row.status !== "pending") {
      throw new McpApprovalError(
        "This approval request is no longer pending.",
        "not_pending",
        409,
      );
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(
        `update user_mcp_tool_approvals
            set status = 'expired', updated_at = now()
          where id = $1`,
        [row.id],
      );
      await client.query("commit");
      committed = true;
      throw new McpApprovalError(
        "This approval request has expired.",
        "expired",
        409,
      );
    }
    const rejected = await client.query<McpApprovalRow>(
      `update user_mcp_tool_approvals
          set status = 'rejected', decided_at = now(), updated_at = now()
        where id = $1 and status = 'pending'
        returning *`,
      [row.id],
    );
    await client.query("commit");
    committed = true;
    return rejected.rows[0];
  } catch (error) {
    if (!committed) await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function finishMcpApproval(input: {
  approvalId: string;
  userId: string;
  status: "succeeded" | "failed" | "indeterminate";
  event?: McpToolEvent | null;
  resultContent?: string | null;
  errorMessage?: string | null;
  pool?: McpApprovalPool;
}): Promise<McpApprovalRow> {
  const db = input.pool ?? approvalPool;
  const result = await db.query<McpApprovalRow>(
    `update user_mcp_tool_approvals
        set status = $3,
            executed_at = now(),
            error_message = $4,
            result_event = $5::jsonb,
            result_content = $6,
            updated_at = now()
      where id = $1 and user_id = $2 and status = 'executing'
      returning *`,
    [
      input.approvalId,
      input.userId,
      input.status,
      input.errorMessage ?? null,
      input.event ? JSON.stringify(input.event) : null,
      input.resultContent ?? null,
    ],
  );
  if (!result.rows[0]) {
    throw new McpApprovalError(
      "This approval request is no longer executing.",
      "not_pending",
      409,
    );
  }
  return result.rows[0];
}
