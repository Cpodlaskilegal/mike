// Finds the one connector row of a user that serves a Docket Agent source.
//
// PracticePanther and Box are served by the rows Docket itself keeps for
// the user: the ones he connects on Docket's own connectors page and that
// Docket chat uses. Quo has a row of its own, made by provisioning.
//
// Every query filters on the user's id. A row is only ever returned to the
// user it belongs to.

import {
  DOCKET_AGENT_SOURCE_KEY,
  docketAgentSourceOf,
  hasDocketAgentMark,
  type DocketAgentMarkedSource,
} from "../mcp/agentSource";
import {
  backendManagedBy,
  boxMcpServerUrl,
  isPrimaryPracticePantherConnector,
} from "../mcp/defaults";
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
  quo: "Quo (Docket Agent)",
};

function allowedMarkedUrl(_source: DocketAgentMarkedSource): string | null {
  return agentQuoMcpUrl();
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

/**
 * PracticePanther uses the row Docket keeps for this user, and only while
 * that row is the per-user connector: the one each user signs in to as
 * himself (auth type "oauth", at the per-user server Docket is configured
 * with). A user who connected PracticePanther in Docket needs nothing more.
 *
 * Never the old shared connector (one identity for the whole firm, auth
 * type "none"): with Docket still on it the source is off, and a row that
 * points at it is not looked at.
 */
async function resolvePracticePantherConnector(
  userId: string,
  db: Db,
): Promise<ResolvedConnector> {
  const allowedUrl = agentPracticePantherMcpUrl();
  if (!allowedUrl) return { ok: false, detail: "source_disabled" };

  const { data, error } = await db
    .from("user_mcp_connectors")
    .select("*")
    .eq("user_id", userId)
    .eq("server_url", allowedUrl)
    .order("created_at", { ascending: true });
  if (error) throw new Error("Connector lookup failed.");
  // Check again in code. Never trust the query alone for ownership.
  const row = ((data ?? []) as ConnectorRow[]).find(
    (candidate) =>
      candidate.user_id === userId &&
      candidate.server_url === allowedUrl &&
      !hasDocketAgentMark(candidate.tool_policy),
  );
  if (!row) return { ok: false, detail: "no_connector" };
  if (
    isLegacySharedPracticePantherUrl(row.server_url) ||
    backendManagedBy(row) !== "practicepanther"
  ) {
    return { ok: false, detail: "wrong_server" };
  }
  if (row.auth_type !== "oauth") {
    return { ok: false, detail: "wrong_auth_type" };
  }
  // Docket's own test for "this is the per-user connector, not a retired one".
  if (!isPrimaryPracticePantherConnector(row)) {
    return { ok: false, detail: "wrong_server" };
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
      !hasDocketAgentMark(candidate.tool_policy),
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
  if (source === "practicepanther") {
    return resolvePracticePantherConnector(userId, db);
  }
  if (source === "quo") return resolveMarkedConnector(userId, source, db);
  return { ok: false, detail: "source_disabled" };
}

export type ProvisionedConnector =
  // PracticePanther and Box: Docket's own rows. Provisioning makes nothing.
  | "managed" // the user's row exists
  | "missing" // the user has no such row yet (he has not opened Docket since)
  | "disabled" // the source is off on this backend
  // Quo: a row of its own.
  | "created" // a new marked row was made
  | "unchanged" // the marked row was already right
  | "repointed" // the marked row pointed elsewhere; it now needs a new sign-in
  | "not_configured"; // Quo is off on this backend

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
 * Removes the caller's own PracticePanther sign-in from Docket. The row and
 * its tool list stay, so he can connect again. This is how a sign-in made
 * with the wrong PracticePanther account is cleared, and how a user takes
 * PracticePanther away from Docket (Docket chat and Docket Agent alike:
 * they use the same sign-in).
 *
 * Only the per-user PracticePanther connector, and only the caller's own
 * row. `withSignInLock` keeps a refresh that is under way from writing the
 * sign-in back after it was removed.
 */
export async function disconnectPracticePantherSignIn(
  userId: string,
  connectorId: string,
  db: Db,
  withSignInLock: <T>(connectorId: string, run: () => Promise<T>) => Promise<T>,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_practicepanther" }> {
  const { data, error } = await db
    .from("user_mcp_connectors")
    .select("*")
    .eq("user_id", userId)
    .eq("id", connectorId)
    .maybeSingle();
  if (error) throw new Error("Connector lookup failed.");
  const row = data as ConnectorRow | null;
  if (!row || row.user_id !== userId) return { ok: false, reason: "not_found" };
  if (
    !isPrimaryPracticePantherConnector(row) ||
    row.auth_type !== "oauth" ||
    hasDocketAgentMark(row.tool_policy)
  ) {
    return { ok: false, reason: "not_practicepanther" };
  }
  await withSignInLock(row.id, async () => {
    const { error: tokenError } = await db
      .from("user_mcp_oauth_tokens")
      .delete()
      .eq("connector_id", row.id);
    if (tokenError) throw new Error("Sign-in could not be removed.");
  });
  return { ok: true };
}

/** Docket's own row for the source: is it there. Nothing is created. */
function reportManagedConnector(
  resolved: ResolvedConnector,
): ProvisionedConnector {
  if (resolved.ok) return "managed";
  if (resolved.detail === "source_disabled") return "disabled";
  return resolved.detail === "no_connector" ? "missing" : "managed";
}

/**
 * Says which connector rows the agent sources will use, and makes the one
 * row that is the gateway's own (Quo, when Quo is configured). It connects
 * nothing, creates nothing for PracticePanther or Box, never edits a row
 * without the mark, and never changes `enabled` on any row. Calling it
 * again changes nothing.
 */
export async function provisionAgentConnectors(
  userId: string,
  db: Db,
  validateServerUrl: (url: string) => Promise<string>,
): Promise<Record<AgentSource, ProvisionedConnector>> {
  return {
    practicepanther: reportManagedConnector(
      await resolvePracticePantherConnector(userId, db),
    ),
    box: reportManagedConnector(await resolveBoxConnector(userId, db)),
    quo: await provisionMarkedConnector(userId, "quo", db, validateServerUrl),
  };
}
