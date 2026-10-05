// Which account is signed in behind a user's connection.
//
// The gateway checks who OWNS a connector row. It cannot see who signed in
// to it: a user who reconnects on a shared computer, or forwards the
// sign-in link, can leave another person's PracticePanther or Box account
// behind his own row. So the status answer (with keep-alive) asks the
// source itself, and the Docket Agent Poller compares the answer with the
// account it expects before it starts a session.
//
// Nothing here decides anything. It only reports. Any failure reports null.

import type { ConnectorRow, Db } from "../mcp/types";
import { safeErrorLog } from "../safeError";
import type { AgentSource } from "./config";
import type { AgentGatewayDeps } from "./deps";

export type AgentSourceIdentity = { user_id: string } | { login: string };

const IDENTITY_TIMEOUT_MS = 20_000;
const MAX_IDENTITY_LENGTH = 320;

/** The tool that says who is signed in, and the field that holds it. */
const IDENTITY_TOOLS: Partial<
  Record<AgentSource, { tool: string; field: "user_id" | "login" }>
> = {
  practicepanther: { tool: "pp_oauth_status", field: "user_id" },
  box: { tool: "who_am_i", field: "login" },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The JSON object a tool answered with, or null. */
function resultObject(result: unknown): Record<string, unknown> | null {
  if (!isPlainObject(result) || result.isError === true) return null;
  let data: unknown = result.structuredContent;
  if (!isPlainObject(data) && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!isPlainObject(block) || block.type !== "text") continue;
      try {
        const parsed: unknown = JSON.parse(String(block.text ?? ""));
        if (isPlainObject(parsed)) {
          data = parsed;
          break;
        }
      } catch {
        // Not JSON: look at the next block.
      }
    }
  }
  if (!isPlainObject(data)) return null;
  // Some servers wrap a plain return value as {"result": {...}}.
  const keys = Object.keys(data);
  if (keys.length === 1 && keys[0] === "result" && isPlainObject(data.result)) {
    return data.result;
  }
  return data;
}

function identityValue(
  data: Record<string, unknown>,
  field: string,
): string | null {
  // Box may nest the account under "user".
  const holder = isPlainObject(data.user) && !(field in data) ? data.user : data;
  const value = holder[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_IDENTITY_LENGTH ? trimmed : null;
}

/**
 * Asks the source who is signed in behind this connector.
 *   undefined  this source has no identity check
 *   null       it has one, and the answer could not be read
 */
export async function readSignedInIdentity(
  connector: ConnectorRow,
  source: AgentSource,
  db: Db,
  deps: Pick<AgentGatewayDeps, "withUpstreamClient">,
): Promise<AgentSourceIdentity | null | undefined> {
  const spec = IDENTITY_TOOLS[source];
  if (!spec) return undefined;
  try {
    const result = await deps.withUpstreamClient(
      connector,
      (client) =>
        client.callTool({ name: spec.tool, arguments: {} }, undefined, {
          timeout: IDENTITY_TIMEOUT_MS,
          maxTotalTimeout: IDENTITY_TIMEOUT_MS,
        }),
      db,
    );
    const data = resultObject(result);
    const value = data ? identityValue(data, spec.field) : null;
    if (!value) return null;
    return spec.field === "user_id" ? { user_id: value } : { login: value };
  } catch (err) {
    console.warn("[agent-gateway] signed-in account could not be read", {
      userId: connector.user_id,
      connectorId: connector.id,
      source,
      error: safeErrorLog(err),
    });
    return null;
  }
}
