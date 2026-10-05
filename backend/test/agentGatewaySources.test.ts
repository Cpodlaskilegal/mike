import {
  allowAgentEmails,
  BOX_URL,
  createFakeDb,
  createFakeUpstream,
  createMemoryRefreshLock,
  LEGACY_SHARED_PP_URL,
  PER_USER_PP_URL,
  QUO_URL,
  seedAgentPracticePantherConnector,
  seedConnector,
  seedManagedBoxConnector,
  seedManagedPracticePantherConnector,
  seedOAuthToken,
  seedTool,
  seedUser,
  setGatewayEnv,
  type FakeDb,
} from "./helpers/agentGatewayFakes";
import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPracticePantherMcpUrl,
  agentQuoMcpUrl,
} from "../src/lib/agentGateway/config";
import {
  disconnectAgentConnector,
  provisionAgentConnectors,
  resolveAgentConnector,
} from "../src/lib/agentGateway/sources";
import { agentSourceStatus, buildAgentStatus } from "../src/lib/agentGateway/status";
import { ensureUpstreamSignIn } from "../src/lib/agentGateway/upstreamAuth";
import { mintAgentToken } from "../src/lib/agentGateway/tokens";
import type { ConnectorRow } from "../src/lib/mcp/types";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;

/** Sign-in deps with a counting fake refresh. */
function signInDeps(db: FakeDb, options: { refreshFails?: boolean } = {}) {
  const refreshed: string[] = [];
  return {
    refreshed,
    deps: {
      now: () => NOW,
      withUpstreamClient: createFakeUpstream(db).withUpstreamClient,
      withRefreshLock: createMemoryRefreshLock(),
      refreshUpstreamToken: async (connector: ConnectorRow) => {
        refreshed.push(connector.id);
        // Yield, so concurrent callers really overlap.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (options.refreshFails) throw new Error("invalid_grant");
        for (const row of db.table("user_mcp_oauth_tokens")) {
          if (row.connector_id === connector.id) row.expires_at = iso(60 * MINUTE);
        }
      },
    },
  };
}

const neverValidate = async (): Promise<string> => {
  throw new Error("validateServerUrl must not be called");
};
const acceptUrl = async (url: string) => url;

test("PracticePanther: a user with only Docket's managed connector has no agent connector", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedManagedPracticePantherConnector(db, "user-1");

  assert.deepEqual(await resolveAgentConnector("user-1", "practicepanther", db.asDb()), {
    ok: false,
    detail: "no_connector",
  });
});

test("PracticePanther: a marked row at the old shared server is refused", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedAgentPracticePantherConnector(db, "user-1", { server_url: LEGACY_SHARED_PP_URL });

  assert.deepEqual(await resolveAgentConnector("user-1", "practicepanther", db.asDb()), {
    ok: false,
    detail: "wrong_server",
  });
});

test("PracticePanther: a marked row that is not an OAuth connector is refused", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedAgentPracticePantherConnector(db, "user-1", { auth_type: "none" });

  assert.deepEqual(await resolveAgentConnector("user-1", "practicepanther", db.asDb()), {
    ok: false,
    detail: "wrong_auth_type",
  });
});

test("PracticePanther: a marked row that also carries the managed mark is refused", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedAgentPracticePantherConnector(db, "user-1", {
    tool_policy: {
      docketAgentSource: "practicepanther",
      managedBy: "backend",
      managedConnector: "practicepanther",
    },
  });

  const resolved = await resolveAgentConnector("user-1", "practicepanther", db.asDb());
  assert.equal(resolved.ok, false);
});

