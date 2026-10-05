// Is the user's stored upstream sign-in usable, and refreshing it safely.
//
// Refresh tokens of the per-user PracticePanther connector and of Box are
// single-use. Two refreshes at once would end with one of them deleting the
// user's sign-in. So the gateway refreshes early, and one at a time.

import { auth as runMcpOAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Pool } from "pg";
import { guardedFetch, mcpOAuthCallbackUrl } from "../mcp/client";
import {
  DbMcpOAuthProvider,
  loadOAuthToken,
  McpOAuthRequiredError,
} from "../mcp/oauth";
import type { ConnectorRow, Db, OAuthTokenRow } from "../mcp/types";
import { safeErrorLog } from "../safeError";
import type { AgentGatewayDeps } from "./deps";

export type UpstreamSignIn =
  | { state: "connected" }
  | { state: "not_connected"; detail: "never_connected" }
  | {
      state: "needs_reconnect";
      detail: "token_missing" | "expired_no_refresh_token" | "refresh_failed";
    };

/** Refresh this long before expiry on every MCP request. */
export const REQUEST_REFRESH_SKEW_MS = 180_000;
/** Refresh this long before expiry on a keep-alive status call. */
export const KEEPALIVE_REFRESH_SKEW_MS = 900_000;

const REFRESH_HTTP_TIMEOUT_MS = 20_000;
const LOCK_RETRY_MS = 250;
const LOCK_WAIT_MS = 25_000;
/** At most this many refreshes hold a lock connection at once. */
const LOCK_POOL_SIZE = 3;
const LOCK_CONNECT_TIMEOUT_MS = 10_000;

function expiresAtMs(row: OAuthTokenRow): number | null {
  if (!row.expires_at) return null;
  const parsed = new Date(row.expires_at).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/** True when the access token is still good `skewMs` from now. */
function freshFor(row: OAuthTokenRow, now: number, skewMs: number): boolean {
  if (!row.encrypted_access_token) return false;
  const expires = expiresAtMs(row);
  return expires === null || expires > now + skewMs;
}

export async function ensureUpstreamSignIn(
  connector: ConnectorRow,
  db: Db,
  options: { refresh: "never" | "if_near_expiry"; skewMs: number },
  deps: Pick<AgentGatewayDeps, "refreshUpstreamToken" | "withRefreshLock" | "now">,
): Promise<UpstreamSignIn> {
  const row = await loadOAuthToken(connector.id, db);
  if (!row) return { state: "not_connected", detail: "never_connected" };
  // A row with no access token: a Connect that was started and not finished,
  // or what is left after a refused refresh.
  if (!row.encrypted_access_token) {
    return { state: "needs_reconnect", detail: "token_missing" };
  }
  if (freshFor(row, deps.now(), options.skewMs)) return { state: "connected" };

  // Near or past expiry.
  if (!row.encrypted_refresh_token) {
    return freshFor(row, deps.now(), 0)
      ? { state: "connected" }
      : { state: "needs_reconnect", detail: "expired_no_refresh_token" };
  }
  // A refresh token exists. The next real call will refresh.
  if (options.refresh === "never") return { state: "connected" };

  try {
    return await deps.withRefreshLock<UpstreamSignIn>(connector.id, async () => {
      // Another caller may have refreshed while this one waited.
      const current = await loadOAuthToken(connector.id, db);
      if (current && freshFor(current, deps.now(), options.skewMs)) {
        return { state: "connected" };
      }
      await deps.refreshUpstreamToken(connector, db);
      return { state: "connected" };
    });
  } catch (err) {
    console.warn("[agent-gateway] upstream sign-in refresh failed", {
      userId: connector.user_id,
      connectorId: connector.id,
      error: safeErrorLog(err),
    });
    // The old access token may still be good for a short while.
    const after = await loadOAuthToken(connector.id, db).catch(() => null);
    if (after && freshFor(after, deps.now(), 0)) return { state: "connected" };
    return { state: "needs_reconnect", detail: "refresh_failed" };
  }
}

/**
 * The existing refresh code (the MCP SDK's auth() with Docket's provider),
 * called on purpose instead of waiting for a 401. In "use" mode the provider
 * throws instead of sending anyone to a sign-in page.
 */
export async function defaultRefreshUpstreamToken(
  connector: ConnectorRow,
  db: Db,
): Promise<void> {
  const provider = new DbMcpOAuthProvider(
    db,
    connector,
    connector.user_id,
    "use",
    mcpOAuthCallbackUrl(),
  );
  const result = await runMcpOAuth(provider, {
    serverUrl: connector.server_url,
    fetchFn: (input, init) =>
      guardedFetch(input, {
        ...init,
        signal: AbortSignal.timeout(REFRESH_HTTP_TIMEOUT_MS),
      }),
  });
  if (result !== "AUTHORIZED") throw new McpOAuthRequiredError();
}

const runningRefreshes = new Map<string, Promise<unknown>>();

/** The two calls the lock needs from a database connection. */
export type LockClient = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
};

