// What a failed refresh does to a user's stored sign-in.
//
// This runs the call the gateway makes to refresh (the MCP SDK's auth() with
// Docket's own DbMcpOAuthProvider, as in defaultRefreshUpstreamToken) against
// a stand-in token endpoint. No network: the address check is skipped and
// every HTTP answer comes from this file.
//
// Why it matters: the per-user PracticePanther connector answers
// 503 {"error":"temporarily_unavailable"} while PracticePanther is down.
// That must leave the sign-in in place, so the next try can succeed. Only a
// real refusal (invalid_grant) removes it and sends the user back to Connect.

import {
  createFakeDb,
  createMemoryRefreshLock,
  PER_USER_PP_URL,
  seedAgentPracticePantherConnector,
  seedUser,
  setGatewayEnv,
  type FakeDb,
} from "./helpers/agentGatewayFakes";
import assert from "node:assert/strict";
import test from "node:test";
import { auth as runMcpOAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { ensureUpstreamSignIn } from "../src/lib/agentGateway/upstreamAuth";
import { encryptString } from "../src/lib/mcp/client";
import { DbMcpOAuthProvider, McpOAuthRequiredError } from "../src/lib/mcp/oauth";
import type { ConnectorRow, Db } from "../src/lib/mcp/types";

process.env.MCP_CONNECTORS_ENCRYPTION_SECRET ||=
  "test-only-secret-for-the-in-memory-database";

const ORIGIN = new URL(PER_USER_PP_URL).origin;
const MINUTE = 60_000;

/** The provider the gateway uses, without the DNS lookup of the address check. */
class OfflineProvider extends DbMcpOAuthProvider {
  async validateResourceURL() {
    return undefined;
  }
}

type TokenAnswer = () => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A world with one connected user whose access token has just expired. */
function setup() {
  setGatewayEnv();
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  const connector = seedAgentPracticePantherConnector(db, "user-1");
  const secret = (value: string, prefix: string) => {
    const sealed = encryptString(value);
    return {
      [`encrypted_${prefix}`]: sealed.encrypted,
      [`${prefix}_iv`]: sealed.iv,
      [`${prefix}_tag`]: sealed.tag,
    };
  };
  db.table("user_mcp_oauth_tokens").push({
    id: "token-row-1",
    connector_id: connector.id,
    ...secret("upstream-access-old", "access_token"),
    ...secret("upstream-refresh-old", "refresh_token"),
    encrypted_client_secret: null,
    client_secret_iv: null,
    client_secret_tag: null,
    token_type: "Bearer",
    scope: null,
    expires_at: new Date(Date.now() - MINUTE).toISOString(),
    client_id: "docket-client",
  });

  const tokenCalls: string[] = [];
  let answer: TokenAnswer = () => json(500, {});
  const fetchFn = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) return json(404, {});
    if (url.includes(".well-known/")) {
      return json(200, {
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    }
    if (url === `${ORIGIN}/token`) {
      tokenCalls.push(String(init?.body ?? ""));
      return answer();
    }
    return json(404, {});
  };

  /** The same call as defaultRefreshUpstreamToken, with the stand-in fetch. */
  async function refresh(row: ConnectorRow, database: Db): Promise<void> {
    const provider = new OfflineProvider(
      database,
      row,
      row.user_id,
      "use",
      "https://docket.example.invalid/user/mcp-connectors/oauth/callback",
    );
    const result = await runMcpOAuth(provider, {
      serverUrl: row.server_url,
      fetchFn: fetchFn as typeof fetch,
    });
    if (result !== "AUTHORIZED") throw new McpOAuthRequiredError();
  }

  const signIn = () =>
    ensureUpstreamSignIn(
      connector,
      db.asDb(),
      { refresh: "if_near_expiry", skewMs: 3 * MINUTE },
      {
        now: () => Date.now(),
        withRefreshLock: createMemoryRefreshLock(),
        refreshUpstreamToken: refresh,
      },
    );

  return {
    db,
    connector,
    tokenCalls,
    signIn,
    setAnswer: (next: TokenAnswer) => {
      answer = next;
    },
  };
}

function tokenRows(db: FakeDb) {
  return structuredClone(db.table("user_mcp_oauth_tokens"));
}

const SUCCESS = () =>
  json(200, {
    access_token: "upstream-access-new",
    refresh_token: "upstream-refresh-new",
    token_type: "Bearer",
    expires_in: 3600,
  });

// The console lines of a failed refresh are expected here. Keep the run quiet.
const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const original = console.warn;
  console.warn = () => undefined;
  try {
    return await run();
  } finally {
    console.warn = original;
  }
};

test("a 503 temporarily_unavailable from the connector keeps the sign-in, and the next try works", async () => {
  const world = setup();
  const before = tokenRows(world.db);

  world.setAnswer(() =>
    json(503, { error: "temporarily_unavailable" }, { "retry-after": "30" }),
  );
  const down = await quiet(world.signIn);
  // Reported, so the poller holds the mail for now ...
  assert.deepEqual(down, { state: "needs_reconnect", detail: "refresh_failed" });
  // ... but nothing was thrown away, and the refresh token was used once only.
  assert.deepEqual(tokenRows(world.db), before);
  assert.equal(world.tokenCalls.length, 1);
  assert.match(world.tokenCalls[0], /grant_type=refresh_token/);

  // PracticePanther is back. The same stored sign-in refreshes.
  world.setAnswer(SUCCESS);
  assert.deepEqual(await world.signIn(), { state: "connected" });
  const [row] = world.db.table("user_mcp_oauth_tokens");
  assert.notEqual(row.encrypted_access_token, before[0].encrypted_access_token);
  assert.notEqual(row.encrypted_refresh_token, before[0].encrypted_refresh_token);
  assert.ok(Date.parse(row.expires_at) > Date.now() + 30 * MINUTE);
  assert.equal(world.db.table("user_mcp_oauth_tokens").length, 1);
});

test("an unreadable 5xx answer keeps the sign-in too", async () => {
  const world = setup();
  const before = tokenRows(world.db);
  world.setAnswer(() => new Response("<html>bad gateway</html>", { status: 502 }));
  assert.deepEqual(await quiet(world.signIn), {
    state: "needs_reconnect",
    detail: "refresh_failed",
  });
  assert.deepEqual(tokenRows(world.db), before);

  world.setAnswer(SUCCESS);
  assert.deepEqual(await world.signIn(), { state: "connected" });
});

test("only a real refusal (invalid_grant) removes the sign-in", async () => {
  const world = setup();
  world.setAnswer(() => json(401, { error: "invalid_grant" }));
  assert.deepEqual(await quiet(world.signIn), {
    state: "needs_reconnect",
    detail: "refresh_failed",
  });
  assert.equal(world.db.table("user_mcp_oauth_tokens").length, 0);
  // From then on the source reads as never connected: the user clicks Connect.
  assert.deepEqual(await world.signIn(), {
    state: "not_connected",
    detail: "never_connected",
  });
});
