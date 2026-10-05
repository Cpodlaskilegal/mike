import {
  allowAgentEmails,
  BOX_URL,
  createFakeDb,
  createFakeUpstream,
  createMemoryRefreshLock,
  LEGACY_SHARED_PP_URL,
  PER_USER_PP_URL,
  QUO_URL,
  seedPerUserPracticePantherConnector,
  seedConnector,
  seedManagedBoxConnector,
  seedLegacySharedPracticePantherConnector,
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
  disconnectPracticePantherSignIn,
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

test("PracticePanther: the row Docket keeps for the user is the one served", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedLegacySharedPracticePantherConnector(db, "user-1");
  const own = seedPerUserPracticePantherConnector(db, "user-1");

  const resolved = await resolveAgentConnector("user-1", "practicepanther", db.asDb());
  assert.ok(resolved.ok);
  assert.equal(resolved.connector.id, own.id);
  assert.equal(resolved.connector.server_url, PER_USER_PP_URL);
  assert.equal(resolved.connector.auth_type, "oauth");
  // No row was written: the gateway only reads Docket's rows.
  assert.equal(db.table("user_mcp_connectors").length, 2);
});

test("PracticePanther: a user who only has the old shared connector is refused", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedLegacySharedPracticePantherConnector(db, "user-1");

  assert.deepEqual(await resolveAgentConnector("user-1", "practicepanther", db.asDb()), {
    ok: false,
    detail: "no_connector",
  });
});

test("PracticePanther: a row at the old shared server is never served, whatever it says", async () => {
  const db = createFakeDb();
  // Switched on and calling itself an OAuth connector: still the shared server.
  seedLegacySharedPracticePantherConnector(db, "user-1", {
    auth_type: "oauth",
    enabled: true,
  });

  setGatewayEnv();
  assert.deepEqual(await resolveAgentConnector("user-1", "practicepanther", db.asDb()), {
    ok: false,
    detail: "no_connector",
  });
  // Docket itself still on the shared connector: the source is off.
  setGatewayEnv({ PRACTICEPANTHER_USER_MCP_SERVER_URL: "" });
  assert.deepEqual(await resolveAgentConnector("user-1", "practicepanther", db.asDb()), {
    ok: false,
    detail: "source_disabled",
  });
  // Someone pointed the per-user setting at the shared server.
  setGatewayEnv({ PRACTICEPANTHER_USER_MCP_SERVER_URL: LEGACY_SHARED_PP_URL });
  assert.deepEqual(await resolveAgentConnector("user-1", "practicepanther", db.asDb()), {
    ok: false,
    detail: "source_disabled",
  });
  setGatewayEnv();
});

test("PracticePanther: a row that is not an OAuth connector is refused", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedPerUserPracticePantherConnector(db, "user-1", { auth_type: "none" });

  assert.deepEqual(await resolveAgentConnector("user-1", "practicepanther", db.asDb()), {
    ok: false,
    detail: "wrong_auth_type",
  });
});

test("PracticePanther: a row at the right address that is not Docket's PracticePanther row is refused", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedPerUserPracticePantherConnector(db, "user-1", {
    tool_policy: { managedBy: "backend", managedConnector: "box" },
  });
  assert.deepEqual(await resolveAgentConnector("user-1", "practicepanther", db.asDb()), {
    ok: false,
    detail: "wrong_server",
  });

  // A row that carries a Docket Agent mark is not Docket's own row.
  const marked = createFakeDb();
  seedPerUserPracticePantherConnector(marked, "user-1", {
    tool_policy: {
      docketAgentSource: "practicepanther",
      managedBy: "backend",
      managedConnector: "practicepanther",
    },
  });
  const resolved = await resolveAgentConnector("user-1", "practicepanther", marked.asDb());
  assert.equal(resolved.ok, false);
});