test("PracticePanther: pointing the agent URL at the shared or managed server switches the source off", async () => {
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  seedAgentPracticePantherConnector(db, "user-2");

  const cases: Array<Record<string, string>> = [
    { DOCKET_AGENT_PRACTICEPANTHER_MCP_URL: LEGACY_SHARED_PP_URL },
    // The old host on any path.
    { DOCKET_AGENT_PRACTICEPANTHER_MCP_URL: "https://wild-spark-qn7iy.run.mcp-use.com/other" },
    // Equal to whatever Docket chat's managed connector uses.
    {
      DOCKET_AGENT_PRACTICEPANTHER_MCP_URL: "https://pp.example.invalid/mcp",
      PRACTICEPANTHER_MCP_SERVER_URL: "https://pp.example.invalid/mcp",
    },
    { DOCKET_AGENT_PRACTICEPANTHER_MCP_URL: "http://warm-pulse-vyvir.run.mcp-use.com/mcp" },
    { DOCKET_AGENT_PRACTICEPANTHER_MCP_URL: "not a url" },
  ];
  for (const env of cases) {
    setGatewayEnv(env);
    assert.equal(agentPracticePantherMcpUrl(), null, JSON.stringify(env));
    assert.deepEqual(await resolveAgentConnector("user-2", "practicepanther", db.asDb()), {
      ok: false,
      detail: "source_disabled",
    });
    const provisioned = await provisionAgentConnectors("user-1", db.asDb(), neverValidate);
    assert.equal(provisioned.practicepanther, "not_configured");
    assert.equal(
      db.table("user_mcp_connectors").filter((row) => row.user_id === "user-1").length,
      0,
    );
  }

  setGatewayEnv();
  assert.equal(agentPracticePantherMcpUrl(), PER_USER_PP_URL);
  assert.equal(agentQuoMcpUrl(), null);
});

test("a token user never gets another user's connector row", async () => {
  setGatewayEnv({ DOCKET_AGENT_QUO_MCP_URL: QUO_URL });
  const db = createFakeDb();
  const rowB = seedAgentPracticePantherConnector(db, "user-b");
  seedManagedBoxConnector(db, "user-b");
  seedConnector(db, {
    id: "quo-b",
    user_id: "user-b",
    server_url: QUO_URL,
    tool_policy: { docketAgentSource: "quo" },
  });

  // A has no rows at all.
  for (const source of ["practicepanther", "box", "quo"] as const) {
    assert.deepEqual(await resolveAgentConnector("user-a", source, db.asDb()), {
      ok: false,
      detail: "no_connector",
    });
  }

  // A has rows of his own: he gets his, never B's.
  const rowA = seedAgentPracticePantherConnector(db, "user-a");
  seedManagedBoxConnector(db, "user-a");
  for (const source of ["practicepanther", "box"] as const) {
    const resolved = await resolveAgentConnector("user-a", source, db.asDb());
    assert.ok(resolved.ok);
    assert.equal(resolved.connector.user_id, "user-a");
  }
  const mine = await resolveAgentConnector("user-a", "practicepanther", db.asDb());
  assert.ok(mine.ok);
  assert.equal(mine.connector.id, rowA.id);
  assert.notEqual(mine.connector.id, rowB.id);
  const theirs = await resolveAgentConnector("user-b", "quo", db.asDb());
  assert.ok(theirs.ok);
  assert.equal(theirs.connector.id, "quo-b");
});

test("Box uses the managed row only, and Quo needs its env var", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedManagedBoxConnector(db, "user-1");
  seedConnector(db, {
    id: "quo-1",
    user_id: "user-1",
    server_url: QUO_URL,
    tool_policy: { docketAgentSource: "quo" },
  });

  const box = await resolveAgentConnector("user-1", "box", db.asDb());
  assert.ok(box.ok);
  assert.equal(box.connector.id, "box-managed-user-1");
  assert.deepEqual(await resolveAgentConnector("user-1", "quo", db.asDb()), {
    ok: false,
    detail: "source_disabled",
  });

  setGatewayEnv({ BOX_MCP_ENABLED: "false", DOCKET_AGENT_QUO_MCP_URL: QUO_URL });
  assert.deepEqual(await resolveAgentConnector("user-1", "box", db.asDb()), {
    ok: false,
    detail: "source_disabled",
  });
  assert.equal((await resolveAgentConnector("user-1", "quo", db.asDb())).ok, true);

  // A Box row that is not an OAuth connector is refused.
  setGatewayEnv();
  const other = createFakeDb();
  seedManagedBoxConnector(other, "user-1", { auth_type: "none" });
  assert.deepEqual(await resolveAgentConnector("user-1", "box", other.asDb()), {
    ok: false,
    detail: "wrong_auth_type",
  });
});

