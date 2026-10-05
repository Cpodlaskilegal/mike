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
//
// The second half is about two callers. Docket chat and the Docket Agent
// gateway use the same PracticePanther sign-in, and its refresh token works
// once only. Both refresh early and under one lock, so they cannot spend the
// same refresh token twice and lose the user's sign-in between them.

import {
  createFakeDb,
  createMemoryRefreshLock,
  PER_USER_PP_URL,
  seedPerUserPracticePantherConnector,
  seedUser,
  setGatewayEnv,
  TEST_OPS_TOKEN,
  type FakeDb,
} from "./helpers/agentGatewayFakes";
import assert from "node:assert/strict";
import test from "node:test";
import { auth as runMcpOAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { disconnectPracticePantherSignIn } from "../src/lib/agentGateway/sources";
import {
  ensureUpstreamSignIn,
  refreshSignInBeforeUse,
} from "../src/lib/agentGateway/upstreamAuth";
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

type TokenAnswer = (body: string) => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A world with one connected user whose access token has just expired.
 * The gateway is switched on, as it is wherever a Docket Agent session can
 * share a sign-in with chat.
 */
function setup() {
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  const connector = seedPerUserPracticePantherConnector(db, "user-1");
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
      const body = String(init?.body ?? "");
      tokenCalls.push(body);
      return answer(body);
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
    refresh,
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

// ---------------------------------------------------------------------------
// One sign-in, two users of it: Docket chat and the Docket Agent gateway.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A token endpoint whose refresh tokens work once, as the per-user
 * PracticePanther connector's and Box's do. A second use of the same
 * refresh token is refused with invalid_grant. The refusal is the slower
 * answer, so a caller who lost the race learns of it after the winner has
 * stored the new sign-in: the order in which the loss is complete.
 */
function singleUseTokenEndpoint(world: ReturnType<typeof setup>) {
  let current = "upstream-refresh-old";
  let issued = 0;
  world.setAnswer(async (body) => {
    const presented = new URLSearchParams(body).get("refresh_token");
    if (presented !== current) {
      await sleep(40);
      return json(400, { error: "invalid_grant" });
    }
    issued += 1;
    current = `upstream-refresh-${issued}`;
    const answer = json(200, {
      access_token: `upstream-access-${issued}`,
      refresh_token: current,
      token_type: "Bearer",
      expires_in: 3600,
    });
    await sleep(10);
    return answer;
  });
  return { issued: () => issued };
}

type Lock = <T>(connectorId: string, run: () => Promise<T>) => Promise<T>;

/** Three chat calls and three gateway calls at once, on one expired sign-in. */
function chatAndGatewayTogether(world: ReturnType<typeof setup>, withRefreshLock: Lock) {
  const deps = {
    now: () => Date.now(),
    withRefreshLock,
    refreshUpstreamToken: world.refresh,
  };
  // What Docket's own MCP client path does before it connects (chat, and
  // the tool-list refresh on the connectors page).
  const chat = () => refreshSignInBeforeUse(world.connector, world.db.asDb(), deps);
  // What the gateway does before every request of an agent token.
  const gateway = () =>
    ensureUpstreamSignIn(
      world.connector,
      world.db.asDb(),
      { refresh: "if_near_expiry", skewMs: 3 * MINUTE },
      deps,
    );
  return Promise.all([chat(), gateway(), chat(), gateway(), chat(), gateway()]);
}

test("Docket chat and the gateway refresh a shared sign-in once, and it stays", async () => {
  const world = setup();
  const endpoint = singleUseTokenEndpoint(world);

  const results = await chatAndGatewayTogether(world, createMemoryRefreshLock());

  // One refresh. Nobody presented a refresh token that was already spent.
  assert.equal(world.tokenCalls.length, 1);
  assert.equal(endpoint.issued(), 1);
  // Chat's call returns nothing; the gateway's three all see a connection.
  assert.deepEqual(
    results.filter((result) => result !== undefined),
    [{ state: "connected" }, { state: "connected" }, { state: "connected" }],
  );
  const rows = world.db.table("user_mcp_oauth_tokens");
  assert.equal(rows.length, 1, "the sign-in is still there");
  assert.ok(Date.parse(rows[0].expires_at) > Date.now() + 30 * MINUTE);
  assert.equal(rows[0].client_id, "docket-client");

  // An hour later the new refresh token works: nothing was damaged.
  rows[0].expires_at = new Date(Date.now() - MINUTE).toISOString();
  await chatAndGatewayTogether(world, createMemoryRefreshLock());
  assert.equal(world.tokenCalls.length, 2);
  assert.equal(endpoint.issued(), 2);
  assert.equal(world.db.table("user_mcp_oauth_tokens").length, 1);
});

test("the same calls with no lock between them lose the sign-in (what the lock is for)", async () => {
  const world = setup();
  const endpoint = singleUseTokenEndpoint(world);
  const noLock: Lock = (_connectorId, run) => run();

  await quiet(() => chatAndGatewayTogether(world, noLock));

  // Every caller spent the same refresh token. One was served, the others
  // were refused, and a refusal makes the MCP SDK delete the stored sign-in.
  assert.equal(endpoint.issued(), 1);
  assert.ok(world.tokenCalls.length > 1);
  assert.equal(world.db.table("user_mcp_oauth_tokens").length, 0);
});

test("the early refresh in Docket's own MCP client path never fails the call it precedes", async () => {
  const world = setup();
  singleUseTokenEndpoint(world);
  const deps = {
    now: () => Date.now(),
    withRefreshLock: createMemoryRefreshLock(),
    refreshUpstreamToken: world.refresh,
  };

  // Not an OAuth connector: nothing is read and nothing is asked.
  const queries = world.db.calls.length;
  await refreshSignInBeforeUse({ ...world.connector, auth_type: "none" }, world.db.asDb(), deps);
  assert.equal(world.db.calls.length, queries);
  assert.equal(world.tokenCalls.length, 0);

  // The stored sign-in cannot be read: the call goes on, as before.
  world.db.failOn("user_mcp_oauth_tokens", "select");
  await quiet(() => refreshSignInBeforeUse(world.connector, world.db.asDb(), deps));
  assert.equal(world.tokenCalls.length, 0);

  // The lock cannot be had: the call goes on, and nothing was refreshed.
  await quiet(() =>
    refreshSignInBeforeUse(world.connector, world.db.asDb(), {
      ...deps,
      withRefreshLock: async () => {
        throw new Error("Timed out waiting for the sign-in refresh lock.");
      },
    }),
  );
  assert.equal(world.tokenCalls.length, 0);

  // A refused refresh: the call goes on (and then finds no sign-in, as it
  // would have without the early refresh).
  world.setAnswer(() => json(400, { error: "invalid_grant" }));
  await quiet(() => refreshSignInBeforeUse(world.connector, world.db.asDb(), deps));
  assert.equal(world.db.table("user_mcp_oauth_tokens").length, 0);

  // No sign-in at all (never connected): nothing is asked.
  const calls = world.tokenCalls.length;
  await refreshSignInBeforeUse(world.connector, world.db.asDb(), deps);
  assert.equal(world.tokenCalls.length, calls);
});

test("with the gateway switched off, Docket's own MCP client path does nothing here: it is as it was", async () => {
  const world = setup();
  singleUseTokenEndpoint(world);
  let lockAsked = 0;
  const deps = {
    now: () => Date.now(),
    withRefreshLock: <T>(_connectorId: string, run: () => Promise<T>) => {
      lockAsked += 1;
      return run();
    },
    refreshUpstreamToken: world.refresh,
  };
  const before = tokenRows(world.db);

  // DOCKET_AGENT_OPS_TOKEN unset, and set to something too short to count:
  // an expired sign-in is not read, not locked and not refreshed.
  for (const values of [{}, { DOCKET_AGENT_OPS_TOKEN: "short" }]) {
    setGatewayEnv(values);
    const queries = world.db.calls.length;
    await refreshSignInBeforeUse(world.connector, world.db.asDb(), deps);
    assert.equal(world.db.calls.length, queries, "the sign-in row was not read");
  }
  assert.equal(lockAsked, 0);
  assert.equal(world.tokenCalls.length, 0);
  assert.deepEqual(tokenRows(world.db), before);

  // Switched on, the same call renews it.
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  await refreshSignInBeforeUse(world.connector, world.db.asDb(), deps);
  assert.equal(lockAsked, 1);
  assert.equal(world.tokenCalls.length, 1);
  assert.equal(world.db.table("user_mcp_oauth_tokens").length, 1);
});

test("a sign-in that is not near its end is left alone by the early refresh", async () => {
  const world = setup();
  singleUseTokenEndpoint(world);
  const [row] = world.db.table("user_mcp_oauth_tokens");
  row.expires_at = new Date(Date.now() + 30 * MINUTE).toISOString();
  const before = tokenRows(world.db);

  await chatAndGatewayTogether(world, createMemoryRefreshLock());

  assert.equal(world.tokenCalls.length, 0);
  assert.deepEqual(tokenRows(world.db), before);
});

test("Disconnect waits for a refresh that is under way, so the sign-in does not come back", async () => {
  const world = setup();
  singleUseTokenEndpoint(world);
  const lock = createMemoryRefreshLock();
  const deps = {
    now: () => Date.now(),
    withRefreshLock: lock,
    refreshUpstreamToken: world.refresh,
  };

  // A chat call starts a refresh. While it is on its way the user clicks
  // Disconnect on his PracticePanther connection.
  const refreshing = refreshSignInBeforeUse(world.connector, world.db.asDb(), deps);
  await sleep(1);
  const disconnected = await disconnectPracticePantherSignIn(
    "user-1",
    world.connector.id,
    world.db.asDb(),
    lock,
  );
  await refreshing;

  assert.deepEqual(disconnected, { ok: true });
  assert.equal(world.tokenCalls.length, 1, "the refresh did finish");
  // Removed after the refresh stored its answer, not before.
  assert.equal(world.db.table("user_mcp_oauth_tokens").length, 0);
});