test("PracticePanther: the source is off unless Docket runs on a usable per-user connector", async () => {
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  seedPerUserPracticePantherConnector(db, "user-2");

  const cases: Array<Record<string, string>> = [
    // Docket still on the old shared connector.
    { PRACTICEPANTHER_USER_MCP_SERVER_URL: "" },
    { PRACTICEPANTHER_USER_MCP_SERVER_URL: LEGACY_SHARED_PP_URL },
    // The old host on any path.
    { PRACTICEPANTHER_USER_MCP_SERVER_URL: "https://wild-spark-qn7iy.run.mcp-use.com/other" },
    // The host Docket's shared-connector setting names.
    {
      PRACTICEPANTHER_USER_MCP_SERVER_URL: "https://pp.example.invalid/mcp",
      PRACTICEPANTHER_MCP_SERVER_URL: "https://pp.example.invalid/mcp",
    },
    { PRACTICEPANTHER_USER_MCP_SERVER_URL: "http://warm-pulse-vyvir.run.mcp-use.com/mcp" },
    { PRACTICEPANTHER_USER_MCP_SERVER_URL: "not a url" },
    // PracticePanther switched off for the whole backend.
    { PRACTICEPANTHER_MCP_ENABLED: "false" },
  ];
  for (const env of cases) {
    setGatewayEnv(env);
    assert.equal(agentPracticePantherMcpUrl(), null, JSON.stringify(env));
    assert.deepEqual(await resolveAgentConnector("user-2", "practicepanther", db.asDb()), {
      ok: false,
      detail: "source_disabled",
    });
    const provisioned = await provisionAgentConnectors("user-1", db.asDb(), neverValidate);
    assert.equal(provisioned.practicepanther, "disabled");
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
  const rowB = seedPerUserPracticePantherConnector(db, "user-b");
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
  const rowA = seedPerUserPracticePantherConnector(db, "user-a");
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
      seedPerUserPracticePantherConnector(db, "user-1");
    }),
    { state: "not_connected", detail: "never_connected" },
  );
  assert.deepEqual(
    await stateOf((db) => {
      const row = seedPerUserPracticePantherConnector(db, "user-1");
      seedOAuthToken(db, row.id, { expiresAt: iso(30 * MINUTE) });
    }),
    { state: "connected" },
  );
  // No expiry recorded counts as valid.
  assert.deepEqual(
    await stateOf((db) => {
      const row = seedPerUserPracticePantherConnector(db, "user-1");
      seedOAuthToken(db, row.id, { expiresAt: null });
    }),
    { state: "connected" },
  );
  // Expired, but a refresh token is stored: the next real call will refresh.
  assert.deepEqual(
    await stateOf((db) => {
      const row = seedPerUserPracticePantherConnector(db, "user-1");
      seedOAuthToken(db, row.id, { expiresAt: iso(-5 * MINUTE) });
    }),
    { state: "connected" },
  );
  assert.deepEqual(
    await stateOf((db) => {
      const row = seedPerUserPracticePantherConnector(db, "user-1");
      seedOAuthToken(db, row.id, { expiresAt: iso(-5 * MINUTE), refreshToken: false });
    }),
    { state: "needs_reconnect", detail: "expired_no_refresh_token" },
  );
  // A Connect that was started and not finished: a row with no access token.
  assert.deepEqual(
    await stateOf((db) => {
      const row = seedPerUserPracticePantherConnector(db, "user-1");
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
  const row = seedPerUserPracticePantherConnector(db, "user-1");
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
  const freshRow = seedPerUserPracticePantherConnector(freshDb, "user-1");
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
  const row = seedPerUserPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, row.id, { expiresAt: iso(-1 * MINUTE) });
  const failing = signInDeps(db, { refreshFails: true });
  assert.deepEqual(
    await agentSourceStatus("user-1", "practicepanther", db.asDb(), keepalive, failing.deps),
    { state: "needs_reconnect", detail: "refresh_failed" },
  );
  assert.equal(failing.refreshed.length, 1);

  // Refresh fails, but the access token has 10 minutes left: still usable.
  const okDb = createFakeDb();
  const okRow = seedPerUserPracticePantherConnector(okDb, "user-1");
  seedOAuthToken(okDb, okRow.id, { expiresAt: iso(10 * MINUTE) });
  const stillGood = signInDeps(okDb, { refreshFails: true });
  assert.deepEqual(
    await agentSourceStatus("user-1", "practicepanther", okDb.asDb(), keepalive, stillGood.deps),
    { state: "connected" },
  );

  // The refused refresh deleted the stored sign-in (what the SDK does).
  const goneDb = createFakeDb();
  const goneRow = seedPerUserPracticePantherConnector(goneDb, "user-1");
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
  const row = seedPerUserPracticePantherConnector(db, "user-1");
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

test("provisioning makes nothing for PracticePanther or Box and leaves Docket's rows alone", async () => {
  setGatewayEnv();
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  // He has not opened Docket since per-user sign-in was switched on: only
  // the retired shared row is there.
  seedLegacySharedPracticePantherConnector(db, "user-1");
  const box = seedManagedBoxConnector(db, "user-1");
  seedOAuthToken(db, box.id, { expiresAt: iso(30 * MINUTE) });
  seedTool(db, box.id, "search_files_keyword");
  // Another user's rows must not move either.
  seedPerUserPracticePantherConnector(db, "user-2");
  seedManagedBoxConnector(db, "user-2");

  const before = JSON.stringify(db.tables);
  const first = await provisionAgentConnectors("user-1", db.asDb(), neverValidate);
  assert.deepEqual(first, {
    practicepanther: "missing",
    box: "managed",
    quo: "not_configured",
  });
  assert.equal(JSON.stringify(db.tables), before, "nothing was written");

  // Docket makes his row when he opens it. Then it is the one served.
  const own = seedPerUserPracticePantherConnector(db, "user-1");
  const withRow = JSON.stringify(db.tables);
  const second = await provisionAgentConnectors("user-1", db.asDb(), neverValidate);
  assert.deepEqual(second, {
    practicepanther: "managed",
    box: "managed",
    quo: "not_configured",
  });
  assert.equal(JSON.stringify(db.tables), withRow, "nothing was written");
  const resolved = await resolveAgentConnector("user-1", "practicepanther", db.asDb());
  assert.ok(resolved.ok);
  assert.equal(resolved.connector.id, own.id);
  // No row carries a Docket Agent mark, and none is named for Docket Agent.
  for (const row of db.table("user_mcp_connectors")) {
    assert.equal("docketAgentSource" in (row.tool_policy ?? {}), false);
    assert.doesNotMatch(String(row.name), /Docket Agent/);
  }
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

test("a changed Quo URL repoints the Quo row and clears only its sign-in and tools", async () => {
  setGatewayEnv({ DOCKET_AGENT_QUO_MCP_URL: QUO_URL });
  const db = createFakeDb();
  const quo = seedConnector(db, {
    id: "quo-1",
    user_id: "user-1",
    name: "Quo (Docket Agent)",
    server_url: QUO_URL,
    tool_policy: { docketAgentSource: "quo" },
  });
  seedOAuthToken(db, quo.id, { expiresAt: iso(30 * MINUTE) });
  seedTool(db, quo.id, "list-contacts");
  const kept = [
    seedManagedBoxConnector(db, "user-1"),
    seedPerUserPracticePantherConnector(db, "user-1"),
  ];
  for (const row of kept) {
    seedOAuthToken(db, row.id, { expiresAt: iso(30 * MINUTE) });
    seedTool(db, row.id, "search_files_keyword");
  }
  const keptBefore = JSON.stringify(
    db.table("user_mcp_connectors").filter((row) => row.id !== quo.id),
  );

  const newUrl = "https://new-quo-connector.example.invalid/mcp";
  setGatewayEnv({ DOCKET_AGENT_QUO_MCP_URL: newUrl });
  const result = await provisionAgentConnectors("user-1", db.asDb(), acceptUrl);
  assert.deepEqual(result, {
    practicepanther: "managed",
    box: "managed",
    quo: "repointed",
  });

  const row = db.table("user_mcp_connectors").find((item) => item.id === quo.id);
  assert.equal(row?.server_url, newUrl);
  assert.equal(row?.enabled, false);
  const keptIds = kept.map((item) => item.id).sort();
  assert.deepEqual(
    db.table("user_mcp_oauth_tokens").map((item) => item.connector_id).sort(),
    keptIds,
  );
  assert.deepEqual(
    db.table("user_mcp_connector_tools").map((item) => item.connector_id).sort(),
    keptIds,
  );
  // Docket's own PracticePanther and Box rows are byte-for-byte the same.
  assert.equal(
    JSON.stringify(db.table("user_mcp_connectors").filter((item) => item.id !== quo.id)),
    keptBefore,
  );
  setGatewayEnv();
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
  const row = seedPerUserPracticePantherConnector(db, "user-1");
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
// Removing the user's own PracticePanther sign-in (Disconnect in Docket).
// ---------------------------------------------------------------------------

/** A lock that records which connector it was taken for, and when. */
function recordingLock(db: FakeDb) {
  const taken: string[] = [];
  return {
    taken,
    withSignInLock: async <T>(connectorId: string, run: () => Promise<T>): Promise<T> => {
      taken.push(connectorId);
      const signIns = () => db.table("user_mcp_oauth_tokens").length;
      db.events.push(`lock:taken:${connectorId}:sign-ins=${signIns()}`);
      try {
        return await run();
      } finally {
        db.events.push(`lock:released:${connectorId}:sign-ins=${signIns()}`);
      }
    },
  };
}

test("the owner can remove his own PracticePanther sign-in, and nothing else", async () => {
  setGatewayEnv({ DOCKET_AGENT_QUO_MCP_URL: QUO_URL });
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  seedUser(db, { id: "user-2", email: "jerad.marks@podlaskilegal.com" });
  const mine = seedPerUserPracticePantherConnector(db, "user-1");
  const theirs = seedPerUserPracticePantherConnector(db, "user-2");
  const box = seedManagedBoxConnector(db, "user-1");
  const shared = seedLegacySharedPracticePantherConnector(db, "user-1");
  const quo = seedConnector(db, {
    id: "quo-1",
    user_id: "user-1",
    server_url: QUO_URL,
    tool_policy: { docketAgentSource: "quo" },
  });
  for (const row of [mine, theirs, box, quo]) {
    seedOAuthToken(db, row.id, { expiresAt: iso(30 * MINUTE) });
    seedTool(db, row.id, "Tasks_GetTasks");
  }
  const { deps } = signInDeps(db);
  const lock = recordingLock(db);
  const state = (userId: string) =>
    agentSourceStatus(userId, "practicepanther", db.asDb(), { refresh: "never", skewMs: 0 }, deps);
  const disconnect = (userId: string, connectorId: string) =>
    disconnectPracticePantherSignIn(userId, connectorId, db.asDb(), lock.withSignInLock);
  assert.deepEqual(await state("user-1"), { state: "connected" });

  // Another user's row: as if it did not exist.
  assert.deepEqual(await disconnect("user-1", theirs.id), { ok: false, reason: "not_found" });
  assert.deepEqual(await disconnect("user-1", "no-such-row"), { ok: false, reason: "not_found" });
  // His Box row, the retired shared row and a Quo row are not his
  // PracticePanther sign-in.
  for (const row of [box, shared, quo]) {
    assert.deepEqual(await disconnect("user-1", row.id), {
      ok: false,
      reason: "not_practicepanther",
    });
  }
  assert.equal(db.table("user_mcp_oauth_tokens").length, 4, "nothing was removed yet");
  assert.deepEqual(lock.taken, [], "a refusal takes no lock");

  db.events.length = 0;
  assert.deepEqual(await disconnect("user-1", mine.id), { ok: true });
  // The sign-in went while the lock was held, so no refresh under way can
  // write it back afterwards.
  assert.deepEqual(db.events, [
    `lock:taken:${mine.id}:sign-ins=4`,
    `lock:released:${mine.id}:sign-ins=3`,
  ]);
  const ids = (table: string) => db.table(table).map((row) => row.connector_id).sort();
  assert.deepEqual(ids("user_mcp_oauth_tokens"), [box.id, theirs.id, quo.id].sort());
  // The row and its tool list stay, so he can connect again.
  assert.deepEqual(
    ids("user_mcp_connector_tools"),
    [box.id, mine.id, theirs.id, quo.id].sort(),
  );
  assert.equal(db.table("user_mcp_connectors").length, 5);
  // Neither Docket chat nor Docket Agent can use it now. The other user is
  // not affected.
  assert.deepEqual(await state("user-1"), { state: "not_connected", detail: "never_connected" });
  assert.deepEqual(await state("user-2"), { state: "connected" });
  // Doing it again changes nothing.
  assert.deepEqual(await disconnect("user-1", mine.id), { ok: true });
  setGatewayEnv();
});

test("only Docket's per-user PracticePanther connector can be disconnected", async () => {
  const db = createFakeDb();
  const lock = recordingLock(db);
  const row = seedPerUserPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, row.id, { expiresAt: iso(30 * MINUTE) });
  const marked = seedPerUserPracticePantherConnector(db, "user-2", {
    tool_policy: {
      docketAgentSource: "practicepanther",
      managedBy: "backend",
      managedConnector: "practicepanther",
    },
  });
  seedOAuthToken(db, marked.id, { expiresAt: iso(30 * MINUTE) });

  // Docket not on the per-user connector: there is no such sign-in to remove.
  setGatewayEnv({ PRACTICEPANTHER_USER_MCP_SERVER_URL: "" });
  assert.deepEqual(
    await disconnectPracticePantherSignIn("user-1", row.id, db.asDb(), lock.withSignInLock),
    { ok: false, reason: "not_practicepanther" },
  );
  setGatewayEnv();
  assert.deepEqual(
    await disconnectPracticePantherSignIn("user-2", marked.id, db.asDb(), lock.withSignInLock),
    { ok: false, reason: "not_practicepanther" },
  );
  assert.equal(db.table("user_mcp_oauth_tokens").length, 2);
  assert.deepEqual(lock.taken, []);

  // A failed removal is an error, not a silent "done".
  db.failOn("user_mcp_oauth_tokens", "delete");
  await assert.rejects(
    disconnectPracticePantherSignIn("user-1", row.id, db.asDb(), lock.withSignInLock),
    /Sign-in could not be removed\./,
  );
  assert.equal(db.table("user_mcp_oauth_tokens").length, 2);
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