test("source states without keep-alive make no refresh", async () => {
  setGatewayEnv();
  const never = { refresh: "never" as const, skewMs: 0 };

  async function stateOf(seed: (db: FakeDb) => void) {
    const db = createFakeDb();
    seed(db);
    const { deps, refreshed } = signInDeps(db);
    const status = await agentSourceStatus("user-1", "practicepanther", db.asDb(), never, deps);
    assert.equal(refreshed.length, 0);
    return status;
  }

  assert.deepEqual(await stateOf(() => undefined), {
    state: "not_connected",
    detail: "no_connector",
  });
  assert.deepEqual(
    await stateOf((db) => {
      seedAgentPracticePantherConnector(db, "user-1");
    }),
    { state: "not_connected", detail: "never_connected" },
  );
  assert.deepEqual(
    await stateOf((db) => {
      const row = seedAgentPracticePantherConnector(db, "user-1");
      seedOAuthToken(db, row.id, { expiresAt: iso(30 * MINUTE) });
    }),
    { state: "connected" },
  );
  // No expiry recorded counts as valid.
  assert.deepEqual(
    await stateOf((db) => {
      const row = seedAgentPracticePantherConnector(db, "user-1");
      seedOAuthToken(db, row.id, { expiresAt: null });
    }),
    { state: "connected" },
  );
  // Expired, but a refresh token is stored: the next real call will refresh.
  assert.deepEqual(
    await stateOf((db) => {
      const row = seedAgentPracticePantherConnector(db, "user-1");
      seedOAuthToken(db, row.id, { expiresAt: iso(-5 * MINUTE) });
    }),
    { state: "connected" },
  );
  assert.deepEqual(
    await stateOf((db) => {
      const row = seedAgentPracticePantherConnector(db, "user-1");
      seedOAuthToken(db, row.id, { expiresAt: iso(-5 * MINUTE), refreshToken: false });
    }),
    { state: "needs_reconnect", detail: "expired_no_refresh_token" },
  );
  // A Connect that was started and not finished: a row with no access token.
  assert.deepEqual(
    await stateOf((db) => {
      const row = seedAgentPracticePantherConnector(db, "user-1");
      seedOAuthToken(db, row.id, { accessToken: false });
    }),
    { state: "needs_reconnect", detail: "token_missing" },
  );
});

test("keep-alive refreshes an expiring sign-in once and leaves a fresh one alone", async () => {
  setGatewayEnv();
  const keepalive = { refresh: "if_near_expiry" as const, skewMs: 900_000 };

  // Expires in 10 minutes: inside the 15 minute keep-alive window.
  const db = createFakeDb();
  const row = seedAgentPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, row.id, { expiresAt: iso(10 * MINUTE) });
  const expiring = signInDeps(db);
  assert.deepEqual(
    await agentSourceStatus("user-1", "practicepanther", db.asDb(), keepalive, expiring.deps),
    { state: "connected" },
  );
  assert.deepEqual(expiring.refreshed, [row.id]);
  // Now it is fresh. A second keep-alive does nothing.
  await agentSourceStatus("user-1", "practicepanther", db.asDb(), keepalive, expiring.deps);
  assert.equal(expiring.refreshed.length, 1);

  // Expires in 40 minutes: not near expiry, not refreshed.
  const freshDb = createFakeDb();
  const freshRow = seedAgentPracticePantherConnector(freshDb, "user-1");
  seedOAuthToken(freshDb, freshRow.id, { expiresAt: iso(40 * MINUTE) });
  const fresh = signInDeps(freshDb);
  assert.deepEqual(
    await agentSourceStatus("user-1", "practicepanther", freshDb.asDb(), keepalive, fresh.deps),
    { state: "connected" },
  );
  assert.equal(fresh.refreshed.length, 0);
});

