// Agent tokens and the ops token for the Docket Agent gateway.
//
// An agent token belongs to one Docket user. Only its SHA-256 hash is stored.
// The token itself is returned once, when it is minted, and never again.
//
// A user's enrolment holds two tokens, each with one reach (its scope):
// - "mcp" (dka_...): the MCP endpoints /agent-mcp/{source}. Nothing else.
// - "box_files" (dkf_...): the Box file routes /agent-mcp/box/files.
//   Nothing else. This is the one a session's sandbox holds, so it must be
//   useless for anything but fetching and filing that user's Box files.
// Both hashes sit on the same row, so one rotation or one revocation ends
// both at the same instant and neither can outlive the other.

import crypto from "crypto";
import { base64Url } from "../mcp/client";
import { normalizeDocketActorEmail } from "../mcp/practicePantherAttribution";
import type { Db } from "../mcp/types";
import { safeErrorLog } from "../safeError";
import { normalizeUserRole, type AppUserRole } from "../userRoles";
import { agentOpsToken, agentStatusToken, isAgentEmailAllowed } from "./config";

const AGENT_TOKEN_PREFIX = "dka_";
const AGENT_TOKEN_SHAPE = /^dka_[A-Za-z0-9_-]{43}$/;
const AGENT_FILE_TOKEN_PREFIX = "dkf_";
const AGENT_FILE_TOKEN_SHAPE = /^dkf_[A-Za-z0-9_-]{43}$/;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** What a token can reach. Told from its prefix; checked against its own column. */
export type AgentTokenScope = "mcp" | "box_files";

/** The database column that holds the hash of a token of this scope. */
const TOKEN_HASH_COLUMNS: Record<AgentTokenScope, string> = {
  mcp: "token_hash",
  box_files: "file_token_hash",
};

export type AgentPrincipal = {
  tokenId: string;
  userId: string;
  email: string; // lower case, from app_users.email
  role: AppUserRole; // "user" | "admin"
};

/** Minting failed after the old token was revoked. The user has no live token. */
export class AgentTokenRotationConflictError extends Error {
  constructor() {
    super("Agent token rotation conflict.");
    this.name = "AgentTokenRotationConflictError";
  }
}

export function generateAgentToken(): string {
  return `${AGENT_TOKEN_PREFIX}${base64Url(crypto.randomBytes(32))}`;
}

export function hashAgentToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function looksLikeAgentToken(value: string): boolean {
  return typeof value === "string" && AGENT_TOKEN_SHAPE.test(value);
}

export function generateAgentFileToken(): string {
  return `${AGENT_FILE_TOKEN_PREFIX}${base64Url(crypto.randomBytes(32))}`;
}

export function looksLikeAgentFileToken(value: string): boolean {
  return typeof value === "string" && AGENT_FILE_TOKEN_SHAPE.test(value);
}

/**
 * The scope a bearer claims by its shape, or null when it has the shape of
 * neither token. It says nothing about whether the token is live.
 */
export function agentTokenScopeOf(value: string): AgentTokenScope | null {
  if (looksLikeAgentToken(value)) return "mcp";
  if (looksLikeAgentFileToken(value)) return "box_files";
  return null;
}

/**
 * Who a bearer belongs to. null means "401". Never throws for a bad token.
 * It does throw when the database cannot be read, so that shows as a 500
 * and not as a wrong token.
 *
 * `scope` is the reach the caller's route needs. A token of the other
 * scope is null here without a lookup: its hash is only ever compared with
 * its own column, so a file token can never pass as an MCP token or the
 * other way round.
 */
