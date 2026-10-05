// Builds the ops status answer: which Docket users Docket Agent can act for,
// and whether each of their sources is connected. With keep-alive it also
// refreshes sign-ins that are near expiry before reporting, and says which
// account is signed in behind each connected source.
//
// Only users on DOCKET_AGENT_ALLOWED_EMAILS are ever found or reported.

import { boxMcpServerUrl } from "../mcp/defaults";
import { normalizeDocketActorEmail } from "../mcp/practicePantherAttribution";
import type { Db } from "../mcp/types";
import { normalizeUserRole, type AppUserRole } from "../userRoles";
import { agentBoxFilesStatus } from "./boxFiles";
import {
  AGENT_SOURCES,
  agentBoxOrganizeEnabled,
  agentEmailDomain,
  agentPracticePantherWritesEnabled,
  isAgentEmailAllowed,
  type AgentSource,
} from "./config";
import type { AgentGatewayDeps } from "./deps";
import { readSignedInIdentity, type AgentSourceIdentity } from "./identity";
import { resolveAgentConnector, type ConnectorResolveFailure } from "./sources";
import {
  ensureUpstreamSignIn,
  KEEPALIVE_REFRESH_SKEW_MS,
} from "./upstreamAuth";

export const MAX_STATUS_EMAILS = 50;

type SignInDeps = Pick<
  AgentGatewayDeps,
  "refreshUpstreamToken" | "withRefreshLock" | "now" | "withUpstreamClient"
>;

type StatusOptions = {
  refresh: "never" | "if_near_expiry";
  skewMs: number;
  /** Also ask each connected source which account is signed in. */
  identity?: boolean;
};

export type AgentSourceStatus =
  | {
      state: "connected";
      /**
       * Only with keep-alive. Who is signed in behind the connection, or
       * null when the source could not say. Docket checks who owns a
       * connector row, not who signed in to it; the caller compares this
       * with the account it expects.
       */
      identity?: AgentSourceIdentity | null;
    }
  | {
      state: "not_connected" | "needs_reconnect";
      detail:
        | ConnectorResolveFailure
        | "never_connected"
        | "token_missing"
        | "expired_no_refresh_token"
        | "refresh_failed";
    };

export type AgentUser = { id: string; email: string; role: AppUserRole };

export type AgentUserLookupError =
  | "invalid_email"
  | "email_domain_not_allowed"
  | "email_not_allowed"
  | "unknown_user"
  | "ambiguous_user";

export type AgentUserLookup =
  | { ok: true; user: AgentUser }
  | { ok: false; error: AgentUserLookupError };

const LOOKUP_ERROR_STATUS: Record<AgentUserLookupError, number> = {
  invalid_email: 400,
  email_domain_not_allowed: 400,
  email_not_allowed: 403,
  unknown_user: 404,
  ambiguous_user: 409,
};

export function agentUserLookupStatus(error: AgentUserLookupError): number {
  return LOOKUP_ERROR_STATUS[error];
}

type AppUserRow = {
  id?: unknown;
  email?: unknown;
  role?: unknown;
  docket_data_status?: unknown;
};

/**
 * An active Docket user with a usable role and email, who is on the list
 * of users Docket Agent may act for, or null.
 */
function toAgentUser(row: AppUserRow): AgentUser | null {
  if (typeof row.id !== "string" || row.docket_data_status !== "active") {
    return null;
  }
  const role = normalizeUserRole(row.role);
  const email = normalizeDocketActorEmail(row.email);
  if (!role || !email || !isAgentEmailAllowed(email)) return null;
  return { id: row.id, email, role };
}

/**
 * Finds the one active Docket user with this firm email. The address must
 * be on DOCKET_AGENT_ALLOWED_EMAILS: without that, one ops token could
 * mint an agent token for any user of Docket, a partner or an admin
 * included, and read that user's Box.
 */
export async function findAgentUserByEmail(
  rawEmail: unknown,
  db: Db,
): Promise<AgentUserLookup> {
  const email = normalizeDocketActorEmail(rawEmail);
  if (!email) return { ok: false, error: "invalid_email" };
  if (email.slice(email.lastIndexOf("@") + 1) !== agentEmailDomain()) {
    return { ok: false, error: "email_domain_not_allowed" };
  }
  if (!isAgentEmailAllowed(email)) {
    return { ok: false, error: "email_not_allowed" };
  }
  const { data, error } = await db
    .from("app_users")
    .select("id, email, role, docket_data_status")
    .eq("email", email);
  if (error) throw new Error("User lookup failed.");
  const users = ((data ?? []) as AppUserRow[])
    .map(toAgentUser)
    .filter((user): user is AgentUser => user !== null);
  // app_users.email has no unique rule, so two rows are possible.
  if (users.length === 0) return { ok: false, error: "unknown_user" };
  if (users.length > 1) return { ok: false, error: "ambiguous_user" };
  return { ok: true, user: users[0] };
}