test("a failing refresh reports needs_reconnect, unless the old token is still good", async () => {
  setGatewayEnv();
  const keepalive = { refresh: "if_near_expiry" as const, skewMs: 900_000 };

  // Already expired and the refresh is refused.
  const db = createFakeDb();
  const row = seedAgentPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, row.id, { expiresAt: iso(-1 * MINUTE) });
  const failing = signInDeps(db, { refreshFails: true });
  assert.deepEqual(
    await agentSourceStatus("user-1", "practicepanther", db.asDb(), keepalive, failing.deps),
    { state: "needs_reconnect", detail: "refresh_failed" },
  );
  assert.equal(failing.refreshed.length, 1);

  // Refresh fails, but the access token has 10 minutes left: still usable.
  const okDb = createFakeDb();
  const okRow = seedAgentPracticePantherConnector(okDb, "user-1");
  seedOAuthToken(okDb, okRow.id, { expiresAt: iso(10 * MINUTE) });
  const stillGood = signInDeps(okDb, { refreshFails: true });
  assert.deepEqual(
    await agentSourceStatus("user-1", "practicepanther", okDb.asDb(), keepalive, stillGood.deps),
    { state: "connected" },
  );

  // The refused refresh deleted the stored sign-in (what the SDK does).
  const goneDb = createFakeDb();
  const goneRow = seedAgentPracticePantherConnector(goneDb, "user-1");
  seedOAuthToken(goneDb, goneRow.id, { expiresAt: iso(-1 * MINUTE) });
  const deleting = signInDeps(goneDb);
  deleting.deps.refreshUpstreamToken = async () => {
    goneDb.table("user_mcp_oauth_tokens").length = 0;
    throw new Error("invalid_grant");
  };
  assert.deepEqual(
    await agentSourceStatus("user-1", "practicepanther", goneDb.asDb(), keepalive, deleting.deps),
    { state: "needs_reconnect", detail: "refresh_failed" },
  );
});

test("ten concurrent calls on one expiring connector cause exactly one refresh", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  const row = seedAgentPracticePantherConnector(db, "user-1");
  // Inside the 3 minute request window.
  seedOAuthToken(db, row.id, { expiresAt: iso(1 * MINUTE) });
  const { deps, refreshed } = signInDeps(db);

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      ensureUpstreamSignIn(
        row,
        db.asDb(),
        { refresh: "if_near_expiry", skewMs: 180_000 },
        deps,
      ),
    ),
  );

  assert.equal(refreshed.length, 1);
  for (const result of results) assert.deepEqual(result, { state: "connected" });
});