let lockPool: Pool | null = null;

/**
 * A connection for holding a refresh lock. It comes from a small pool of
 * its own, never from the pool the web app's queries use.
 *
 * Why: the lock holder keeps its connection for the whole refresh, and the
 * refresh itself reads and writes the sign-in through the shared pool. If
 * both came from the shared pool (10 connections), ten refreshes at once
 * would each hold one connection and wait for an eleventh, and every
 * query of the Docket backend would hang. With its own pool the lock can
 * never starve the web app, and the pool's size caps how many refreshes
 * run at once. A wait for a lock connection fails after a few seconds
 * instead of hanging.
 */
async function defaultLockClient(): Promise<LockClient> {
  if (!lockPool) {
    lockPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.PGSSLMODE === "disable" ||
        process.env.NODE_ENV === "development"
          ? undefined
          : { rejectUnauthorized: false },
      max: LOCK_POOL_SIZE,
      connectionTimeoutMillis: LOCK_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    });
    // An idle lock connection that drops must not take the process down.
    lockPool.on("error", () => undefined);
  }
  return (await lockPool.connect()) as unknown as LockClient;
}

/**
 * Runs `run` while holding a Postgres advisory lock on `key`.
 *
 * The lock is a transaction lock: it is taken inside BEGIN and goes when
 * the transaction ends, or when the connection drops. So it is also safe
 * behind a connection pooler in transaction mode, where a session lock
 * could be taken on one server connection and released on another.
 */
export async function withPostgresAdvisoryLock<T>(
  key: string,
  run: () => Promise<T>,
  connect: () => Promise<LockClient> = defaultLockClient,
  waitMs: number = LOCK_WAIT_MS,
): Promise<T> {
  const client = await connect();
  let inTransaction = false;
  try {
    await client.query("begin");
    inTransaction = true;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const { rows } = await client.query(
        "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked",
        [key],
      );
      if (rows[0]?.locked === true) break;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the sign-in refresh lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
    return await run();
  } finally {
    // Ending the transaction releases the lock. Nothing was written in it.
    if (inTransaction) {
      await client.query("rollback").catch(() => undefined);
    }
    client.release();
  }
}

/**
 * One refresh per connector at a time. Callers in this process share one
 * promise. Across backend replicas a Postgres advisory lock does the same.
 */
export function defaultWithRefreshLock<T>(
  connectorId: string,
  run: () => Promise<T>,
): Promise<T> {
  const running = runningRefreshes.get(connectorId);
  if (running) return running as Promise<T>;
  const promise = withPostgresAdvisoryLock(
    `docket-agent-oauth:${connectorId}`,
    run,
  ).finally(() => {
    runningRefreshes.delete(connectorId);
  });
  runningRefreshes.set(connectorId, promise);
  return promise;
}
