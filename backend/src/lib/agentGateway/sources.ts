// Finds the one connector row of a user that serves a Docket Agent source,
// and creates the rows that need creating (provisioning).
//
// Every query filters on the user's id. A row is only ever returned to the
// user it belongs to.

import {
  DOCKET_AGENT_SOURCE_KEY,
  docketAgentSourceOf,
  type DocketAgentMarkedSource,
} from "../mcp/agentSource";
import { backendManagedBy, boxMcpServerUrl } from "../mcp/defaults";
import type { ConnectorRow, Db } from "../mcp/types";
import {
  agentPracticePantherMcpUrl,
  agentQuoMcpUrl,
  isLegacySharedPracticePantherUrl,
  normalizeAgentUrl,
  type AgentSource,
} from "./config";

export type ConnectorResolveFailure =
  | "source_disabled" // the source is not configured on this backend
  | "no_connector" // the user has no row for it
  | "wrong_server" // the row does not point at the allowed server
  | "wrong_auth_type"; // the row is not an OAuth connector

export type ResolvedConnector =
  | { ok: true; connector: ConnectorRow }
  | { ok: false; detail: ConnectorResolveFailure };

const MARKED_CONNECTOR_NAMES: Record<DocketAgentMarkedSource, string> = {
  practicepanther: "PracticePanther (Docket Agent)",
  quo: "Quo (Docket Agent)",
};

function allowedMarkedUrl(source: DocketAgentMarkedSource): string | null {
  return source === "practicepanther"
    ? agentPracticePantherMcpUrl()
    : agentQuoMcpUrl();
}

/** The user's rows that carry the mark for this source (normally 0 or 1). */
async function loadMarkedRows(
  userId: string,
  source: DocketAgentMarkedSource,
  db: Db,
): Promise<ConnectorRow[]> {
  const { data, error } = await db
    .from("user_mcp_connectors")
    .select("*")
    .eq("user_id", userId)
    .contains("tool_policy", { [DOCKET_AGENT_SOURCE_KEY]: source })
    .limit(2);
  if (error) throw new Error("Connector lookup failed.");
  // Check again in code. Never trust the query alone for ownership.
  return ((data ?? []) as ConnectorRow[]).filter(
    (row) =>
      row.user_id === userId && docketAgentSourceOf(row.tool_policy) === source,
  );
}

async function resolveMarkedConnector(
  userId: string,
  source: DocketAgentMarkedSource,
  db: Db,
): Promise<ResolvedConnector> {
  const allowedUrl = allowedMarkedUrl(source);
  if (!allowedUrl) return { ok: false, detail: "source_disabled" };

  const rows = await loadMarkedRows(userId, source, db);
  // More than one marked row cannot happen with the unique index. Fail closed.
  if (rows.length !== 1) return { ok: false, detail: "no_connector" };
  const row = rows[0];

  if (normalizeAgentUrl(row.server_url) !== allowedUrl) {
    return { ok: false, detail: "wrong_server" };
  }
  // Never the old shared connector, and never a row Docket chat manages.
  if (
    isLegacySharedPracticePantherUrl(row.server_url) ||
    backendManagedBy(row) !== null
  ) {
    return { ok: false, detail: "wrong_server" };
  }
  if (row.auth_type !== "oauth") {
    return { ok: false, detail: "wrong_auth_type" };
  }
  return { ok: true, connector: row };
}

/** Box uses the row Docket chat already manages for this user. */
async function resolveBoxConnector(
  userId: string,
  db: Db,
): Promise<ResolvedConnector> {
  const allowedUrl = boxMcpServerUrl();
  if (!allowedUrl) return { ok: false, detail: "source_disabled" };

  const { data, error } = await db
    .from("user_mcp_connectors")
    .select("*")
    .eq("user_id", userId)
    .eq("server_url", allowedUrl)
    .order("created_at", { ascending: true });
  if (error) throw new Error("Connector lookup failed.");
  const row = ((data ?? []) as ConnectorRow[]).find(
    (candidate) =>
      candidate.user_id === userId &&
      candidate.server_url === allowedUrl &&
      backendManagedBy(candidate) === "box" &&
      docketAgentSourceOf(candidate.tool_policy) === null,
  );
  if (!row) return { ok: false, detail: "no_connector" };
  if (row.auth_type !== "oauth") {
    return { ok: false, detail: "wrong_auth_type" };
  }
  return { ok: true, connector: row };
}

export async function resolveAgentConnector(
  userId: string,
  source: AgentSource,
  db: Db,
): Promise<ResolvedConnector> {
  if (source === "box") return resolveBoxConnector(userId, db);
  if (source === "practicepanther" || source === "quo") {
    return resolveMarkedConnector(userId, source, db);
  }
  return { ok: false, detail: "source_disabled" };
}

export type ProvisionedConnector =
  | "created" // a new marked row was made
  | "unchanged" // the marked row was already right
  | "repointed" // the marked row pointed elsewhere; it now needs a new sign-in
  | "not_configured" // the source is off on this backend
  | "managed" // Box: the user's managed Box row exists
  | "missing" // Box: the user has no managed Box row yet
  | "disabled"; // Box: Box is off on this backend