test("provisioning creates the marked row once and leaves Docket chat's rows alone", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  seedManagedPracticePantherConnector(db, "user-1");
  const box = seedManagedBoxConnector(db, "user-1");
  seedOAuthToken(db, box.id, { expiresAt: iso(30 * MINUTE) });
  seedTool(db, box.id, "search_files_keyword");
  // Another user's rows must not move either.
  seedManagedBoxConnector(db, "user-2");

  const managedBefore = JSON.stringify(
    db.table("user_mcp_connectors").filter((row) => !row.tool_policy?.docketAgentSource),
  );
  const validated: string[] = [];
  const validate = async (url: string) => {
    validated.push(url);
    return url;
  };

  const first = await provisionAgentConnectors("user-1", db.asDb(), validate);
  assert.deepEqual(first, {
    practicepanther: "created",
    box: "managed",
    quo: "not_configured",
  });
  assert.deepEqual(validated, [PER_USER_PP_URL]);

  const marked = db
    .table("user_mcp_connectors")
    .filter((row) => row.tool_policy?.docketAgentSource);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].user_id, "user-1");
  assert.equal(marked[0].name, "PracticePanther (Docket Agent)");
  assert.equal(marked[0].enabled, false);
  assert.equal(marked[0].auth_type, "oauth");
  assert.equal(marked[0].server_url, PER_USER_PP_URL);
  assert.deepEqual(marked[0].tool_policy, { docketAgentSource: "practicepanther" });
  assert.equal(marked[0].encrypted_auth_config, null);

  // The new row is the one the gateway serves, and it is not connected yet.
  const resolved = await resolveAgentConnector("user-1", "practicepanther", db.asDb());
  assert.ok(resolved.ok);
  assert.equal(resolved.connector.id, marked[0].id);

  // Again: nothing changes.
  const snapshot = JSON.stringify(db.tables);
  const second = await provisionAgentConnectors("user-1", db.asDb(), validate);
  assert.deepEqual(second, {
    practicepanther: "unchanged",
    box: "managed",
    quo: "not_configured",
  });
  assert.equal(JSON.stringify(db.tables), snapshot);

  // The managed PracticePanther and Box rows are byte-for-byte the same.
  assert.equal(
    JSON.stringify(
      db.table("user_mcp_connectors").filter((row) => !row.tool_policy?.docketAgentSource),
    ),
    managedBefore,
  );
  assert.equal(db.table("user_mcp_oauth_tokens").length, 1);
  assert.equal(db.table("user_mcp_connector_tools").length, 1);
});

test("provisioning reports Box as missing or disabled and creates nothing for it", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  const result = await provisionAgentConnectors("user-1", db.asDb(), acceptUrl);
  assert.equal(result.box, "missing");

  setGatewayEnv({ BOX_MCP_ENABLED: "false" });
  const off = await provisionAgentConnectors("user-1", db.asDb(), acceptUrl);
  assert.equal(off.box, "disabled");
  assert.equal(
    db.table("user_mcp_connectors").filter((row) => row.server_url === BOX_URL).length,
    0,
  );
});

test("provisioning makes a Quo row only when Quo is configured", async () => {
  setGatewayEnv({ DOCKET_AGENT_QUO_MCP_URL: QUO_URL });
  const db = createFakeDb();
  const result = await provisionAgentConnectors("user-1", db.asDb(), acceptUrl);
  assert.equal(result.quo, "created");
  const quo = db
    .table("user_mcp_connectors")
    .find((row) => row.tool_policy?.docketAgentSource === "quo");
  assert.ok(quo);
  assert.equal(quo.name, "Quo (Docket Agent)");
  assert.equal(quo.server_url, QUO_URL);
  assert.equal(quo.enabled, false);
  assert.equal(quo.auth_type, "oauth");
});

test("a changed PracticePanther URL repoints the agent row and clears only its sign-in and tools", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  const agent = seedAgentPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, agent.id, { expiresAt: iso(30 * MINUTE) });
  seedTool(db, agent.id, "Tasks_GetTasks");
  const box = seedManagedBoxConnector(db, "user-1");
  seedOAuthToken(db, box.id, { expiresAt: iso(30 * MINUTE) });
  seedTool(db, box.id, "search_files_keyword");
  const boxBefore = JSON.stringify(db.table("user_mcp_connectors").find((row) => row.id === box.id));

  const newUrl = "https://new-pp-connector.example.invalid/mcp";
  setGatewayEnv({ DOCKET_AGENT_PRACTICEPANTHER_MCP_URL: newUrl });
  const result = await provisionAgentConnectors("user-1", db.asDb(), acceptUrl);
  assert.equal(result.practicepanther, "repointed");

  const row = db.table("user_mcp_connectors").find((item) => item.id === agent.id);
  assert.equal(row?.server_url, newUrl);
  assert.equal(row?.enabled, false);
  assert.deepEqual(
    db.table("user_mcp_oauth_tokens").map((item) => item.connector_id),
    [box.id],
  );
  assert.deepEqual(
    db.table("user_mcp_connector_tools").map((item) => item.connector_id),
    [box.id],
  );
  assert.equal(
    JSON.stringify(db.table("user_mcp_connectors").find((item) => item.id === box.id)),
    boxBefore,
  );
});