/** The state of one source for one user. */
export async function agentSourceStatus(
  userId: string,
  source: AgentSource,
  db: Db,
  options: StatusOptions,
  deps: SignInDeps,
): Promise<AgentSourceStatus> {
  const resolved = await resolveAgentConnector(userId, source, db);
  if (!resolved.ok) return { state: "not_connected", detail: resolved.detail };
  const signIn = await ensureUpstreamSignIn(
    resolved.connector,
    db,
    options,
    deps,
  );
  if (signIn.state !== "connected" || !options.identity) return signIn;
  const identity = await readSignedInIdentity(
    resolved.connector,
    source,
    db,
    deps,
  );
  // A source with no identity check (Quo) reports no identity field at all.
  return identity === undefined ? signIn : { state: "connected", identity };
}

export async function agentSourceStatuses(
  userId: string,
  db: Db,
  options: StatusOptions,
  deps: SignInDeps,
): Promise<Record<AgentSource, AgentSourceStatus>> {
  const sources = {} as Record<AgentSource, AgentSourceStatus>;
  // One at a time, so a keep-alive never refreshes two sign-ins at once.
  for (const source of AGENT_SOURCES) {
    sources[source] = await agentSourceStatus(userId, source, db, options, deps);
  }
  return sources;
}

async function liveTokenUserIds(db: Db): Promise<Set<string>> {
  const { data, error } = await db
    .from("docket_agent_tokens")
    .select("user_id")
    .is("revoked_at", null);
  if (error) throw new Error("Agent token listing failed.");
  return new Set(
    ((data ?? []) as Array<{ user_id?: unknown }>)
      .map((row) => row.user_id)
      .filter((id): id is string => typeof id === "string"),
  );
}

export type AgentStatusAnswer = {
  users: Array<{
    email: string;
    agent_enabled: boolean;
    role: AppUserRole;
    sources: Record<AgentSource, AgentSourceStatus>;
  }>;
  problems: Array<{ email: string; error: AgentUserLookupError }>;
  practicepanther_writes: "on" | "off";
  /** The Box file routes: can bytes be fetched, and is the upload switch on. */
  box_files: { download: boolean; upload: boolean };
  /** The Box organize switch: may a session move, rename and make folders. */
  box_organize: "on" | "off";
};

/** The "box_organize" part of the status answer. */
export function agentBoxOrganizeStatus(): "on" | "off" {
  // Box is one switch for the whole backend. With it off there is no Box
  // sign-in to use, so nothing can be organized either.
  return boxMcpServerUrl() !== null && agentBoxOrganizeEnabled() ? "on" : "off";
}

/**
 * Every active user with a live agent token, plus every active user named in
 * `emails`. One bad email does not fail the call; it goes in `problems`.
 */
export async function buildAgentStatus(input: {
  emails: string[];
  keepalive: boolean;
  db: Db;
  deps: SignInDeps;
}): Promise<AgentStatusAnswer> {
  const { db, deps } = input;
  const enabledIds = await liveTokenUserIds(db);
  const users = new Map<string, AgentUser>();

  if (enabledIds.size) {
    const { data, error } = await db
      .from("app_users")
      .select("id, email, role, docket_data_status")
      .in("id", [...enabledIds]);
    if (error) throw new Error("User lookup failed.");
    for (const row of (data ?? []) as AppUserRow[]) {
      const user = toAgentUser(row);
      if (user) users.set(user.id, user);
    }
  }

  const problems: AgentStatusAnswer["problems"] = [];
  for (const rawEmail of input.emails) {
    const lookup = await findAgentUserByEmail(rawEmail, db);
    if (lookup.ok) {
      users.set(lookup.user.id, lookup.user);
    } else {
      // Echo only an email that passed the shape check. Never raw input.
      problems.push({
        email: normalizeDocketActorEmail(rawEmail) ?? "",
        error: lookup.error,
      });
    }
  }

  const options: StatusOptions = input.keepalive
    ? {
        refresh: "if_near_expiry",
        skewMs: KEEPALIVE_REFRESH_SKEW_MS,
        identity: true,
      }
    : { refresh: "never", skewMs: 0 };

  const answer: AgentStatusAnswer["users"] = [];
  const ordered = [...users.values()].sort((a, b) =>
    a.email.localeCompare(b.email),
  );
  for (const user of ordered) {
    answer.push({
      email: user.email,
      agent_enabled: enabledIds.has(user.id),
      role: user.role,
      sources: await agentSourceStatuses(user.id, db, options, deps),
    });
  }

  return {
    users: answer,
    problems,
    practicepanther_writes: agentPracticePantherWritesEnabled() ? "on" : "off",
    box_files: agentBoxFilesStatus(),
    box_organize: agentBoxOrganizeStatus(),
  };
}