export async function authenticateAgentToken(
  bearer: string,
  db: Db,
  scope: AgentTokenScope = "mcp",
): Promise<AgentPrincipal | null> {
  if (agentTokenScopeOf(bearer) !== scope) return null;

  const { data: tokenRow, error: tokenError } = await db
    .from("docket_agent_tokens")
    .select("id, user_id")
    .eq(TOKEN_HASH_COLUMNS[scope], hashAgentToken(bearer))
    .is("revoked_at", null)
    .maybeSingle();
  if (tokenError) throw new Error("Agent token lookup failed.");
  if (!tokenRow) return null;
  const token = tokenRow as { id?: unknown; user_id?: unknown };
  if (typeof token.id !== "string" || typeof token.user_id !== "string") {
    return null;
  }

  const { data: userRow, error: userError } = await db
    .from("app_users")
    .select("id, email, role, docket_data_status")
    .eq("id", token.user_id)
    .maybeSingle();
  if (userError) throw new Error("Agent user lookup failed.");
  if (!userRow) return null;
  const user = userRow as {
    id?: unknown;
    email?: unknown;
    role?: unknown;
    docket_data_status?: unknown;
  };
  if (user.id !== token.user_id) return null;
  if (user.docket_data_status !== "active") return null;
  // Never default to a role. A missing or odd role makes the token invalid.
  const role = normalizeUserRole(user.role);
  const email = normalizeDocketActorEmail(user.email);
  if (!role || !email) return null;
  // Checked on every use, not only when the token was minted: taking a
  // user off DOCKET_AGENT_ALLOWED_EMAILS cuts his token off at once.
  if (!isAgentEmailAllowed(email)) return null;

  return { tokenId: token.id, userId: token.user_id, email, role };
}

/**
 * Revokes any live tokens of the user, then stores a new pair: the MCP
 * token and the Box file token. One row holds both hashes.
 */
export async function mintAgentToken(
  userId: string,
  db: Db,
): Promise<{ token: string; fileToken: string; createdAt: string }> {
  await revokeAgentTokens(userId, db);

  const token = generateAgentToken();
  const fileToken = generateAgentFileToken();
  const { data, error } = await db
    .from("docket_agent_tokens")
    .insert({
      user_id: userId,
      token_hash: hashAgentToken(token),
      file_token_hash: hashAgentToken(fileToken),
    })
    .select("id, created_at")
    .single();
  if (error || !data) throw new AgentTokenRotationConflictError();

  const createdAt = (data as { created_at?: unknown }).created_at;
  const created = new Date(
    createdAt instanceof Date || typeof createdAt === "string"
      ? createdAt
      : Date.now(),
  );
  return {
    token,
    fileToken,
    createdAt: (Number.isNaN(created.getTime())
      ? new Date()
      : created
    ).toISOString(),
  };
}

/**
 * Returns how many live enrolments were revoked (0 or 1). Revoking the row
 * ends the MCP token and the Box file token together.
 */
export async function revokeAgentTokens(userId: string, db: Db): Promise<number> {
  const { data, error } = await db
    .from("docket_agent_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw new Error("Agent token revocation failed.");
  return Array.isArray(data) ? data.length : 0;
}

const lastUsedWrites = new Map<string, number>();

/**
 * Records that a token was used. At most one write a minute per token in
 * this process. Never awaited by the caller and never fails a request.
 */
export function touchAgentTokenLastUsed(
  tokenId: string,
  db: Db,
  nowMs: number,
): void {
  const last = lastUsedWrites.get(tokenId);
  if (last !== undefined && nowMs - last < LAST_USED_WRITE_INTERVAL_MS) return;
  lastUsedWrites.set(tokenId, nowMs);
  void (async () => {
    try {
      const { error } = await db
        .from("docket_agent_tokens")
        .update({ last_used_at: new Date(nowMs).toISOString() })
        .eq("id", tokenId);
      if (error) throw new Error("last_used_at write failed");
    } catch (err) {
      console.warn("[agent-gateway] could not record token use", {
        tokenId,
        error: safeErrorLog(err),
      });
    }
  })();
}

function sameSecret(presented: string, expected: string | null): boolean {
  if (!expected) return false;
  const a = crypto.createHash("sha256").update(String(presented)).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Constant-time check of the ops token. False when the gateway is off. */
export function opsTokenMatches(presented: string): boolean {
  return sameSecret(presented, agentOpsToken()); // null when disabled
}

/**
 * Constant-time check of the status token. False when none is set, and
 * false when the gateway is off. It only ever opens the status route.
 */
export function statusTokenMatches(presented: string): boolean {
  if (!agentOpsToken()) return false;
  return sameSecret(presented, agentStatusToken());
}