test("status lists users with a live token and named users, and reports bad emails apart", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  seedUser(db, { id: "user-2", email: "jerad.marks@podlaskilegal.com", role: "admin" });
  seedUser(db, { id: "user-3", email: "not.enrolled@podlaskilegal.com" });
  seedUser(db, { id: "twin-1", email: "twin@podlaskilegal.com" });
  seedUser(db, { id: "twin-2", email: "twin@podlaskilegal.com" });
  seedUser(db, { id: "gone", email: "gone@podlaskilegal.com", status: "deleted" });
  // On the allowed list, but never signed in to Docket.
  allowAgentEmails("typo@podlaskilegal.com");
  // A Docket user with a live token who is NOT on the allowed list (taken
  // off it after he was enrolled): not listed, and refused when named.
  seedUser(db, { id: "user-9", email: "taken.off@podlaskilegal.com", allowed: false });
  await mintAgentToken("user-1", db.asDb());
  await mintAgentToken("gone", db.asDb());
  await mintAgentToken("user-9", db.asDb());
  const row = seedAgentPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, row.id, { expiresAt: iso(30 * MINUTE) });
  const { deps, refreshed } = signInDeps(db);

  const answer = await buildAgentStatus({
    emails: [
      "Jerad.Marks@podlaskilegal.com",
      "typo@podlaskilegal.com",
      "someone@example.com",
      "twin@podlaskilegal.com",
      "not an email",
      "taken.off@podlaskilegal.com",
    ],
    keepalive: false,
    db: db.asDb(),
    deps,
  });

  assert.deepEqual(answer.users, [
    {
      email: "garrett.lewis@podlaskilegal.com",
      agent_enabled: true,
      role: "user",
      sources: {
        practicepanther: { state: "connected" },
        box: { state: "not_connected", detail: "no_connector" },
        quo: { state: "not_connected", detail: "source_disabled" },
      },
    },
    {
      email: "jerad.marks@podlaskilegal.com",
      agent_enabled: false,
      role: "admin",
      sources: {
        practicepanther: { state: "not_connected", detail: "no_connector" },
        box: { state: "not_connected", detail: "no_connector" },
        quo: { state: "not_connected", detail: "source_disabled" },
      },
    },
  ]);
  assert.deepEqual(answer.problems, [
    { email: "typo@podlaskilegal.com", error: "unknown_user" },
    { email: "someone@example.com", error: "email_domain_not_allowed" },
    { email: "twin@podlaskilegal.com", error: "ambiguous_user" },
    { email: "", error: "invalid_email" },
    { email: "taken.off@podlaskilegal.com", error: "email_not_allowed" },
  ]);
  assert.equal(answer.practicepanther_writes, "off");
  assert.equal(refreshed.length, 0);

  setGatewayEnv({ DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on" });
  const on = await buildAgentStatus({ emails: [], keepalive: false, db: db.asDb(), deps });
  assert.equal(on.practicepanther_writes, "on");
  assert.deepEqual(on.users.map((user) => user.email), ["garrett.lewis@podlaskilegal.com"]);
  setGatewayEnv();
});

// ---------------------------------------------------------------------------
// Removing a sign-in from a Docket Agent row.
// ---------------------------------------------------------------------------