async function provisionMarkedConnector(
  userId: string,
  source: DocketAgentMarkedSource,
  db: Db,
  validateServerUrl: (url: string) => Promise<string>,
): Promise<ProvisionedConnector> {
  const allowedUrl = allowedMarkedUrl(source);
  if (!allowedUrl) return "not_configured";

  const existing = (await loadMarkedRows(userId, source, db))[0];
  if (!existing) {
    const serverUrl = await validateServerUrl(allowedUrl);
    const { error } = await db
      .from("user_mcp_connectors")
      .insert({
        user_id: userId,
        name: MARKED_CONNECTOR_NAMES[source],
        transport: "streamable_http",
        server_url: serverUrl,
        auth_type: "oauth",
        // Never offered to Docket chat. Chat only loads enabled rows.
        enabled: false,
        tool_policy: { [DOCKET_AGENT_SOURCE_KEY]: source },
        encrypted_auth_config: null,
        auth_config_iv: null,
        auth_config_tag: null,
      })
      .select("id")
      .single();
    if (!error) return "created";
    // Two calls at once: the other one made the row. That is fine.
    if ((await loadMarkedRows(userId, source, db)).length) return "unchanged";
    throw new Error("Connector row could not be created.");
  }

  if (normalizeAgentUrl(existing.server_url) === allowedUrl) return "unchanged";

  // The allowed server changed. Point the row at it and drop the old
  // sign-in and tool list. This row is agent-only, so chat is not affected.
  const serverUrl = await validateServerUrl(allowedUrl);
  const { error: updateError } = await db
    .from("user_mcp_connectors")
    .update({ server_url: serverUrl, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", existing.id);
  if (updateError) throw new Error("Connector row could not be updated.");
  const { error: tokenError } = await db
    .from("user_mcp_oauth_tokens")
    .delete()
    .eq("connector_id", existing.id);
  if (tokenError) throw new Error("Old sign-in could not be cleared.");
  const { error: toolError } = await db
    .from("user_mcp_connector_tools")
    .delete()
    .eq("connector_id", existing.id);
  if (toolError) throw new Error("Old tool list could not be cleared.");
  return "repointed";
}

/**
 * Removes the stored sign-in (and the tool list read with it) from one of
 * the user's own Docket Agent connector rows. The row stays, so he can
 * click Connect again. This is how a user takes a source away from Docket
 * Agent, and how a sign-in made with the wrong account is cleared.
 *
 * Only a row that carries the Docket Agent mark, and only the caller's
 * own. Box is not such a row: it is the one Docket chat uses.
 */
export async function disconnectAgentConnector(
  userId: string,
  connectorId: string,
  db: Db,
): Promise<
  | { ok: true; source: DocketAgentMarkedSource }
  | { ok: false; reason: "not_found" | "not_agent_connector" }
> {
  const { data, error } = await db
    .from("user_mcp_connectors")
    .select("*")
    .eq("user_id", userId)
    .eq("id", connectorId)
    .maybeSingle();
  if (error) throw new Error("Connector lookup failed.");
  const row = data as ConnectorRow | null;
  if (!row || row.user_id !== userId) return { ok: false, reason: "not_found" };
  const source = docketAgentSourceOf(row.tool_policy);
  if (!source || backendManagedBy(row) !== null) {
    return { ok: false, reason: "not_agent_connector" };
  }
  const { error: tokenError } = await db
    .from("user_mcp_oauth_tokens")
    .delete()
    .eq("connector_id", row.id);
  if (tokenError) throw new Error("Sign-in could not be removed.");
  const { error: toolError } = await db
    .from("user_mcp_connector_tools")
    .delete()
    .eq("connector_id", row.id);
  if (toolError) throw new Error("Tool list could not be cleared.");
  return { ok: true, source };
}

async function provisionBoxConnector(
  userId: string,
  db: Db,
): Promise<ProvisionedConnector> {
  if (!boxMcpServerUrl()) return "disabled";
  const resolved = await resolveBoxConnector(userId, db);
  if (resolved.ok) return "managed";
  return resolved.detail === "no_connector" ? "missing" : "managed";
}

/**
 * Makes sure the user has the connector rows the agent sources need. It
 * connects nothing, never edits a row without the mark, and never changes
 * `enabled` on any row. Calling it again changes nothing.
 */
export async function provisionAgentConnectors(
  userId: string,
  db: Db,
  validateServerUrl: (url: string) => Promise<string>,
): Promise<Record<AgentSource, ProvisionedConnector>> {
  return {
    practicepanther: await provisionMarkedConnector(
      userId,
      "practicepanther",
      db,
      validateServerUrl,
    ),
    box: await provisionBoxConnector(userId, db),
    quo: await provisionMarkedConnector(userId, "quo", db, validateServerUrl),
  };
}