test("the owner can remove the sign-in from his own Docket Agent row, and only that", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  seedUser(db, { id: "user-2", email: "jerad.marks@podlaskilegal.com" });
  const mine = seedAgentPracticePantherConnector(db, "user-1");
  const theirs = seedAgentPracticePantherConnector(db, "user-2");
  const box = seedManagedBoxConnector(db, "user-1");
  const chat = seedManagedPracticePantherConnector(db, "user-1");
  for (const row of [mine, theirs, box]) {
    seedOAuthToken(db, row.id, { expiresAt: iso(30 * MINUTE) });
    seedTool(db, row.id, "Tasks_GetTasks");
  }
  const { deps } = signInDeps(db);
  const state = (userId: string) =>
    agentSourceStatus(userId, "practicepanther", db.asDb(), { refresh: "never", skewMs: 0 }, deps);
  assert.deepEqual(await state("user-1"), { state: "connected" });

  // Another user's row: as if it did not exist.
  assert.deepEqual(await disconnectAgentConnector("user-1", theirs.id, db.asDb()), {
    ok: false,
    reason: "not_found",
  });
  // The rows Docket chat uses are not Docket Agent rows.
  for (const row of [box, chat]) {
    assert.deepEqual(await disconnectAgentConnector("user-1", row.id, db.asDb()), {
      ok: false,
      reason: "not_agent_connector",
    });
  }
  assert.deepEqual(await disconnectAgentConnector("user-1", "no-such-row", db.asDb()), {
    ok: false,
    reason: "not_found",
  });
  assert.equal(db.table("user_mcp_oauth_tokens").length, 3, "nothing was removed yet");

  assert.deepEqual(await disconnectAgentConnector("user-1", mine.id, db.asDb()), {
    ok: true,
    source: "practicepanther",
  });
  // His sign-in and tool list are gone. The row stays, so he can connect again.
  const ids = (table: string) => db.table(table).map((row) => row.connector_id).sort();
  assert.deepEqual(ids("user_mcp_oauth_tokens"), [box.id, theirs.id].sort());
  assert.deepEqual(ids("user_mcp_connector_tools"), [box.id, theirs.id].sort());
  assert.equal(db.table("user_mcp_connectors").length, 4);
  // Docket Agent can no longer use it, and the other user is not affected.
  assert.deepEqual(await state("user-1"), { state: "not_connected", detail: "never_connected" });
  assert.deepEqual(await state("user-2"), { state: "connected" });
  // Doing it again changes nothing.
  assert.deepEqual(await disconnectAgentConnector("user-1", mine.id, db.asDb()), {
    ok: true,
    source: "practicepanther",
  });
});

test("a row that carries both the agent mark and the managed mark is never disconnected", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  const row = seedAgentPracticePantherConnector(db, "user-1", {
    tool_policy: {
      docketAgentSource: "practicepanther",
      managedBy: "backend",
      managedConnector: "practicepanther",
    },
  });
  seedOAuthToken(db, row.id, { expiresAt: iso(30 * MINUTE) });
  assert.deepEqual(await disconnectAgentConnector("user-1", row.id, db.asDb()), {
    ok: false,
    reason: "not_agent_connector",
  });
  assert.equal(db.table("user_mcp_oauth_tokens").length, 1);
});

test("a named address that is allowed but has no Docket user is unknown, not refused", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  allowAgentEmails("new.associate@podlaskilegal.com");
  const { deps } = signInDeps(db);
  const answer = await buildAgentStatus({
    emails: ["new.associate@podlaskilegal.com", "not.listed@podlaskilegal.com"],
    keepalive: true,
    db: db.asDb(),
    deps,
  });
  assert.deepEqual(answer.users, []);
  assert.deepEqual(answer.problems, [
    { email: "new.associate@podlaskilegal.com", error: "unknown_user" },
    { email: "not.listed@podlaskilegal.com", error: "email_not_allowed" },
  ]);
});
