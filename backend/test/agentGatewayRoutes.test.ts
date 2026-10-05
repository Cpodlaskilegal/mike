import {
  allowAgentEmails,
  createFakeDb,
  createFakeUpstream,
  createMemoryRefreshLock,
  FAKE_UPSTREAM_ACCESS_TOKEN,
  QUO_URL,
  seedPerUserPracticePantherConnector,
  seedConnector,
  seedManagedBoxConnector,
  seedLegacySharedPracticePantherConnector,
  seedOAuthToken,
  seedTool,
  seedUser,
  setGatewayEnv,
  TEST_OPS_TOKEN,
  TEST_STATUS_TOKEN,
  withApp,
  type FakeDb,
} from "./helpers/agentGatewayFakes";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import test, { after } from "node:test";
import { inspect } from "node:util";
import express from "express";
import { generateAgentToken, mintAgentToken } from "../src/lib/agentGateway/tokens";
import { McpOAuthRequiredError } from "../src/lib/mcp/oauth";
import {
  AGENT_BOX_ORGANIZE_TOOLS,
  AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS,
  AGENT_PRACTICEPANTHER_EXTRA_READ_TOOLS,
  AGENT_QUO_WRITE_TOOLS,
} from "../src/lib/agentGateway/policy";
import { toolRequiresConfirmation } from "../src/lib/mcp/client";
import {
  ADMIN_ONLY_PRACTICEPANTHER_TOOLS,
  READ_ALL_PRACTICEPANTHER_TOOLS,
} from "../src/lib/mcp/practicePantherAccessPolicy";
import type { ConnectorRow } from "../src/lib/mcp/types";
import { createAgentMcpRouter } from "../src/routes/agentMcp";

// ---------------------------------------------------------------------------
// Secret hygiene: every console line and every response body of this file is
// kept, and checked at the end for the agent tokens, the ops token and the
// fake upstream access token.
// ---------------------------------------------------------------------------
const capturedLogs: string[] = [];
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};
for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => {
    capturedLogs.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 10 })))
        .join(" "),
    );
  };
}
const responseBodies: string[] = [];
const mintedTokens: string[] = [];

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const GARRETT = "garrett.lewis@podlaskilegal.com";
const JERAD = "jerad.marks@podlaskilegal.com";

const PP_TOOLS = [
  "Tasks_GetTasks",
  "Tasks_GetTask",
  "Matters_GetMatters",
  "Messages_GetMessageAsync",
  "pp_oauth_status",
  "Tasks_PostTask",
  "Tasks_PutTask",
  "Tasks_PutTask_2",
  "Notes_PostNote",
  "Tasks_Delete",
  "Tasks_Delete_2",
  "Matters_PutMatter",
  "Accounts_PostAccount",
  "Invoices_GetInvoices",
  "Users_GetUsers",
  "pp_api_request",
  // Writes that stay refused whatever the switches say.
  "Messages_PostMessage",
  "Files_PostFile",
  "Expenses_PostAccount",
];

function setup() {
  const db = createFakeDb();
  const upstream = createFakeUpstream(db);
  const refreshed: string[] = [];
  const toolRefreshes: string[] = [];
  const router = createAgentMcpRouter({
    db: () => db.asDb(),
    now: () => NOW,
    withUpstreamClient: upstream.withUpstreamClient,
    withRefreshLock: createMemoryRefreshLock(),
    refreshUpstreamToken: async (connector: ConnectorRow) => {
      refreshed.push(connector.id);
      for (const row of db.table("user_mcp_oauth_tokens")) {
        if (row.connector_id === connector.id) row.expires_at = iso(60 * MINUTE);
      }
    },
    refreshTools: async (_userId, connectorId) => {
      toolRefreshes.push(connectorId);
    },
    validateServerUrl: async (url) => url,
  });
  const app = express();
  app.use("/agent-mcp", router);
  // Anything that reaches this proves a request fell through the gateway.
  app.use((_req, res) => res.status(418).json({ fell_through: true }));
  return { db, upstream, refreshed, toolRefreshes, app };
}

/** A Docket user with a live agent token. */
async function enroll(
  db: FakeDb,
  userId: string,
  email: string,
  role: "user" | "admin" = "user",
): Promise<string> {
  seedUser(db, { id: userId, email, role });
  const { token } = await mintAgentToken(userId, db.asDb());
  mintedTokens.push(token);
  return token;
}

/**
 * The user's own PracticePanther connection in Docket (the row Docket keeps
 * and chat uses), connected, with a tool cache.
 */
function connectPracticePanther(db: FakeDb, userId: string): ConnectorRow {
  const connector = seedPerUserPracticePantherConnector(db, userId);
  seedOAuthToken(db, connector.id, { expiresAt: iso(30 * MINUTE) });
  for (const name of PP_TOOLS) {
    seedTool(db, connector.id, name, {
      // The connector's cached flags must not matter. Policy decides.
      enabled: false,
      requires_confirmation: true,
      output_schema: { type: "object" },
    });
  }
  return connector;
}

type Answer = {
  status: number;
  headers: Headers;
  text: string;
  json: any;
};

async function request(
  url: string,
  init: RequestInit & { record?: boolean } = {},
): Promise<Answer> {
  const { record, ...rest } = init;
  const response = await fetch(url, rest);
  const text = await response.text();
  if (record !== false) responseBodies.push(text);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function bearer(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

let nextRpcId = 1;
async function rpc(
  baseUrl: string,
  source: string,
  token: string | null,
  method: string,
  params: unknown = {},
): Promise<Answer> {
  return request(`${baseUrl}/agent-mcp/${source}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...bearer(token),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
  });
}

function ops(
  baseUrl: string,
  path: string,
  init: RequestInit & { token?: string | null; record?: boolean } = {},
): Promise<Answer> {
  const { token = TEST_OPS_TOKEN, headers, ...rest } = init;
  return request(`${baseUrl}/agent-mcp/ops${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...bearer(token),
      ...(headers as Record<string, string> | undefined),
    },
  });
}

function auditRows(db: FakeDb) {
  return db.table("user_mcp_tool_audit_logs");
}

function assertNoStore(answer: Answer) {
  assert.equal(answer.headers.get("cache-control"), "no-store");
}

test("with the ops token unset the whole surface answers 503, with or without credentials", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");

  for (const env of [{}, { DOCKET_AGENT_OPS_TOKEN: "a".repeat(31) }]) {
    setGatewayEnv(env);
    await withApp(app, async (baseUrl) => {
      const answers = [
        await rpc(baseUrl, "practicepanther", token, "tools/list"),
        await rpc(baseUrl, "practicepanther", null, "tools/list"),
        await rpc(baseUrl, "nonsense", token, "tools/list"),
        await request(`${baseUrl}/agent-mcp/practicepanther`),
        await ops(baseUrl, "/status"),
        await ops(baseUrl, "/status", { token: null }),
        await ops(baseUrl, "/status", { token: "a".repeat(31) }),
        await ops(baseUrl, "/tokens", { method: "POST", body: JSON.stringify({ email: GARRETT }) }),
        await ops(baseUrl, `/tokens?email=${GARRETT}`, { method: "DELETE" }),
        await ops(baseUrl, "/provision", { method: "POST", body: JSON.stringify({ email: GARRETT }) }),
        await request(`${baseUrl}/agent-mcp/`),
      ];
      for (const answer of answers) {
        assert.equal(answer.status, 503);
        assert.deepEqual(answer.json, { error: "agent_gateway_disabled" });
        assertNoStore(answer);
      }
    });
  }
  // Nothing was read or written while the gateway was off.
  assert.equal(auditRows(db).length, 0);
});

test("the MCP route rejects every bad bearer with 401 and the header", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const revoked = await enroll(db, "user-1", GARRETT);
  const live = await enroll(db, "user-1b", "second@podlaskilegal.com");
  const rotated = (await mintAgentToken("user-1", db.asDb())).token;
  mintedTokens.push(rotated);
  connectPracticePanther(db, "user-1");
  // A token whose user was deleted from Docket.
  const deletedUserToken = await enroll(db, "user-gone", "gone@podlaskilegal.com");
  db.table("app_users").find((row) => row.id === "user-gone")!.docket_data_status = "deleted";

  await withApp(app, async (baseUrl) => {
    const cases: Array<[string, Record<string, string>]> = [
      ["no bearer", {}],
      ["malformed bearer", { Authorization: "Bearer dka_too-short" }],
      ["not a bearer", { Authorization: `Basic ${live}` }],
      ["unknown token", { Authorization: `Bearer ${generateAgentToken()}` }],
      ["revoked token", { Authorization: `Bearer ${revoked}` }],
      ["ops token as agent token", { Authorization: `Bearer ${TEST_OPS_TOKEN}` }],
      ["deleted user", { Authorization: `Bearer ${deletedUserToken}` }],
    ];
    for (const [label, headers] of cases) {
      const answer = await request(`${baseUrl}/agent-mcp/practicepanther`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(answer.status, 401, label);
      assert.deepEqual(answer.json, { error: "invalid_token" }, label);
      assert.equal(
        answer.headers.get("www-authenticate"),
        'Bearer realm="docket-agent", error="invalid_token"',
        label,
      );
      assertNoStore(answer);
    }

    // The rotated token works, so the route itself is healthy.
    const ok = await rpc(baseUrl, "practicepanther", rotated, "tools/list");
    assert.equal(ok.status, 200);
  });
  assert.equal(upstream.calls.length, 0);
});

test("ops routes need the ops token; an agent token never opens them", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const agentToken = await enroll(db, "user-1", GARRETT);

  await withApp(app, async (baseUrl) => {
    const routes: Array<[string, RequestInit]> = [
      ["/status", {}],
      ["/tokens", { method: "POST", body: JSON.stringify({ email: GARRETT }) }],
      [`/tokens?email=${GARRETT}`, { method: "DELETE" }],
      ["/provision", { method: "POST", body: JSON.stringify({ email: GARRETT }) }],
    ];
    for (const [path, init] of routes) {
      for (const token of [null, "wrong-ops-token-0123456789abcdef0123456789abcdef", agentToken, `${TEST_OPS_TOKEN}x`]) {
        const answer = await ops(baseUrl, path, { ...init, token });
        assert.equal(answer.status, 401, `${path} with ${token ? "a wrong token" : "no token"}`);
        assert.deepEqual(answer.json, { error: "invalid_ops_token" });
        assert.equal(answer.headers.get("www-authenticate"), 'Bearer realm="docket-agent-ops"');
        assertNoStore(answer);
      }
    }
    // The agent token is still live: the refused calls changed nothing.
    assert.equal(db.table("docket_agent_tokens").filter((row) => row.revoked_at === null).length, 1);

    const status = await ops(baseUrl, "/status");
    assert.equal(status.status, 200);
    assert.equal(status.json.users.length, 1);
    assert.equal(status.json.users[0].email, GARRETT);

    const unknown = await ops(baseUrl, "/nothing-here");
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, { error: "not_found" });
  });
});

test("a source the user has not connected answers 401 with the reason", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  // Only Docket chat's shared connector: never served to an agent token.
  const managed = seedLegacySharedPracticePantherConnector(db, "user-1");
  seedTool(db, managed.id, "Tasks_GetTasks");
  // Box row exists, but its sign-in expired and cannot be refreshed.
  const box = seedManagedBoxConnector(db, "user-1");
  seedOAuthToken(db, box.id, { expiresAt: iso(-5 * MINUTE), refreshToken: false });

  await withApp(app, async (baseUrl) => {
    const expected: Array<[string, string]> = [
      ["practicepanther", "not_connected"],
      ["box", "needs_reconnect"],
      ["quo", "not_connected"],
    ];
    for (const [source, state] of expected) {
      const answer = await rpc(baseUrl, source, token, "tools/call", {
        name: "Tasks_GetTasks",
        arguments: {},
      });
      assert.equal(answer.status, 401, source);
      assert.deepEqual(answer.json, { error: "source_not_connected", source, state });
      assert.equal(
        answer.headers.get("www-authenticate"),
        'Bearer realm="docket-agent", error="invalid_token", error_description="source_not_connected"',
      );
      assertNoStore(answer);
    }
  });
  assert.equal(upstream.connectors.length, 0);
  assert.equal(upstream.calls.length, 0);
});

test("an unknown source is 404 and any method but POST is 405", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");

  await withApp(app, async (baseUrl) => {
    const unknown = await rpc(baseUrl, "gmail", token, "tools/list");
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, { error: "unknown_source" });

    for (const method of ["GET", "DELETE", "PUT"]) {
      const answer = await request(`${baseUrl}/agent-mcp/practicepanther`, {
        method,
        headers: bearer(token),
      });
      assert.equal(answer.status, 405, method);
      assert.equal(answer.headers.get("allow"), "POST");
      assert.deepEqual(answer.json, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
    }

    const deeper = await request(`${baseUrl}/agent-mcp/practicepanther/extra`, {
      method: "POST",
      headers: bearer(token),
    });
    assert.equal(deeper.status, 404);
    assert.deepEqual(deeper.json, { error: "not_found" });
  });
});

test("the MCP handshake works without a session and answers JSON", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");

  await withApp(app, async (baseUrl) => {
    const init = await rpc(baseUrl, "practicepanther", token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    });
    assert.equal(init.status, 200);
    assert.match(init.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(init.headers.get("mcp-session-id"), null);
    assert.equal(init.json.result.serverInfo.name, "docket-agent-gateway");
    assert.deepEqual(init.json.result.capabilities, { tools: {} });

    // Only tools are served.
    const resources = await rpc(baseUrl, "practicepanther", token, "resources/list");
    assert.equal(resources.status, 200);
    assert.equal(resources.json.error.code, -32601);
  });
  // The token's use was recorded.
  const row = db.table("docket_agent_tokens").find((item) => item.revoked_at === null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    db.table("docket_agent_tokens").find((item) => item.id === row!.id)!.last_used_at,
    new Date(NOW).toISOString(),
  );
});

test("tools/list for a non-admin shows PracticePanther reads only", async () => {
  const { app, db, toolRefreshes } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const userToken = await enroll(db, "user-1", GARRETT);
  const adminToken = await enroll(db, "admin-1", JERAD, "admin");
  connectPracticePanther(db, "user-1");
  connectPracticePanther(db, "admin-1");

  await withApp(app, async (baseUrl) => {
    const list = await rpc(baseUrl, "practicepanther", userToken, "tools/list");
    assert.equal(list.status, 200);
    const names = list.json.result.tools.map((tool: { name: string }) => tool.name);
    assert.deepEqual(names, [
      "Matters_GetMatters",
      "Messages_GetMessageAsync",
      "Tasks_GetTask",
      "Tasks_GetTasks",
      "Users_GetUsers",
      "pp_oauth_status",
    ]);
    for (const name of names) {
      assert.ok(!/delete/i.test(name), name);
      // The firm's user list is the one admin-only read a non-admin gets.
      assert.ok(
        !(ADMIN_ONLY_PRACTICEPANTHER_TOOLS as readonly string[]).includes(name) ||
          name === "Users_GetUsers",
        name,
      );
      assert.ok(
        (READ_ALL_PRACTICEPANTHER_TOOLS as readonly string[]).includes(name) ||
          (AGENT_PRACTICEPANTHER_EXTRA_READ_TOOLS as readonly string[]).includes(name),
        name,
      );
    }
    for (const tool of list.json.result.tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal("outputSchema" in tool, false);
    }

    // An admin also sees admin-only reads. Still no write, delete or raw API.
    const adminList = await rpc(baseUrl, "practicepanther", adminToken, "tools/list");
    const adminNames = adminList.json.result.tools.map((tool: { name: string }) => tool.name);
    assert.deepEqual(adminNames, [
      "Invoices_GetInvoices",
      "Matters_GetMatters",
      "Messages_GetMessageAsync",
      "Tasks_GetTask",
      "Tasks_GetTasks",
      "Users_GetUsers",
      "pp_oauth_status",
    ]);

    // With the gateway write switch on, the write list appears: the record
    // types the partner assistant changes, files included. Never a message,
    // a money record (for a non-admin), a delete or the raw API tool.
    setGatewayEnv({
      DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
      DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on",
    });
    const withWrites = await rpc(baseUrl, "practicepanther", userToken, "tools/list");
    assert.deepEqual(
      withWrites.json.result.tools.map((tool: { name: string }) => tool.name),
      [
        "Accounts_PostAccount",
        "Files_PostFile",
        "Matters_GetMatters",
        "Matters_PutMatter",
        "Messages_GetMessageAsync",
        "Notes_PostNote",
        "Tasks_GetTask",
        "Tasks_GetTasks",
        "Tasks_PostTask",
        "Tasks_PutTask",
        "Tasks_PutTask_2",
        "Users_GetUsers",
        "pp_oauth_status",
      ],
    );
    // An admin, writes on: also the admin-only reads and the money records'
    // creates and updates, as Docket's own role rule gives him. Still no
    // message, delete or raw API tool.
    const adminWithWrites = await rpc(baseUrl, "practicepanther", adminToken, "tools/list");
    assert.deepEqual(
      adminWithWrites.json.result.tools.map((tool: { name: string }) => tool.name),
      [
        "Accounts_PostAccount",
        "Expenses_PostAccount",
        "Files_PostFile",
        "Invoices_GetInvoices",
        "Matters_GetMatters",
        "Matters_PutMatter",
        "Messages_GetMessageAsync",
        "Notes_PostNote",
        "Tasks_GetTask",
        "Tasks_GetTasks",
        "Tasks_PostTask",
        "Tasks_PutTask",
        "Tasks_PutTask_2",
        "Users_GetUsers",
        "pp_oauth_status",
      ],
    );
  });
  // The cache had rows, so the upstream tool list was never re-read.
  assert.equal(toolRefreshes.length, 0);
});

test("tools/list reads the upstream tool list once when the cache is empty", async () => {
  const { app, db, toolRefreshes } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  const connector = seedPerUserPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, connector.id, { expiresAt: iso(30 * MINUTE) });

  await withApp(app, async (baseUrl) => {
    const list = await rpc(baseUrl, "practicepanther", token, "tools/list");
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.result.tools, []);
  });
  assert.deepEqual(toolRefreshes, [connector.id]);
});

test("a denied tool call is answered as a tool error, never sent upstream, and audited", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({
    DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
    DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on",
  });
  const token = await enroll(db, "user-1", GARRETT);
  const connector = connectPracticePanther(db, "user-1");
  const tokenId = db.table("docket_agent_tokens")[0].id;

  const denied: Array<[string, string]> = [
    ["Invoices_GetInvoices", "admin_only"],
    ["Tasks_Delete", "delete_denied"],
    ["Tasks_Delete_2", "delete_denied"],
    ["Totally_Unknown_Tool", "unknown_tool"],
    ["pp_api_request", "raw_api_denied"],
    // A message to a contact (K3).
    ["Messages_PostMessage", "send_denied"],
    // A money record, for a non-admin.
    ["Expenses_PostAccount", "admin_only"],
  ];

  await withApp(app, async (baseUrl) => {
    for (const [name, reason] of denied) {
      const before = auditRows(db).length;
      const answer = await rpc(baseUrl, "practicepanther", token, "tools/call", {
        name,
        // Not "abc": a random row id can hold those letters by chance.
        arguments: { id: "argument-canary-xyz", method: "DELETE" },
      });
      assert.equal(answer.status, 200, name);
      assert.deepEqual(answer.json.result, {
        isError: true,
        content: [{ type: "text", text: "This tool is not available to Docket Agent." }],
      });

      const rows = auditRows(db).slice(before);
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0].origin, "docket_agent");
      assert.equal(rows[0].actor_email, GARRETT);
      assert.equal(rows[0].agent_token_id, tokenId);
      assert.equal(rows[0].user_id, "user-1");
      assert.equal(rows[0].connector_id, connector.id);
      assert.equal(rows[0].tool_name, name);
      assert.equal(rows[0].status, "error");
      assert.equal(rows[0].error_message, `Denied by Docket Agent gateway: ${reason}`);
      // No arguments are stored.
      assert.ok(!JSON.stringify(rows[0]).includes("argument-canary"));
    }

    // With writes off, a write tool is denied the same way.
    setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
    const off = await rpc(baseUrl, "practicepanther", token, "tools/call", {
      name: "Tasks_PostTask",
      arguments: { subject: "Call client" },
    });
    assert.equal(off.json.result.isError, true);
    assert.equal(auditRows(db).at(-1)!.error_message, "Denied by Docket Agent gateway: writes_off");
    assert.equal(auditRows(db).at(-1)!.action_kind, "mutation");
  });
  assert.equal(upstream.connectors.length, 0);
  assert.equal(upstream.calls.length, 0);
});

test("a read goes upstream once, comes back unchanged, and leaves one audit row", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  const connector = connectPracticePanther(db, "user-1");
  const tokenId = db.table("docket_agent_tokens")[0].id;
  const upstreamResult = {
    content: [{ type: "text", text: '{"tasks":[{"id":"t1"}]}' }],
    structuredContent: { tasks: [{ id: "t1" }] },
  };
  upstream.state.respond = () => upstreamResult;
  const args = { matter_id: "m-42", status: "NotCompleted", nested: { keep: [1, 2] } };

  await withApp(app, async (baseUrl) => {
    const answer = await rpc(baseUrl, "practicepanther", token, "tools/call", {
      name: "Tasks_GetTasks",
      arguments: args,
    });
    assert.equal(answer.status, 200);
    assert.match(answer.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(answer.json.result, upstreamResult);
    assertNoStore(answer);

    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].name, "Tasks_GetTasks");
    assert.deepEqual(upstream.calls[0].args, args);
    assert.equal(upstream.calls[0].connector.id, connector.id);

    assert.equal(auditRows(db).length, 1);
    const row = auditRows(db)[0];
    assert.equal(row.status, "ok");
    assert.equal(row.action_kind, "read");
    assert.equal(row.origin, "docket_agent");
    assert.equal(row.agent_token_id, tokenId);
    assert.equal(row.actor_email, GARRETT);
    assert.equal(row.user_id, "user-1");
    assert.equal(row.connector_id, connector.id);
    // Arguments and results are not stored.
    assert.ok(!JSON.stringify(row).includes("m-42"));
    assert.ok(!JSON.stringify(row).includes("t1"));

    // An upstream tool error is passed on as it is.
    const failure = { isError: true, content: [{ type: "text", text: "Matter not found." }] };
    upstream.state.respond = () => failure;
    const failed = await rpc(baseUrl, "practicepanther", token, "tools/call", {
      name: "Tasks_GetTask",
      arguments: { id: "nope" },
    });
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.json.result, failure);
    assert.equal(auditRows(db).length, 2);
    assert.equal(auditRows(db)[1].status, "error");
    assert.equal(auditRows(db)[1].origin, "docket_agent");
  });
});

test("with writes on, a task is created only after a pending audit row exists", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({
    DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
    DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on",
  });
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");
  const tokenId = db.table("docket_agent_tokens")[0].id;
  const created = { content: [{ type: "text", text: '{"id":"task-9"}' }] };
  upstream.state.respond = () => created;
  const args = { subject: "Call client", tags: ["Urgent"], matter_ref: { id: "m-42" } };

  await withApp(app, async (baseUrl) => {
    db.events.length = 0;
    const answer = await rpc(baseUrl, "practicepanther", token, "tools/call", {
      name: "Tasks_PostTask",
      arguments: args,
    });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json.result, created);
  });

  // Order: pending audit row, then the upstream call, then the row is closed.
  assert.deepEqual(
    db.events.filter(
      (event) => event.startsWith("upstream:") || event.includes("user_mcp_tool_audit_logs"),
    ),
    [
      "db:insert:user_mcp_tool_audit_logs:pending",
      "upstream:Tasks_PostTask",
      "db:update:user_mcp_tool_audit_logs:ok",
    ],
  );
  // It ran on the row Docket itself manages for him (the one chat uses) ...
  assert.deepEqual(upstream.calls[0].connector.tool_policy, {
    managedBy: "backend",
    managedConnector: "practicepanther",
  });
  // ... and still: arguments reach PracticePanther exactly as sent, with no
  // actor tag added,
  assert.equal(upstream.calls.length, 1);
  assert.deepEqual(upstream.calls[0].args, args);
  // and no Docket audit note is posted into PracticePanther.
  assert.ok(!upstream.calls.some((call) => call.name === "Notes_PostNote"));

  assert.equal(auditRows(db).length, 1);
  const row = auditRows(db)[0];
  assert.equal(row.status, "ok");
  assert.equal(row.action_kind, "mutation");
  assert.equal(row.actor_email, GARRETT);
  assert.equal(row.origin, "docket_agent");
  assert.equal(row.agent_token_id, tokenId);
  assert.equal(row.practicepanther_audit_status, "not_required");
});

test("with writes on, a change is not sent when the audit row cannot be written", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({
    DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
    DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on",
  });
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");
  db.failOn("user_mcp_tool_audit_logs", "insert");

  await withApp(app, async (baseUrl) => {
    const answer = await rpc(baseUrl, "practicepanther", token, "tools/call", {
      name: "Tasks_PutTask_2",
      arguments: { id: "task-9", subject: "Changed" },
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.json.result.isError, true);
    assert.match(answer.json.result.content[0].text, /could not create the required actor audit record/);
  });
  assert.equal(upstream.calls.length, 0);
  assert.equal(auditRows(db).length, 0);
});

test("a lost answer on a change is reported as uncertain", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({
    DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
    DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on",
  });
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");
  upstream.state.respond = () => {
    // A stray secret in an upstream error must not reach the caller.
    throw new Error(`socket closed; echo ${token}; access_token=${FAKE_UPSTREAM_ACCESS_TOKEN}`);
  };

  await withApp(app, async (baseUrl) => {
    const answer = await rpc(baseUrl, "practicepanther", token, "tools/call", {
      name: "Notes_PostNote",
      arguments: { subject: "Note" },
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.json.result.isError, true);
    const text = answer.json.result.content[0].text as string;
    assert.match(text, /The outcome is uncertain\. Check the record before trying again\.$/);
    assert.ok(!text.includes(token));
    assert.ok(!text.includes(FAKE_UPSTREAM_ACCESS_TOKEN));
  });
  assert.equal(auditRows(db).length, 1);
  assert.equal(auditRows(db)[0].status, "error");
  assert.equal(auditRows(db)[0].origin, "docket_agent");
});

test("a connection that cannot be opened is a tool error with a fixed message and an audit row", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");

  await withApp(app, async (baseUrl) => {
    upstream.state.connectError = new Error(
      `connect failed: authorization: Bearer ${FAKE_UPSTREAM_ACCESS_TOKEN}`,
    );
    const unreachable = await rpc(baseUrl, "practicepanther", token, "tools/call", {
      name: "Tasks_GetTasks",
      arguments: {},
    });
    assert.equal(unreachable.status, 200);
    assert.deepEqual(unreachable.json.result, {
      isError: true,
      content: [{ type: "text", text: "The PracticePanther service could not be reached." }],
    });

    upstream.state.connectError = new McpOAuthRequiredError();
    const reconnect = await rpc(baseUrl, "practicepanther", token, "tools/call", {
      name: "Tasks_GetTasks",
      arguments: {},
    });
    assert.deepEqual(reconnect.json.result, {
      isError: true,
      content: [
        { type: "text", text: "The PracticePanther connection in Docket needs to be reconnected." },
      ],
    });
  });
  assert.equal(upstream.calls.length, 0);
  const rows = auditRows(db);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, "error");
    assert.equal(row.origin, "docket_agent");
    assert.equal(row.actor_email, GARRETT);
    assert.equal(row.action_kind, "read");
  }
  // The failure was logged, with the secret taken out.
  assert.ok(capturedLogs.some((line) => line.includes("[agent-gateway] upstream call failed")));
});

test("upstream only ever receives the connector row of the token's user", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const tokenA = await enroll(db, "user-a", GARRETT);
  const tokenB = await enroll(db, "user-b", JERAD);
  const rowA = connectPracticePanther(db, "user-a");
  const rowB = connectPracticePanther(db, "user-b");
  const boxB = seedManagedBoxConnector(db, "user-b");
  seedOAuthToken(db, boxB.id, { expiresAt: iso(30 * MINUTE) });
  seedTool(db, boxB.id, "search_files_keyword");

  await withApp(app, async (baseUrl) => {
    for (let i = 0; i < 3; i += 1) {
      await rpc(baseUrl, "practicepanther", tokenA, "tools/call", { name: "Tasks_GetTasks", arguments: {} });
      await rpc(baseUrl, "practicepanther", tokenB, "tools/call", { name: "Tasks_GetTasks", arguments: {} });
    }
    // B's Box works. A has no Box row and must not get B's.
    const boxOk = await rpc(baseUrl, "box", tokenB, "tools/call", {
      name: "search_files_keyword",
      arguments: { query: "lease" },
    });
    assert.equal(boxOk.status, 200);
    assert.equal(boxOk.json.result.isError, undefined);
    const boxDenied = await rpc(baseUrl, "box", tokenA, "tools/call", {
      name: "search_files_keyword",
      arguments: { query: "lease" },
    });
    assert.equal(boxDenied.status, 401);
  });

  assert.equal(upstream.connectors.length, 7);
  const byUser: Record<string, Set<string>> = {};
  for (const row of auditRows(db)) {
    (byUser[row.user_id] ??= new Set()).add(row.connector_id);
  }
  assert.deepEqual([...byUser["user-a"]], [rowA.id]);
  assert.deepEqual([...byUser["user-b"]].sort(), [boxB.id, rowB.id].sort());
  // Every upstream session was opened on a row owned by the caller.
  const ownerOfToken: Record<string, string> = { [rowA.id]: "user-a", [rowB.id]: "user-b", [boxB.id]: "user-b" };
  for (const connector of upstream.connectors) {
    assert.equal(connector.user_id, ownerOfToken[connector.id]);
  }
});

test("Box through the gateway is read-only", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  const box = seedManagedBoxConnector(db, "user-1");
  seedOAuthToken(db, box.id, { expiresAt: iso(30 * MINUTE) });
  seedTool(db, box.id, "search_files_keyword");
  seedTool(db, box.id, "get_file_content");
  seedTool(db, box.id, "upload_file", { requires_confirmation: true });
  seedTool(db, box.id, "list_tasks", { enabled: false });

  await withApp(app, async (baseUrl) => {
    const list = await rpc(baseUrl, "box", token, "tools/list");
    assert.deepEqual(
      list.json.result.tools.map((tool: { name: string }) => tool.name),
      ["get_file_content", "search_files_keyword"],
    );
    const upload = await rpc(baseUrl, "box", token, "tools/call", {
      name: "upload_file",
      arguments: { name: "x.docx" },
    });
    assert.equal(upload.json.result.isError, true);
    assert.equal(
      auditRows(db).at(-1)!.error_message,
      "Denied by Docket Agent gateway: needs_approval_in_docket",
    );
    const read = await rpc(baseUrl, "box", token, "tools/call", {
      name: "get_file_content",
      arguments: { file_id: "12345" },
    });
    assert.equal(read.json.result.isError, undefined);
    assert.deepEqual(auditRows(db).at(-1)!.target_refs, { file_id: "12345" });
    assert.equal(auditRows(db).at(-1)!.origin, "docket_agent");
  });
  assert.deepEqual(upstream.calls.map((call) => call.name), ["get_file_content"]);
});

test("a Box page preview is listed and read through the gateway, with organizing off", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  const box = seedManagedBoxConnector(db, "user-1");
  seedOAuthToken(db, box.id, { expiresAt: iso(30 * MINUTE) });
  // Docket chat asks the user before it runs this tool; that flag is chat's.
  seedTool(db, box.id, "get_preview_page", { requires_confirmation: true });

  await withApp(app, async (baseUrl) => {
    const list = await rpc(baseUrl, "box", token, "tools/list");
    assert.deepEqual(
      list.json.result.tools.map((tool: { name: string }) => tool.name),
      ["get_preview_page"],
    );
    const read = await rpc(baseUrl, "box", token, "tools/call", {
      name: "get_preview_page",
      arguments: { file_id: "12345" },
    });
    assert.equal(read.json.result.isError, undefined);
    const row = auditRows(db).at(-1)!;
    // Docket's own audit writer records any Box tool outside chat's read
    // list as a change (servers.ts), so the row is written as pending before
    // the call. Stricter than needed for a read, and not the gateway's to
    // change.
    assert.equal(row.action_kind, "mutation");
    assert.equal(row.status, "ok");
    assert.equal(row.origin, "docket_agent");
  });
  assert.deepEqual(upstream.calls.map((call) => call.name), ["get_preview_page"]);
});

test("a sign-in near expiry is refreshed before the call, once", async () => {
  const { app, db, refreshed } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  const connector = seedPerUserPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, connector.id, { expiresAt: iso(2 * MINUTE) });
  seedTool(db, connector.id, "Tasks_GetTasks");

  await withApp(app, async (baseUrl) => {
    const answers = await Promise.all(
      Array.from({ length: 5 }, () =>
        rpc(baseUrl, "practicepanther", token, "tools/call", { name: "Tasks_GetTasks", arguments: {} }),
      ),
    );
    for (const answer of answers) assert.equal(answer.status, 200);
  });
  assert.deepEqual(refreshed, [connector.id]);
});

test("a body over 1 MB is 413 and broken JSON is 400, both only after the token is checked", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const big = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "Tasks_GetTasks", arguments: { filler: "x".repeat(1_100_000) } },
  });

  await withApp(app, async (baseUrl) => {
    const tooLarge = await request(`${baseUrl}/agent-mcp/practicepanther`, {
      method: "POST",
      headers: { ...headers, ...bearer(token) },
      body: big,
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(tooLarge.json, { error: "payload_too_large" });

    const broken = await request(`${baseUrl}/agent-mcp/practicepanther`, {
      method: "POST",
      headers: { ...headers, ...bearer(token) },
      body: '{"jsonrpc": "2.0", "id": 1, "method": ',
    });
    assert.equal(broken.status, 400);
    assert.deepEqual(broken.json, { error: "invalid_json" });

    // Without a token the body is never parsed: 401, not 400.
    const anonymous = await request(`${baseUrl}/agent-mcp/practicepanther`, {
      method: "POST",
      headers,
      body: '{"broken": ',
    });
    assert.equal(anonymous.status, 401);

    const opsBroken = await ops(baseUrl, "/tokens", { method: "POST", body: '{"email": ' });
    assert.equal(opsBroken.status, 400);
    assert.deepEqual(opsBroken.json, { error: "invalid_json" });
    const opsLarge = await ops(baseUrl, "/provision", {
      method: "POST",
      body: JSON.stringify({ email: GARRETT, filler: "x".repeat(20_000) }),
    });
    assert.equal(opsLarge.status, 413);
  });
  assert.equal(upstream.calls.length, 0);
});

test("each agent token has its own request budget", async () => {
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, RATE_LIMIT_AGENT_MCP_MAX: "2" });
  const { app, db } = setup();
  const tokenA = await enroll(db, "user-a", GARRETT);
  const tokenB = await enroll(db, "user-b", JERAD);
  connectPracticePanther(db, "user-a");
  connectPracticePanther(db, "user-b");

  await withApp(app, async (baseUrl) => {
    assert.equal((await rpc(baseUrl, "practicepanther", tokenA, "tools/list")).status, 200);
    assert.equal((await rpc(baseUrl, "practicepanther", tokenA, "tools/list")).status, 200);
    const limited = await rpc(baseUrl, "practicepanther", tokenA, "tools/list");
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json, { error: "rate_limited" });
    // Another user's token is not affected.
    assert.equal((await rpc(baseUrl, "practicepanther", tokenB, "tools/list")).status, 200);
  });
});

test("minting returns the token once; status then shows the user as enabled", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  seedUser(db, { id: "user-1", email: GARRETT });
  connectPracticePanther(db, "user-1");

  await withApp(app, async (baseUrl) => {
    const before = await ops(baseUrl, `/status?email=${GARRETT}`);
    assert.equal(before.json.users[0].agent_enabled, false);

    // The mint answer is the one body that may hold a token.
    const minted = await ops(baseUrl, "/tokens", {
      method: "POST",
      body: JSON.stringify({ email: "  Garrett.Lewis@PodlaskiLegal.com " }),
      record: false,
    });
    assert.equal(minted.status, 201);
    assert.deepEqual(Object.keys(minted.json).sort(), ["created_at", "email", "file_token", "token"]);
    assert.match(minted.json.token, /^dka_[A-Za-z0-9_-]{43}$/);
    assert.equal(minted.json.email, GARRETT);
    assert.ok(!Number.isNaN(Date.parse(minted.json.created_at)));
    assertNoStore(minted);
    const firstToken = minted.json.token as string;
    mintedTokens.push(firstToken);

    const status = await ops(baseUrl, "/status");
    assert.deepEqual(status.json, {
      users: [
        {
          email: GARRETT,
          agent_enabled: true,
          role: "user",
          sources: {
            practicepanther: { state: "connected" },
            box: { state: "not_connected", detail: "no_connector" },
            quo: { state: "not_connected", detail: "source_disabled" },
          },
        },
      ],
      problems: [],
      practicepanther_writes: "off",
      box_files: { download: true, upload: false },
      box_organize: "off",
    });
    assert.equal((await rpc(baseUrl, "practicepanther", firstToken, "tools/list")).status, 200);

    // Minting again rotates: the first token stops working.
    const rotated = await ops(baseUrl, "/tokens", {
      method: "POST",
      body: JSON.stringify({ email: GARRETT }),
      record: false,
    });
    assert.equal(rotated.status, 201);
    mintedTokens.push(rotated.json.token);
    assert.notEqual(rotated.json.token, firstToken);
    assert.equal((await rpc(baseUrl, "practicepanther", firstToken, "tools/list")).status, 401);
    assert.equal((await rpc(baseUrl, "practicepanther", rotated.json.token, "tools/list")).status, 200);

    // Revoke.
    const revoked = await ops(baseUrl, `/tokens?email=${GARRETT}`, { method: "DELETE" });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.json, { email: GARRETT, revoked: 1 });
    assert.equal((await rpc(baseUrl, "practicepanther", rotated.json.token, "tools/list")).status, 401);
    const again = await ops(baseUrl, `/tokens?email=${GARRETT}`, { method: "DELETE" });
    assert.deepEqual(again.json, { email: GARRETT, revoked: 0 });
    // The connector row and the user's sign-in are left alone.
    assert.equal(db.table("user_mcp_connectors").length, 1);
    assert.equal(db.table("user_mcp_oauth_tokens").length, 1);
  });

  // Only hashes were stored.
  for (const token of mintedTokens) {
    assert.ok(!JSON.stringify(db.tables).includes(token));
  }
});

test("ops calls refuse bad, outside, unknown and ambiguous emails", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  seedUser(db, { id: "twin-1", email: "twin@podlaskilegal.com" });
  seedUser(db, { id: "twin-2", email: "twin@podlaskilegal.com" });
  seedUser(db, { id: "outside", email: "someone@example.com" });
  seedUser(db, { id: "gone", email: "gone@podlaskilegal.com", status: "deleted" });
  seedUser(db, {
    id: "partner",
    email: "a.partner@podlaskilegal.com",
    role: "admin",
    allowed: false,
  });

  const cases: Array<[unknown, number, string]> = [
    [undefined, 400, "invalid_email"],
    ["", 400, "invalid_email"],
    ["not-an-email", 400, "invalid_email"],
    [{ nested: "x" }, 400, "invalid_email"],
    ["someone@example.com", 400, "email_domain_not_allowed"],
    // On the allowed list, but never signed in to Docket.
    ["nobody@podlaskilegal.com", 404, "unknown_user"],
    ["gone@podlaskilegal.com", 404, "unknown_user"],
    ["twin@podlaskilegal.com", 409, "ambiguous_user"],
    // A real, active Docket user who is not on the allowed list.
    ["a.partner@podlaskilegal.com", 403, "email_not_allowed"],
  ];
  allowAgentEmails("nobody@podlaskilegal.com");
  await withApp(app, async (baseUrl) => {
    for (const [email, status, error] of cases) {
      for (const path of ["/tokens", "/provision"]) {
        const answer = await ops(baseUrl, path, {
          method: "POST",
          body: JSON.stringify(email === undefined ? {} : { email }),
        });
        assert.equal(answer.status, status, `${path} ${String(email)}`);
        assert.deepEqual(answer.json, { error });
      }
    }
    const del = await ops(baseUrl, "/tokens?email=nobody@podlaskilegal.com", { method: "DELETE" });
    assert.equal(del.status, 404);
    const noEmail = await ops(baseUrl, "/tokens", { method: "DELETE" });
    assert.equal(noEmail.status, 400);

    const many = Array.from({ length: 51 }, (_, i) => `email=u${i}@podlaskilegal.com`).join("&");
    assert.equal((await ops(baseUrl, `/status?${many}`)).status, 400);
  });
  assert.equal(db.table("docket_agent_tokens").length, 0);
  assert.equal(db.table("user_mcp_connectors").length, 0);
});

test("a rotation conflict answers 409", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  seedUser(db, { id: "user-1", email: GARRETT });
  db.failOn("docket_agent_tokens", "insert");

  await withApp(app, async (baseUrl) => {
    const answer = await ops(baseUrl, "/tokens", {
      method: "POST",
      body: JSON.stringify({ email: GARRETT }),
    });
    assert.equal(answer.status, 409);
    assert.deepEqual(answer.json, { error: "token_rotation_conflict" });
  });
});

test("provisioning over HTTP reports each source and makes no PracticePanther or Box row", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  seedUser(db, { id: "user-1", email: GARRETT });
  // He has not opened Docket since per-user sign-in was switched on.
  seedLegacySharedPracticePantherConnector(db, "user-1");
  const box = seedManagedBoxConnector(db, "user-1");
  seedOAuthToken(db, box.id, { expiresAt: iso(30 * MINUTE) });
  const rowsBefore = JSON.stringify(db.table("user_mcp_connectors"));

  await withApp(app, async (baseUrl) => {
    const first = await ops(baseUrl, "/provision", {
      method: "POST",
      body: JSON.stringify({ email: GARRETT }),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, {
      email: GARRETT,
      sources: {
        practicepanther: { connector: "missing", state: "not_connected" },
        box: { connector: "managed", state: "connected" },
        quo: { connector: "not_configured", state: "not_connected" },
      },
    });
    assert.equal(JSON.stringify(db.table("user_mcp_connectors")), rowsBefore);

    // He opens Docket (Docket makes his row) and connects PracticePanther
    // there, the normal way. Nothing more is needed.
    const own = seedPerUserPracticePantherConnector(db, "user-1");
    const second = await ops(baseUrl, "/provision", {
      method: "POST",
      body: JSON.stringify({ email: GARRETT }),
    });
    assert.deepEqual(second.json.sources.practicepanther, {
      connector: "managed",
      state: "not_connected",
    });
    seedOAuthToken(db, own.id, { expiresAt: iso(30 * MINUTE) });
    const third = await ops(baseUrl, "/provision", {
      method: "POST",
      body: JSON.stringify({ email: GARRETT }),
    });
    assert.deepEqual(third.json.sources.practicepanther, {
      connector: "managed",
      state: "connected",
    });

    // Docket itself still on the old shared connector: the source is off.
    setGatewayEnv({
      DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
      PRACTICEPANTHER_USER_MCP_SERVER_URL: "",
    });
    const off = await ops(baseUrl, "/provision", {
      method: "POST",
      body: JSON.stringify({ email: GARRETT }),
    });
    assert.deepEqual(off.json.sources.practicepanther, {
      connector: "disabled",
      state: "not_connected",
    });
  });

  // Three rows: the two that were there and the one Docket made. The
  // gateway wrote none, and none carries a Docket Agent mark or name.
  const rows = db.table("user_mcp_connectors");
  assert.equal(rows.length, 3);
  assert.equal(JSON.stringify(rows.slice(0, 2)), rowsBefore);
  for (const row of rows) {
    assert.equal("docketAgentSource" in (row.tool_policy ?? {}), false);
    assert.doesNotMatch(String(row.name), /Docket Agent/);
  }
});

test("status with keepalive refreshes sign-ins that are near expiry", async () => {
  const { app, db, refreshed } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  await enroll(db, "user-1", GARRETT);
  const connector = seedPerUserPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, connector.id, { expiresAt: iso(10 * MINUTE) });

  await withApp(app, async (baseUrl) => {
    const plain = await ops(baseUrl, "/status");
    assert.equal(plain.json.users[0].sources.practicepanther.state, "connected");
    assert.equal(refreshed.length, 0);

    const kept = await ops(baseUrl, "/status?keepalive=1");
    assert.equal(kept.json.users[0].sources.practicepanther.state, "connected");
    assert.deepEqual(refreshed, [connector.id]);

    await ops(baseUrl, "/status?keepalive=1");
    assert.equal(refreshed.length, 1);
  });
});

test("status reads a long list of emails: 50 are answered, 51 are refused", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  // No agent tokens: a user is in the answer only because he was named.
  seedUser(db, { id: "user-1", email: GARRETT });
  seedUser(db, { id: "user-2", email: JERAD });
  const query = (count: number) =>
    [GARRETT, JERAD]
      .concat(
        Array.from({ length: count - 2 }, (_, i) => `nobody${i}@podlaskilegal.com`),
      )
      .map((email) => `email=${encodeURIComponent(email)}`)
      .join("&");

  await withApp(app, async (baseUrl) => {
    // More than 20 repeated values reach Express as an object, not an array.
    for (const count of [2, 20, 21, 50]) {
      const answer = await ops(baseUrl, `/status?${query(count)}&keepalive=1`);
      assert.equal(answer.status, 200, `${count} emails`);
      assert.deepEqual(
        answer.json.users.map((user: { email: string }) => user.email),
        [GARRETT, JERAD],
        `${count} emails`,
      );
      assert.equal(answer.json.problems.length, count - 2, `${count} emails`);
    }
    const tooMany = await ops(baseUrl, `/status?${query(51)}`);
    assert.equal(tooMany.status, 400);
    assert.deepEqual(tooMany.json, { error: "too_many_emails" });
  });
});

test("an unexpected failure answers 500 with a fixed body", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");
  db.failOn("docket_agent_tokens", "select");

  await withApp(app, async (baseUrl) => {
    const answer = await rpc(baseUrl, "practicepanther", token, "tools/list");
    assert.equal(answer.status, 500);
    assert.deepEqual(answer.json, { error: "internal_error" });
    assertNoStore(answer);
  });
});

// One real process, no database: the mount in src/index.ts behaves the same.
const backendRoot = new URL("..", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Who Docket Agent may act for, and what each secret can do.
// ---------------------------------------------------------------------------

const PARTNER = "a.partner@podlaskilegal.com";

test("the ops token cannot mint a token for a Docket user who is not on the allowed list", async () => {
  // A partner (a Docket admin) who never asked for Docket Agent. He only
  // has the Box row Docket chat keeps connected for every user. Before the
  // list existed, the ops token alone got a token for him and read his Box.
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  seedUser(db, { id: "partner", email: PARTNER, role: "admin", allowed: false });
  const box = seedManagedBoxConnector(db, "partner");
  seedOAuthToken(db, box.id, { expiresAt: iso(30 * MINUTE) });
  seedTool(db, box.id, "search_files_keyword");

  await withApp(app, async (baseUrl) => {
    const minted = await ops(baseUrl, "/tokens", {
      method: "POST",
      body: JSON.stringify({ email: PARTNER }),
    });
    assert.equal(minted.status, 403);
    assert.deepEqual(minted.json, { error: "email_not_allowed" });
    const provisioned = await ops(baseUrl, "/provision", {
      method: "POST",
      body: JSON.stringify({ email: PARTNER }),
    });
    assert.equal(provisioned.status, 403);
    const revoked = await ops(baseUrl, `/tokens?email=${PARTNER}`, { method: "DELETE" });
    assert.equal(revoked.status, 403);
    const status = await ops(baseUrl, `/status?email=${PARTNER}&keepalive=1`);
    assert.deepEqual(status.json.users, []);
    assert.deepEqual(status.json.problems, [{ email: PARTNER, error: "email_not_allowed" }]);
  });
  assert.equal(db.table("docket_agent_tokens").length, 0);
  assert.equal(db.table("user_mcp_connectors").length, 1, "no row was made for him");
  assert.equal(upstream.calls.length, 0);
});

test("with no allowed list set, nobody can be enrolled", async () => {
  const { app, db } = setup();
  seedUser(db, { id: "user-1", email: GARRETT });
  for (const value of [undefined, "", " , "]) {
    setGatewayEnv({
      DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
      ...(value === undefined ? {} : { DOCKET_AGENT_ALLOWED_EMAILS: value }),
    });
    if (value === undefined) delete process.env.DOCKET_AGENT_ALLOWED_EMAILS;
    await withApp(app, async (baseUrl) => {
      const minted = await ops(baseUrl, "/tokens", {
        method: "POST",
        body: JSON.stringify({ email: GARRETT }),
      });
      assert.equal(minted.status, 403, String(value));
      assert.deepEqual(minted.json, { error: "email_not_allowed" });
    });
  }
  assert.equal(db.table("docket_agent_tokens").length, 0);
});

test("a token stops working the moment its user is taken off the allowed list", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  const other = await enroll(db, "user-2", JERAD);
  connectPracticePanther(db, "user-1");
  connectPracticePanther(db, "user-2");

  await withApp(app, async (baseUrl) => {
    assert.equal((await rpc(baseUrl, "practicepanther", token, "tools/list")).status, 200);

    // The operator takes garrett off the list. His token row is untouched.
    setGatewayEnv({
      DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
      DOCKET_AGENT_ALLOWED_EMAILS: ` ${JERAD.toUpperCase()} `,
    });
    const refused = await rpc(baseUrl, "practicepanther", token, "tools/call", {
      name: "Tasks_GetTasks",
      arguments: {},
    });
    assert.equal(refused.status, 401);
    assert.deepEqual(refused.json, { error: "invalid_token" });
    assert.equal(upstream.calls.length, 0);
    assert.equal(db.table("docket_agent_tokens").filter((row) => !row.revoked_at).length, 2);
    // The other user is not affected, and the list is read without regard to case.
    assert.equal((await rpc(baseUrl, "practicepanther", other, "tools/list")).status, 200);
    // He is no longer in the status answer either.
    const status = await ops(baseUrl, "/status");
    assert.deepEqual(
      status.json.users.map((user: { email: string }) => user.email),
      [JERAD],
    );
  });
});

test("the status token reads the status and can do nothing else", async () => {
  const { app, db } = setup();
  setGatewayEnv({
    DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
    DOCKET_AGENT_STATUS_TOKEN: TEST_STATUS_TOKEN,
  });
  const agentToken = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");
  const liveBefore = db.table("docket_agent_tokens").length;

  await withApp(app, async (baseUrl) => {
    const status = await ops(baseUrl, `/status?email=${GARRETT}&keepalive=1`, {
      token: TEST_STATUS_TOKEN,
    });
    assert.equal(status.status, 200);
    assert.equal(status.json.users[0].email, GARRETT);

    const refused = [
      await ops(baseUrl, "/tokens", {
        method: "POST",
        token: TEST_STATUS_TOKEN,
        body: JSON.stringify({ email: GARRETT }),
      }),
      await ops(baseUrl, `/tokens?email=${GARRETT}`, { method: "DELETE", token: TEST_STATUS_TOKEN }),
      await ops(baseUrl, "/provision", {
        method: "POST",
        token: TEST_STATUS_TOKEN,
        body: JSON.stringify({ email: GARRETT }),
      }),
      // Not the status route by another method or a longer path.
      await ops(baseUrl, "/status", { method: "POST", token: TEST_STATUS_TOKEN, body: "{}" }),
      await ops(baseUrl, "/status/tokens", { token: TEST_STATUS_TOKEN }),
    ];
    for (const answer of refused) {
      assert.equal(answer.status, 401);
      assert.deepEqual(answer.json, { error: "invalid_ops_token" });
    }
    // It is not an agent token either.
    assert.equal((await rpc(baseUrl, "practicepanther", TEST_STATUS_TOKEN, "tools/list")).status, 401);
    // The ops token still reads the status, and the agent token never does.
    assert.equal((await ops(baseUrl, "/status")).status, 200);
    assert.equal((await ops(baseUrl, "/status", { token: agentToken })).status, 401);

    // With no status token set, that value opens nothing.
    setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
    assert.equal((await ops(baseUrl, "/status", { token: TEST_STATUS_TOKEN })).status, 401);
    // A status token that is too short is no token.
    setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, DOCKET_AGENT_STATUS_TOKEN: "short" });
    assert.equal((await ops(baseUrl, "/status", { token: "short" })).status, 401);
  });
  // Nothing was minted, revoked or made.
  assert.equal(db.table("docket_agent_tokens").length, liveBefore);
  assert.equal(db.table("docket_agent_tokens")[0].revoked_at, null);
});

test("with the gateway off, the status token opens nothing", async () => {
  const { app } = setup();
  setGatewayEnv({ DOCKET_AGENT_STATUS_TOKEN: TEST_STATUS_TOKEN });
  await withApp(app, async (baseUrl) => {
    const answer = await ops(baseUrl, "/status", { token: TEST_STATUS_TOKEN });
    assert.equal(answer.status, 503);
  });
});

test("every mint, revoke and provision leaves one log line, without the token", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  seedUser(db, { id: "user-1", email: GARRETT });
  const before = capturedLogs.length;

  await withApp(app, async (baseUrl) => {
    const minted = await ops(baseUrl, "/tokens", {
      method: "POST",
      body: JSON.stringify({ email: GARRETT }),
      record: false,
    });
    mintedTokens.push(minted.json.token);
    await ops(baseUrl, "/provision", { method: "POST", body: JSON.stringify({ email: GARRETT }) });
    await ops(baseUrl, `/tokens?email=${GARRETT}`, { method: "DELETE" });
    // A refused call logs no action.
    await ops(baseUrl, "/tokens", { method: "POST", body: JSON.stringify({ email: PARTNER }) });
    await ops(baseUrl, "/status");
  });
  const lines = capturedLogs.slice(before).filter((line) => line.includes("ops action"));
  assert.equal(lines.length, 3);
  for (const [index, action] of ["mint", "provision", "revoke"].entries()) {
    assert.ok(lines[index].includes(`action: '${action}'`), lines[index]);
    assert.ok(lines[index].includes(GARRETT));
    assert.ok(lines[index].includes("at: '2026-10-01T12:00:00.000Z'"));
    assert.ok(/ip: '[^']+'/.test(lines[index]));
    assert.ok(!lines[index].includes("dka_"));
  }
});

// ---------------------------------------------------------------------------
// The rate limits on the MCP route.
// ---------------------------------------------------------------------------

function tokenLookups(db: FakeDb): number {
  return db.calls.filter((call) => call.table === "docket_agent_tokens" && call.op === "select").length;
}

test("a caller who sends a new made-up bearer on every request is limited by address", async () => {
  // Before: the limiter key was the header text, so forty different
  // bearers got forty 401s, no 429, and forty database lookups.
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, RATE_LIMIT_AGENT_MCP_UNAUTH_MAX: "2" });
  const { app, db } = setup();
  const before = tokenLookups(db);

  await withApp(app, async (baseUrl) => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const answer = await rpc(baseUrl, "practicepanther", generateAgentToken(), "tools/list");
      statuses.push(answer.status);
    }
    assert.deepEqual(statuses.slice(0, 2), [401, 401]);
    assert.ok(statuses.slice(2).every((status) => status === 429), statuses.join(","));
    // No bearer at all, a bearer of the wrong shape, an unknown source and
    // a wrong method count against the same budget.
    assert.equal((await rpc(baseUrl, "practicepanther", null, "tools/list")).status, 429);
    assert.equal((await rpc(baseUrl, "practicepanther", "x", "tools/list")).status, 429);
    assert.equal((await rpc(baseUrl, "nonsense", null, "tools/list")).status, 429);
    assert.equal((await request(`${baseUrl}/agent-mcp/practicepanther`)).status, 429);
  });
  // The database was asked twice, not forty times.
  assert.equal(tokenLookups(db) - before, 2);
});

test("a flood of bad bearers from the same address does not lock a working token out", async () => {
  // Docket Agent sessions share outbound addresses with strangers.
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, RATE_LIMIT_AGENT_MCP_UNAUTH_MAX: "3" });
  const { app, db } = setup();
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");

  await withApp(app, async (baseUrl) => {
    assert.equal((await rpc(baseUrl, "practicepanther", token, "tools/list")).status, 200);
    for (let i = 0; i < 10; i += 1) {
      await rpc(baseUrl, "practicepanther", generateAgentToken(), "tools/list");
    }
    assert.equal((await rpc(baseUrl, "practicepanther", generateAgentToken(), "tools/list")).status, 429);
    // The working token still gets through, many times over.
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await rpc(baseUrl, "practicepanther", token, "tools/list")).status, 200);
    }
  });
});

test("requests with a valid token do not use up the address budget", async () => {
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, RATE_LIMIT_AGENT_MCP_UNAUTH_MAX: "2" });
  const { app, db } = setup();
  const tokenA = await enroll(db, "user-a", GARRETT);
  const tokenB = await enroll(db, "user-b", JERAD);
  connectPracticePanther(db, "user-a");
  // user-b has no PracticePanther connection: his calls answer 401
  // source_not_connected. That is a known token, not a stranger.
  await withApp(app, async (baseUrl) => {
    for (let i = 0; i < 6; i += 1) {
      assert.equal((await rpc(baseUrl, "practicepanther", tokenA, "tools/list")).status, 200);
      const notConnected = await rpc(baseUrl, "practicepanther", tokenB, "tools/list");
      assert.equal(notConnected.status, 401);
      assert.equal(notConnected.json.error, "source_not_connected");
    }
    // The address budget is still whole: two bad bearers get 401, not 429.
    assert.equal((await rpc(baseUrl, "practicepanther", generateAgentToken(), "tools/list")).status, 401);
    assert.equal((await rpc(baseUrl, "practicepanther", generateAgentToken(), "tools/list")).status, 401);
    assert.equal((await rpc(baseUrl, "practicepanther", generateAgentToken(), "tools/list")).status, 429);
  });
});

test("a revoked token is refused at once, though it was valid a moment ago", async () => {
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, RATE_LIMIT_AGENT_MCP_UNAUTH_MAX: "2" });
  const { app, db } = setup();
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");

  await withApp(app, async (baseUrl) => {
    assert.equal((await rpc(baseUrl, "practicepanther", token, "tools/list")).status, 200);
    await ops(baseUrl, `/tokens?email=${GARRETT}`, { method: "DELETE" });
    // Skipping the address limit never skips the database check.
    assert.equal((await rpc(baseUrl, "practicepanther", token, "tools/list")).status, 401);
    // And from then on it counts against the address like any bad bearer.
    assert.equal((await rpc(baseUrl, "practicepanther", token, "tools/list")).status, 401);
    assert.equal((await rpc(baseUrl, "practicepanther", token, "tools/list")).status, 401);
    assert.equal((await rpc(baseUrl, "practicepanther", token, "tools/list")).status, 429);
  });
});

test("one token has one budget, however its header is spelled", async () => {
  // Before: "Bearer x", "bearer x", "BEARER x" and "Bearer  x" were four
  // limiter keys, so a token holder could multiply his budget.
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, RATE_LIMIT_AGENT_MCP_MAX: "2" });
  const { app, db } = setup();
  const token = await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");
  const call = (baseUrl: string, authorization: string) =>
    request(`${baseUrl}/agent-mcp/practicepanther`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: authorization,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method: "tools/list", params: {} }),
    });

  await withApp(app, async (baseUrl) => {
    assert.equal((await call(baseUrl, `Bearer ${token}`)).status, 200);
    assert.equal((await call(baseUrl, `Bearer ${token}`)).status, 200);
    for (const spelling of [
      `Bearer ${token}`,
      `bearer ${token}`,
      `BEARER ${token}`,
      `bEarer ${token}`,
      `Bearer  ${token}`,
      `Bearer\t${token}`,
      `Bearer ${token} `,
    ]) {
      const answer = await call(baseUrl, spelling);
      assert.equal(answer.status, 429, JSON.stringify(spelling));
      assert.deepEqual(answer.json, { error: "rate_limited" });
    }
  });
});

// ---------------------------------------------------------------------------
// Which account is signed in behind a connection.
// ---------------------------------------------------------------------------

test("status with keep-alive says which account is signed in behind each connected source", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  await enroll(db, "user-1", GARRETT);
  const pp = connectPracticePanther(db, "user-1");
  const box = seedManagedBoxConnector(db, "user-1");
  seedOAuthToken(db, box.id, { expiresAt: iso(30 * MINUTE) });
  const who = {
    authorized: true,
    user_id: "6e4fd2c3-fbd6-421b-9429-ad0c9c06731a",
    email: "someone@practicepanther.example",
    display_name: "A Name",
    connection_type: "individual",
  };
  upstream.state.respond = (name) =>
    name === "pp_oauth_status"
      ? { structuredContent: who, content: [{ type: "text", text: JSON.stringify(who) }] }
      : name === "who_am_i"
        ? { content: [{ type: "text", text: JSON.stringify({ user: { id: "9", login: GARRETT } }) }] }
        : { content: [{ type: "text", text: "unexpected" }] };

  await withApp(app, async (baseUrl) => {
    // Without keep-alive nothing is asked upstream.
    const plain = await ops(baseUrl, "/status");
    assert.deepEqual(plain.json.users[0].sources.practicepanther, { state: "connected" });
    assert.equal(upstream.calls.length, 0);

    const kept = await ops(baseUrl, "/status?keepalive=1");
    assert.deepEqual(kept.json.users[0].sources, {
      practicepanther: { state: "connected", identity: { user_id: who.user_id } },
      box: { state: "connected", identity: { login: GARRETT } },
      quo: { state: "not_connected", detail: "source_disabled" },
    });
    // Only the two identity tools were called, each on the user's own row.
    assert.deepEqual(
      upstream.calls.map((call) => [call.name, call.connector.id, call.connector.user_id]),
      [
        ["pp_oauth_status", pp.id, "user-1"],
        ["who_am_i", box.id, "user-1"],
      ],
    );
    // Nothing else of the upstream answer is passed on.
    assert.ok(!kept.text.includes("A Name") && !kept.text.includes("practicepanther.example"));
  });
});

test("an account that cannot be read is reported as null, never guessed", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  await enroll(db, "user-1", GARRETT);
  connectPracticePanther(db, "user-1");
  const answers: unknown[] = [
    { isError: true, content: [{ type: "text", text: "Connect your PracticePanther account first." }] },
    { content: [{ type: "text", text: "not json" }] },
    { structuredContent: { authorized: true, user_id: null } },
    { structuredContent: { authorized: true, user_id: "" } },
    { structuredContent: { result: { user_id: 7 } } },
    { content: [] },
    null,
  ];

  await withApp(app, async (baseUrl) => {
    for (const answer of answers) {
      upstream.state.respond = () => answer;
      const kept = await ops(baseUrl, "/status?keepalive=1");
      assert.deepEqual(
        kept.json.users[0].sources.practicepanther,
        { state: "connected", identity: null },
        JSON.stringify(answer),
      );
    }
    // The wrapped form some servers use is read.
    upstream.state.respond = () => ({ structuredContent: { result: { user_id: "abc-123" } } });
    const wrapped = await ops(baseUrl, "/status?keepalive=1");
    assert.deepEqual(wrapped.json.users[0].sources.practicepanther.identity, { user_id: "abc-123" });
    // The connection cannot be opened at all.
    upstream.state.connectError = new Error("connect ECONNREFUSED");
    const down = await ops(baseUrl, "/status?keepalive=1");
    assert.deepEqual(down.json.users[0].sources.practicepanther, { state: "connected", identity: null });
  });
});


// ---------------------------------------------------------------------------
// 2026-10-02: the wider PracticePanther write list, the firm's user list as
// a read, and Box organize.
// ---------------------------------------------------------------------------

const ADDED_PP_WRITES = [
  "Matters_PostMatter",
  "Matters_PutMatter",
  "Emails_PostEmail",
  "Emails_PutAccount",
  "Accounts_PostAccount",
  "Accounts_PutAccount",
  "Relationships_PostAccount",
  "Relationships_PutRelationship",
];

test("with writes on, a matter, a logged email, an account and a relationship are written after a pending audit row; with writes off, never", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  const connector = seedPerUserPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, connector.id, { expiresAt: iso(30 * MINUTE) });
  for (const name of ADDED_PP_WRITES) {
    seedTool(db, connector.id, name, { enabled: false, requires_confirmation: true });
  }
  const tokenId = db.table("docket_agent_tokens")[0].id;
  const args = { name: "argument-canary-xyz", matter_ref: { id: "m-42" } };

  await withApp(app, async (baseUrl) => {
    // Writes off: not listed, refused, nothing sent.
    const listOff = await rpc(baseUrl, "practicepanther", token, "tools/list");
    assert.deepEqual(listOff.json.result.tools, []);
    for (const name of ADDED_PP_WRITES) {
      const off = await rpc(baseUrl, "practicepanther", token, "tools/call", {
        name,
        arguments: args,
      });
      assert.equal(off.json.result.isError, true, name);
      assert.equal(
        auditRows(db).at(-1)!.error_message,
        "Denied by Docket Agent gateway: writes_off",
        name,
      );
      assert.equal(auditRows(db).at(-1)!.action_kind, "mutation", name);
    }
    assert.equal(upstream.calls.length, 0);

    // Writes on: listed, and each goes upstream once, unchanged.
    setGatewayEnv({
      DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
      DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on",
    });
    const listOn = await rpc(baseUrl, "practicepanther", token, "tools/list");
    assert.deepEqual(
      listOn.json.result.tools.map((tool: { name: string }) => tool.name),
      [...ADDED_PP_WRITES].sort(),
    );
    for (const name of ADDED_PP_WRITES) {
      const before = auditRows(db).length;
      db.events.length = 0;
      upstream.calls.length = 0;
      const created = { content: [{ type: "text", text: `{"id":"made-by-${name}"}` }] };
      upstream.state.respond = () => created;
      const answer = await rpc(baseUrl, "practicepanther", token, "tools/call", {
        name,
        arguments: args,
      });
      assert.equal(answer.status, 200, name);
      assert.deepEqual(answer.json.result, created, name);
      // Order: pending audit row, then the upstream call, then the row is closed.
      assert.deepEqual(
        db.events.filter(
          (event) => event.startsWith("upstream:") || event.includes("user_mcp_tool_audit_logs"),
        ),
        [
          "db:insert:user_mcp_tool_audit_logs:pending",
          `upstream:${name}`,
          "db:update:user_mcp_tool_audit_logs:ok",
        ],
        name,
      );
      // The arguments reach PracticePanther as sent; no audit note is posted.
      assert.equal(upstream.calls.length, 1, name);
      assert.equal(upstream.calls[0].name, name);
      assert.deepEqual(upstream.calls[0].args, args);
      assert.equal(upstream.calls[0].connector.id, connector.id);

      const rows = auditRows(db).slice(before);
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0].status, "ok");
      assert.equal(rows[0].action_kind, "mutation");
      assert.equal(rows[0].actor_email, GARRETT);
      assert.equal(rows[0].origin, "docket_agent");
      assert.equal(rows[0].agent_token_id, tokenId);
      assert.equal(rows[0].practicepanther_audit_status, "not_required");
      // No argument text is stored.
      assert.ok(!JSON.stringify(rows[0]).includes("argument-canary"), name);
    }

    // The audit row cannot be written: the change is not sent.
    upstream.calls.length = 0;
    db.failOn("user_mcp_tool_audit_logs", "insert");
    const blocked = await rpc(baseUrl, "practicepanther", token, "tools/call", {
      name: "Matters_PostMatter",
      arguments: args,
    });
    assert.equal(blocked.json.result.isError, true);
    assert.match(
      blocked.json.result.content[0].text,
      /could not create the required actor audit record/,
    );
    assert.equal(upstream.calls.length, 0);
  });
});

test("the firm's PracticePanther user list is a read for a non-admin; no other admin-only tool is", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  const connector = seedPerUserPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, connector.id, { expiresAt: iso(30 * MINUTE) });
  // Every admin-only name the connector could have, in its tool cache.
  for (const name of ADMIN_ONLY_PRACTICEPANTHER_TOOLS) {
    seedTool(db, connector.id, name, { enabled: false, requires_confirmation: true });
  }
  const staffReads = ["Users_GetUser", "Users_GetUsers", "Users_Me"];

  await withApp(app, async (baseUrl) => {
    for (const writes of ["off", "on"]) {
      setGatewayEnv({
        DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
        DOCKET_AGENT_PRACTICEPANTHER_WRITES: writes,
        DOCKET_AGENT_BOX_ORGANIZE: writes,
      });
      const list = await rpc(baseUrl, "practicepanther", token, "tools/list");
      assert.deepEqual(
        list.json.result.tools.map((tool: { name: string }) => tool.name),
        staffReads,
        `writes ${writes}`,
      );
    }
    setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });

    const staff = { content: [{ type: "text", text: '[{"id":"u-7","display_name":"Staff"}]' }] };
    upstream.state.respond = () => staff;
    for (const name of staffReads) {
      const before = auditRows(db).length;
      const answer = await rpc(baseUrl, "practicepanther", token, "tools/call", {
        name,
        arguments: name === "Users_GetUser" ? { id: "u-7" } : {},
      });
      assert.deepEqual(answer.json.result, staff, name);
      const rows = auditRows(db).slice(before);
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0].status, "ok");
      assert.equal(rows[0].action_kind, "read");
      assert.equal(rows[0].origin, "docket_agent");
      assert.equal(rows[0].actor_email, GARRETT);
    }
    assert.deepEqual(upstream.calls.map((call) => call.name), staffReads);

    // The connector's own hint wins: a tool that says it is not read-only
    // goes on record as a change.
    for (const row of db.table("user_mcp_connector_tools")) {
      if (row.tool_name === "Users_Me") row.annotations = { readOnlyHint: false };
    }
    await rpc(baseUrl, "practicepanther", token, "tools/call", { name: "Users_Me", arguments: {} });
    assert.equal(auditRows(db).at(-1)!.action_kind, "mutation");
    assert.equal(auditRows(db).at(-1)!.status, "ok");
    for (const row of db.table("user_mcp_connector_tools")) {
      if (row.tool_name === "Users_Me") row.annotations = {};
    }

    // Everything else in the admin-only group is refused and never sent.
    upstream.calls.length = 0;
    for (const name of ADMIN_ONLY_PRACTICEPANTHER_TOOLS) {
      if (staffReads.includes(name)) continue;
      const answer = await rpc(baseUrl, "practicepanther", token, "tools/call", {
        name,
        arguments: {},
      });
      assert.equal(answer.json.result.isError, true, name);
      assert.match(
        auditRows(db).at(-1)!.error_message,
        /^Denied by Docket Agent gateway: (admin_only|delete_denied|raw_api_denied)$/,
        name,
      );
    }
    assert.equal(upstream.calls.length, 0);
  });
});

const BOX_ORGANIZE_CALLS: Array<[string, Record<string, unknown>, Record<string, string>]> = [
  // tool, arguments, the ids its audit row must name
  [
    "create_folder",
    { name: "Canary Folder Name", parent_folder_id: "5001" },
    { parent_folder_id: "5001" },
  ],
  [
    "move_file",
    { file_id: "7001", parent_folder_id: "5001" },
    { file_id: "7001", parent_folder_id: "5001" },
  ],
  [
    "move_folder",
    { folder_id: "5002", parent_folder_id: "5001", name: "Canary Folder Name" },
    { folder_id: "5002", parent_folder_id: "5001" },
  ],
  ["update_file_properties", { file_id: "7001", name: "Canary File Name.pdf" }, { file_id: "7001" }],
  ["update_folder_properties", { folder_id: "5002", name: "Canary Folder Name" }, { folder_id: "5002" }],
  [
    "update_file_properties",
    { file_id: "7001", description: "Canary description", tags: ["Canary"], collections: [{ id: "88" }] },
    { file_id: "7001" },
  ],
  [
    "copy_file",
    { file_id: "7001", parent_folder_id: "5001", name: "Canary Copy.pdf" },
    { file_id: "7001", parent_folder_id: "5001" },
  ],
  ["copy_folder", { folder_id: "5002", parent_folder_id: "0" }, { folder_id: "5002", parent_folder_id: "0" }],
  [
    "set_file_metadata",
    { file_id: "7001", scope: "enterprise", template_key: "matterRecord", metadata_fields: { note: "Canary" } },
    { file_id: "7001" },
  ],
  [
    "set_folder_metadata",
    { folder_id: "5002", scope: "global", template_key: "properties", metadata_fields: { status: "Canary" } },
    { folder_id: "5002" },
  ],
];

const BOX_STILL_REFUSED: Array<[string, string]> = [
  ["delete_file", "delete_denied"],
  ["delete_folder", "delete_denied"],
  ["remove_collaboration", "delete_denied"],
  ["create_shared_link", "needs_approval_in_docket"],
  ["add_collaboration", "needs_approval_in_docket"],
  ["upload_file", "needs_approval_in_docket"],
  ["upload_file_version", "needs_approval_in_docket"],
  ["create_file_comment", "needs_approval_in_docket"],
  ["create_metadata_template", "needs_approval_in_docket"],
  ["update_metadata_template", "needs_approval_in_docket"],
];

/** The user's Box row as Docket keeps it: changes flagged as needing approval. */
function connectBox(db: FakeDb, userId: string): ConnectorRow {
  const box = seedManagedBoxConnector(db, userId);
  seedOAuthToken(db, box.id, { expiresAt: iso(30 * MINUTE) });
  seedTool(db, box.id, "search_files_keyword");
  seedTool(db, box.id, "list_folder_content_by_folder_id");
  for (const name of AGENT_BOX_ORGANIZE_TOOLS) {
    seedTool(db, box.id, name, { requires_confirmation: true });
  }
  for (const [name] of BOX_STILL_REFUSED) {
    seedTool(db, box.id, name, { requires_confirmation: true });
  }
  return box;
}

test("with the organize switch off, Box cannot be moved, renamed or given a folder", async () => {
  const { app, db, upstream } = setup();
  // PracticePanther writes and Box uploads on: neither opens Box organize.
  setGatewayEnv({
    DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
    DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on",
    DOCKET_AGENT_BOX_UPLOADS: "on",
  });
  const token = await enroll(db, "user-1", GARRETT);
  const box = connectBox(db, "user-1");

  await withApp(app, async (baseUrl) => {
    const list = await rpc(baseUrl, "box", token, "tools/list");
    assert.deepEqual(
      list.json.result.tools.map((tool: { name: string }) => tool.name),
      ["list_folder_content_by_folder_id", "search_files_keyword"],
    );
    for (const [name, args] of BOX_ORGANIZE_CALLS) {
      const answer = await rpc(baseUrl, "box", token, "tools/call", { name, arguments: args });
      assert.equal(answer.status, 200, name);
      assert.deepEqual(answer.json.result, {
        isError: true,
        content: [{ type: "text", text: "This tool is not available to Docket Agent." }],
      });
      const row = auditRows(db).at(-1)!;
      assert.equal(row.error_message, "Denied by Docket Agent gateway: organize_off", name);
      assert.equal(row.action_kind, "mutation", name);
      assert.equal(row.connector_id, box.id);
      assert.equal(row.origin, "docket_agent");
      assert.ok(!JSON.stringify(row).includes("Canary"), name);
    }
    // Any value but "on" is off.
    for (const value of ["off", "true", "1", "yes", ""]) {
      setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, DOCKET_AGENT_BOX_ORGANIZE: value });
      const answer = await rpc(baseUrl, "box", token, "tools/call", {
        name: "move_file",
        arguments: { file_id: "7001", parent_folder_id: "5001" },
      });
      assert.equal(answer.json.result.isError, true, value);
    }
  });
  assert.equal(upstream.calls.length, 0);
});

test("with the organize switch on, a new folder, a move, a copy, an item's properties and its metadata are audited first, then sent as they came", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, DOCKET_AGENT_BOX_ORGANIZE: " On " });
  const token = await enroll(db, "user-1", GARRETT);
  const box = connectBox(db, "user-1");
  const tokenId = db.table("docket_agent_tokens")[0].id;

  await withApp(app, async (baseUrl) => {
    const list = await rpc(baseUrl, "box", token, "tools/list");
    assert.deepEqual(
      list.json.result.tools.map((tool: { name: string }) => tool.name),
      [
        "copy_file",
        "copy_folder",
        "create_folder",
        "list_folder_content_by_folder_id",
        "move_file",
        "move_folder",
        "search_files_keyword",
        "set_file_metadata",
        "set_folder_metadata",
        "update_file_properties",
        "update_folder_properties",
      ],
    );

    for (const [name, args, refs] of BOX_ORGANIZE_CALLS) {
      const before = auditRows(db).length;
      db.events.length = 0;
      upstream.calls.length = 0;
      const done = { content: [{ type: "text", text: `{"id":"9001","type":"done-by-${name}"}` }] };
      upstream.state.respond = () => done;
      const answer = await rpc(baseUrl, "box", token, "tools/call", { name, arguments: args });
      assert.equal(answer.status, 200, name);
      assert.deepEqual(answer.json.result, done, name);

      // A pending audit row exists before Box is asked for anything.
      const order = db.events.filter(
        (event) => event.startsWith("upstream:") || event.includes("user_mcp_tool_audit_logs"),
      );
      assert.deepEqual(
        order.slice(0, 3),
        [
          "db:insert:user_mcp_tool_audit_logs:pending",
          `upstream:${name}`,
          "db:update:user_mcp_tool_audit_logs:ok",
        ],
        name,
      );
      assert.equal(upstream.calls.length, 1, name);
      assert.equal(upstream.calls[0].name, name);
      assert.deepEqual(upstream.calls[0].args, args);
      // The user's own Box row, the one Docket chat keeps for him.
      assert.equal(upstream.calls[0].connector.id, box.id);
      assert.equal(upstream.calls[0].connector.user_id, "user-1");

      const rows = auditRows(db).slice(before);
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0].status, "ok");
      assert.equal(rows[0].action_kind, "mutation");
      assert.equal(rows[0].tool_name, name);
      assert.equal(rows[0].actor_email, GARRETT);
      assert.equal(rows[0].user_id, "user-1");
      assert.equal(rows[0].origin, "docket_agent");
      assert.equal(rows[0].agent_token_id, tokenId);
      // The row says what was touched, by id. Never a name.
      assert.deepEqual(rows[0].target_refs, refs, name);
      assert.ok(!JSON.stringify(rows[0]).includes("Canary"), name);
    }

    // A Box error is passed on as it is and the row is closed as an error.
    const failure = { isError: true, content: [{ type: "text", text: "Item name in use." }] };
    upstream.state.respond = () => failure;
    const failed = await rpc(baseUrl, "box", token, "tools/call", {
      name: "move_file",
      arguments: { file_id: "7001", parent_folder_id: "5001" },
    });
    assert.deepEqual(failed.json.result, failure);
    assert.equal(auditRows(db).at(-1)!.status, "error");
    assert.deepEqual(auditRows(db).at(-1)!.target_refs, {
      file_id: "7001",
      parent_folder_id: "5001",
    });

    // A lost answer is reported as uncertain.
    upstream.state.respond = () => {
      throw new Error("socket closed");
    };
    const lost = await rpc(baseUrl, "box", token, "tools/call", {
      name: "move_folder",
      arguments: { folder_id: "5002", parent_folder_id: "5001" },
    });
    assert.equal(lost.json.result.isError, true);
    assert.match(
      lost.json.result.content[0].text,
      /The outcome is uncertain\. Check the record before trying again\.$/,
    );

    // The audit row cannot be written: nothing is sent to Box.
    upstream.calls.length = 0;
    upstream.state.respond = () => ({ content: [{ type: "text", text: "ok" }] });
    db.failOn("user_mcp_tool_audit_logs", "insert");
    const blocked = await rpc(baseUrl, "box", token, "tools/call", {
      name: "create_folder",
      arguments: { name: "Pleadings", parent_folder_id: "5001" },
    });
    assert.equal(blocked.json.result.isError, true);
    assert.match(
      blocked.json.result.content[0].text,
      /could not create the required actor audit record/,
    );
    assert.equal(upstream.calls.length, 0);
  });
});

test("with the organize switch on, deleting, sharing, collaboration, comments, uploads and template edits stay refused", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({
    DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
    DOCKET_AGENT_BOX_ORGANIZE: "on",
    DOCKET_AGENT_BOX_UPLOADS: "on",
    DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on",
  });
  const token = await enroll(db, "user-1", GARRETT);
  connectBox(db, "user-1");

  const renamesOnly: Array<[string, Record<string, unknown>]> = [
    ["update_file_properties", { file_id: "7001" }],
    ["update_file_properties", { file_id: "7001", tags: "Canary" }],
    ["update_folder_properties", { folder_id: "5002", name: "A", shared_link: { access: "open" } }],
    ["move_file", { file_id: "7001", parent_folder_id: "5001", shared_link: { access: "open" } }],
    ["copy_file", { file_id: "7001", parent_folder_id: "5001", shared_link: { access: "open" } }],
    ["copy_folder", { folder_id: "5002" }],
    ["set_file_metadata", { file_id: "7001", scope: "user", template_key: "t", metadata_fields: { a: "Canary" } }],
    ["move_folder", { folder_id: "5002" }],
    ["create_folder", { parent_folder_id: "5001" }],
  ];

  await withApp(app, async (baseUrl) => {
    for (const [name, reason] of BOX_STILL_REFUSED) {
      const before = auditRows(db).length;
      const answer = await rpc(baseUrl, "box", token, "tools/call", {
        name,
        arguments: { file_id: "7001", folder_id: "5002", parent_folder_id: "5001", name: "Canary" },
      });
      assert.equal(answer.status, 200, name);
      assert.deepEqual(answer.json.result, {
        isError: true,
        content: [{ type: "text", text: "This tool is not available to Docket Agent." }],
      });
      const rows = auditRows(db).slice(before);
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0].error_message, `Denied by Docket Agent gateway: ${reason}`, name);
      assert.equal(rows[0].status, "error");
      assert.ok(!JSON.stringify(rows[0]).includes("Canary"), name);
    }
    // A tool Box has that the tool cache does not know.
    const unknown = await rpc(baseUrl, "box", token, "tools/call", {
      name: "trash_file",
      arguments: { file_id: "7001" },
    });
    assert.equal(unknown.json.result.isError, true);
    assert.equal(
      auditRows(db).at(-1)!.error_message,
      "Denied by Docket Agent gateway: unknown_tool",
    );

    // An organize tool asked for an argument it does not take, or in the wrong shape.
    for (const [name, args] of renamesOnly) {
      const answer = await rpc(baseUrl, "box", token, "tools/call", { name, arguments: args });
      assert.equal(answer.json.result.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.equal(
        auditRows(db).at(-1)!.error_message,
        "Denied by Docket Agent gateway: organize_arguments",
        `${name} ${JSON.stringify(args)}`,
      );
      assert.ok(!JSON.stringify(auditRows(db).at(-1)).includes("Canary"));
    }

    // None of them is in the tool list either.
    const list = await rpc(baseUrl, "box", token, "tools/list");
    const names = list.json.result.tools.map((tool: { name: string }) => tool.name);
    for (const [name] of BOX_STILL_REFUSED) assert.ok(!names.includes(name), name);
  });
  assert.equal(upstream.calls.length, 0);
});

test("Box organize only ever reaches the Box row of the token's own user, and a tool the user switched off stays off", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, DOCKET_AGENT_BOX_ORGANIZE: "on" });
  const tokenA = await enroll(db, "user-a", GARRETT);
  const tokenB = await enroll(db, "user-b", JERAD);
  const boxB = connectBox(db, "user-b");
  // B switched "move_folder" off in Docket's connector settings.
  for (const row of db.table("user_mcp_connector_tools")) {
    if (row.connector_id === boxB.id && row.tool_name === "move_folder") row.enabled = false;
  }

  await withApp(app, async (baseUrl) => {
    // A has no Box row and must not get B's.
    const refused = await rpc(baseUrl, "box", tokenA, "tools/call", {
      name: "move_file",
      arguments: { file_id: "7001", parent_folder_id: "5001" },
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.json.error, "source_not_connected");

    const moved = await rpc(baseUrl, "box", tokenB, "tools/call", {
      name: "move_file",
      arguments: { file_id: "7001", parent_folder_id: "5001" },
    });
    assert.equal(moved.json.result.isError, undefined);

    const off = await rpc(baseUrl, "box", tokenB, "tools/call", {
      name: "move_folder",
      arguments: { folder_id: "5002", parent_folder_id: "5001" },
    });
    assert.equal(off.json.result.isError, true);
    assert.equal(
      auditRows(db).at(-1)!.error_message,
      "Denied by Docket Agent gateway: tool_disabled",
    );
  });
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].connector.id, boxB.id);
  assert.equal(upstream.calls[0].connector.user_id, "user-b");
  for (const row of auditRows(db)) assert.equal(row.user_id, "user-b");
});

test("the status answer reports the Box organize switch next to the Box files", async () => {
  const { app, db } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, DOCKET_AGENT_STATUS_TOKEN: TEST_STATUS_TOKEN });
  seedUser(db, { id: "user-1", email: GARRETT });

  await withApp(app, async (baseUrl) => {
    const off = await ops(baseUrl, "/status");
    assert.equal(off.json.box_organize, "off");
    assert.deepEqual(off.json.box_files, { download: true, upload: false });
    assert.equal(off.json.practicepanther_writes, "off");

    setGatewayEnv({
      DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
      DOCKET_AGENT_STATUS_TOKEN: TEST_STATUS_TOKEN,
      DOCKET_AGENT_BOX_ORGANIZE: "on",
    });
    const on = await ops(baseUrl, "/status");
    assert.equal(on.json.box_organize, "on");
    // One switch each: organize on turns neither of the others on.
    assert.deepEqual(on.json.box_files, { download: true, upload: false });
    assert.equal(on.json.practicepanther_writes, "off");
    // The poller's status token sees the same answer.
    const viaStatusToken = await ops(baseUrl, "/status", { token: TEST_STATUS_TOKEN });
    assert.equal(viaStatusToken.json.box_organize, "on");

    // Box off for the whole backend: nothing can be organized.
    setGatewayEnv({
      DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
      DOCKET_AGENT_BOX_ORGANIZE: "on",
      BOX_MCP_ENABLED: "false",
    });
    const boxOff = await ops(baseUrl, "/status");
    assert.equal(boxOff.json.box_organize, "off");
    assert.deepEqual(boxOff.json.box_files, { download: false, upload: false });
  });
});

// ---------------------------------------------------------------------------
// christopher's rule (2026-10-02): Docket Agent may do what the user's own
// permissions allow, except K1-K5. PracticePanther files, the money records
// for an admin, and Quo contacts and tasks.
// ---------------------------------------------------------------------------

const PP_FILE_WRITES = ["Files_PostFile", "Files_PostFileToBox", "Files_PutFile", "Files_PutFile_2"];
const PP_MESSAGE_WRITES = ["Messages_PostMessage", "Messages_PutMessage", "Messages_PutMessage_2"];

/** Asserts one change went out once, after its pending audit row. */
function assertAuditedChange(
  db: FakeDb,
  upstream: ReturnType<typeof setup>["upstream"],
  name: string,
  args: Record<string, unknown>,
  connectorId: string,
  actor: string,
  before: number,
) {
  assert.deepEqual(
    db.events.filter(
      (event) => event.startsWith("upstream:") || event.includes("user_mcp_tool_audit_logs"),
    ),
    [
      "db:insert:user_mcp_tool_audit_logs:pending",
      `upstream:${name}`,
      "db:update:user_mcp_tool_audit_logs:ok",
    ],
    name,
  );
  assert.equal(upstream.calls.length, 1, name);
  assert.equal(upstream.calls[0].name, name);
  // The arguments reach the source exactly as sent.
  assert.deepEqual(upstream.calls[0].args, args, name);
  assert.equal(upstream.calls[0].connector.id, connectorId, name);
  const rows = auditRows(db).slice(before);
  assert.equal(rows.length, 1, name);
  assert.equal(rows[0].status, "ok", name);
  assert.equal(rows[0].action_kind, "mutation", name);
  assert.equal(rows[0].actor_email, actor, name);
  assert.equal(rows[0].origin, "docket_agent", name);
  assert.equal(rows[0].connector_id, connectorId, name);
  // No argument text is stored.
  assert.ok(!JSON.stringify(rows[0]).includes("argument-canary"), name);
}

test("with writes on, PracticePanther files are written after a pending audit row; with writes off, never; a message, never", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  const token = await enroll(db, "user-1", GARRETT);
  const adminToken = await enroll(db, "admin-1", JERAD, "admin");
  const connector = seedPerUserPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, connector.id, { expiresAt: iso(30 * MINUTE) });
  const adminConnector = seedPerUserPracticePantherConnector(db, "admin-1");
  seedOAuthToken(db, adminConnector.id, { expiresAt: iso(30 * MINUTE) });
  for (const row of [connector, adminConnector]) {
    for (const name of [...PP_FILE_WRITES, ...PP_MESSAGE_WRITES]) {
      seedTool(db, row.id, name, { enabled: false, requires_confirmation: true });
    }
  }
  const args = { description: "argument-canary-xyz", matter_ref: { id: "m-42" } };

  await withApp(app, async (baseUrl) => {
    // Writes off: nothing listed, everything refused, nothing sent.
    const listOff = await rpc(baseUrl, "practicepanther", token, "tools/list");
    assert.deepEqual(listOff.json.result.tools, []);
    for (const [name, reason] of [
      ...PP_FILE_WRITES.map((name) => [name, "writes_off"]),
      ...PP_MESSAGE_WRITES.map((name) => [name, "send_denied"]),
    ]) {
      const off = await rpc(baseUrl, "practicepanther", token, "tools/call", { name, arguments: args });
      assert.equal(off.json.result.isError, true, name);
      assert.equal(auditRows(db).at(-1)!.error_message, `Denied by Docket Agent gateway: ${reason}`, name);
      assert.equal(auditRows(db).at(-1)!.action_kind, "mutation", name);
    }
    assert.equal(upstream.calls.length, 0);

    // Writes on: the file tools are listed and each goes out once, audited
    // first. A message is neither listed nor sent, for any role.
    setGatewayEnv({
      DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
      DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on",
    });
    for (const caller of [token, adminToken]) {
      const listOn = await rpc(baseUrl, "practicepanther", caller, "tools/list");
      assert.deepEqual(
        listOn.json.result.tools.map((tool: { name: string }) => tool.name),
        [...PP_FILE_WRITES].sort(),
      );
    }
    for (const name of PP_FILE_WRITES) {
      const before = auditRows(db).length;
      db.events.length = 0;
      upstream.calls.length = 0;
      const made = { content: [{ type: "text", text: `{"id":"file-from-${name}"}` }] };
      upstream.state.respond = () => made;
      const answer = await rpc(baseUrl, "practicepanther", token, "tools/call", { name, arguments: args });
      assert.equal(answer.status, 200, name);
      assert.deepEqual(answer.json.result, made, name);
      assertAuditedChange(db, upstream, name, args, connector.id, GARRETT, before);
    }

    upstream.calls.length = 0;
    for (const caller of [token, adminToken]) {
      for (const name of PP_MESSAGE_WRITES) {
        const answer = await rpc(baseUrl, "practicepanther", caller, "tools/call", {
          name,
          arguments: { contact_id: "c-1", type: "Text", body: "argument-canary-xyz" },
        });
        assert.deepEqual(answer.json.result, {
          isError: true,
          content: [{ type: "text", text: "This tool is not available to Docket Agent." }],
        });
        assert.equal(auditRows(db).at(-1)!.error_message, "Denied by Docket Agent gateway: send_denied");
        assert.ok(!JSON.stringify(auditRows(db).at(-1)).includes("argument-canary"));
      }
    }
    assert.equal(upstream.calls.length, 0);
  });
});

test("an admin's token reads and, with writes on, writes the records Docket keeps admin-only; a non-admin's never; deletes and the raw tool never", async () => {
  const { app, db, upstream } = setup();
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, DOCKET_AGENT_STATUS_TOKEN: TEST_STATUS_TOKEN });
  const userToken = await enroll(db, "user-1", GARRETT);
  const adminToken = await enroll(db, "admin-1", JERAD, "admin");
  // Every admin-only name the connector could have, and the second spelling
  // of each update, in both users' tool caches.
  const adminOnly = [
    ...ADMIN_ONLY_PRACTICEPANTHER_TOOLS,
    ...AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS.filter((name) => /_Put/.test(name)).map(
      (name) => `${name}_2`,
    ),
  ];
  const rows: Record<string, ConnectorRow> = {};
  for (const userId of ["user-1", "admin-1"]) {
    rows[userId] = seedPerUserPracticePantherConnector(db, userId);
    seedOAuthToken(db, rows[userId].id, { expiresAt: iso(30 * MINUTE) });
    for (const name of adminOnly) {
      seedTool(db, rows[userId].id, name, { enabled: false, requires_confirmation: true });
    }
  }
  const staffReads = ["Users_GetUser", "Users_GetUsers", "Users_Me"];
  const adminReads = adminOnly.filter((name) => /_Get|^Users_Me$/.test(name)).sort();
  const adminWrites = adminOnly
    .filter((name) => /_(Post|Put)/.test(name) && !/_Delete/.test(name))
    .sort();
  assert.equal(adminWrites.length, 15); // ten tools, five with a second spelling
  const refusedForBoth: Array<[string, string]> = [
    ...adminOnly.filter((name) => /_Delete/.test(name)).map((name): [string, string] => [name, "delete_denied"]),
    ["pp_api_request", "raw_api_denied"],
  ];
  const args = { name: "argument-canary-xyz", account_ref: { id: "a-9" } };

  await withApp(app, async (baseUrl) => {
    // The status answer carries each user's Docket role: the poller reads it.
    // (Both have a live token, so both are in the answer.)
    const status = await ops(baseUrl, "/status", { token: TEST_STATUS_TOKEN });
    const roles = Object.fromEntries(
      status.json.users.map((user: { email: string; role: string }) => [user.email, user.role]),
    );
    assert.deepEqual(roles, { [GARRETT]: "user", [JERAD]: "admin" });

    // Writes off: an admin lists the admin-only reads; a non-admin the user list only.
    const adminOff = await rpc(baseUrl, "practicepanther", adminToken, "tools/list");
    assert.deepEqual(adminOff.json.result.tools.map((tool: { name: string }) => tool.name), adminReads);
    const userOff = await rpc(baseUrl, "practicepanther", userToken, "tools/list");
    assert.deepEqual(userOff.json.result.tools.map((tool: { name: string }) => tool.name), staffReads);
    for (const name of adminWrites) {
      const off = await rpc(baseUrl, "practicepanther", adminToken, "tools/call", { name, arguments: args });
      assert.equal(off.json.result.isError, true, name);
      assert.equal(auditRows(db).at(-1)!.error_message, "Denied by Docket Agent gateway: writes_off", name);
    }
    assert.equal(upstream.calls.length, 0);

    // Writes on.
    setGatewayEnv({
      DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
      DOCKET_AGENT_STATUS_TOKEN: TEST_STATUS_TOKEN,
      DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on",
    });
    const adminOn = await rpc(baseUrl, "practicepanther", adminToken, "tools/list");
    assert.deepEqual(
      adminOn.json.result.tools.map((tool: { name: string }) => tool.name),
      [...adminReads, ...adminWrites].sort(),
    );
    const userOn = await rpc(baseUrl, "practicepanther", userToken, "tools/list");
    assert.deepEqual(userOn.json.result.tools.map((tool: { name: string }) => tool.name), staffReads);

    // An admin: each money-record change goes out once, audited first, as him.
    for (const name of adminWrites) {
      const before = auditRows(db).length;
      db.events.length = 0;
      upstream.calls.length = 0;
      const made = { content: [{ type: "text", text: `{"id":"made-by-${name}"}` }] };
      upstream.state.respond = () => made;
      const answer = await rpc(baseUrl, "practicepanther", adminToken, "tools/call", { name, arguments: args });
      assert.deepEqual(answer.json.result, made, name);
      assertAuditedChange(db, upstream, name, args, rows["admin-1"].id, JERAD, before);
    }
    // An admin: each admin-only read goes out once, recorded as a read.
    upstream.calls.length = 0;
    for (const name of adminReads) {
      const before = auditRows(db).length;
      const answer = await rpc(baseUrl, "practicepanther", adminToken, "tools/call", { name, arguments: {} });
      assert.equal(answer.json.result.isError, undefined, name);
      const audit = auditRows(db).slice(before);
      assert.equal(audit.length, 1, name);
      assert.equal(audit[0].action_kind, "read", name);
      assert.equal(audit[0].actor_email, JERAD, name);
    }
    assert.deepEqual(upstream.calls.map((call) => call.name), adminReads);

    // A non-admin: every admin-only read but the user list, and every
    // money-record change, refused and never sent.
    upstream.calls.length = 0;
    for (const name of [...adminReads.filter((name) => !staffReads.includes(name)), ...adminWrites]) {
      const answer = await rpc(baseUrl, "practicepanther", userToken, "tools/call", { name, arguments: args });
      assert.equal(answer.json.result.isError, true, name);
      assert.equal(auditRows(db).at(-1)!.error_message, "Denied by Docket Agent gateway: admin_only", name);
      assert.equal(auditRows(db).at(-1)!.actor_email, GARRETT, name);
    }
    // Both: deletes and the raw tool, refused and never sent.
    for (const caller of [userToken, adminToken]) {
      for (const [name, reason] of refusedForBoth) {
        const answer = await rpc(baseUrl, "practicepanther", caller, "tools/call", {
          name,
          arguments: { id: "argument-canary-xyz", method: "DELETE", path: "/api/v2/invoices" },
        });
        assert.equal(answer.json.result.isError, true, name);
        assert.equal(auditRows(db).at(-1)!.error_message, `Denied by Docket Agent gateway: ${reason}`, name);
      }
    }
    assert.equal(upstream.calls.length, 0);

    // The role is read on every request: an admin made a user loses the
    // money records at once, without a new token.
    for (const user of db.table("app_users")) {
      if (user.id === "admin-1") user.role = "user";
    }
    const demoted = await rpc(baseUrl, "practicepanther", adminToken, "tools/call", {
      name: "Items_PostItem",
      arguments: args,
    });
    assert.equal(demoted.json.result.isError, true);
    assert.equal(auditRows(db).at(-1)!.error_message, "Denied by Docket Agent gateway: admin_only");
    assert.equal(upstream.calls.length, 0);
  });
});

const QUO_READ_TOOLS = ["list-inboxes", "fetch-messages", "fetch-missed-calls", "fetch-call-transcripts"];
const QUO_SEND_TOOLS = ["send-message", "send-group-message", "send-bulk-messages"];

/**
 * The user's Quo agent row, with the tool cache Docket's own refresh would
 * leave on it: a tool whose name says it changes something is marked as
 * needing confirmation and switched off (for chat).
 */
function connectQuo(db: FakeDb, userId: string): ConnectorRow {
  const connector = seedConnector(db, {
    id: `quo-agent-${userId}`,
    user_id: userId,
    name: "Quo (Docket Agent)",
    server_url: QUO_URL,
    tool_policy: { docketAgentSource: "quo" },
  });
  seedOAuthToken(db, connector.id, { expiresAt: iso(30 * MINUTE) });
  for (const name of [...QUO_READ_TOOLS, ...AGENT_QUO_WRITE_TOOLS, ...QUO_SEND_TOOLS, "delete-contact"]) {
    const requiresConfirmation = toolRequiresConfirmation({}, name);
    seedTool(db, connector.id, name, {
      requires_confirmation: requiresConfirmation,
      enabled: !requiresConfirmation,
    });
  }
  return connector;
}

test("Quo: contacts and tasks are created and updated through the user's own row after a pending audit row; sending and deleting never", async () => {
  const { app, db, upstream } = setup();
  // No switch of PracticePanther's or Box's is on: Quo changes do not use them.
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, DOCKET_AGENT_QUO_MCP_URL: QUO_URL });
  const token = await enroll(db, "user-1", GARRETT);
  const otherToken = await enroll(db, "user-2", JERAD);
  const quo = connectQuo(db, "user-1");
  const otherQuo = connectQuo(db, "user-2");
  const calls: Record<string, Record<string, unknown>> = {
    "create-contact": { firstName: "argument-canary-xyz", phoneNumbers: ["+13175550100"] },
    "update-contact": { id: "c-7", firstName: "argument-canary-xyz" },
    "create-task": { title: "argument-canary-xyz", dueDate: "2026-10-09" },
    "update-task": { id: "t-3", status: "done" },
  };
  assert.deepEqual(Object.keys(calls).sort(), [...AGENT_QUO_WRITE_TOOLS].sort());

  await withApp(app, async (baseUrl) => {
    // Listed: the reads and the four changes. Never a send or a delete.
    const list = await rpc(baseUrl, "quo", token, "tools/list");
    assert.deepEqual(
      list.json.result.tools.map((tool: { name: string }) => tool.name),
      [...QUO_READ_TOOLS, ...AGENT_QUO_WRITE_TOOLS].sort(),
    );

    for (const [name, args] of Object.entries(calls)) {
      const before = auditRows(db).length;
      db.events.length = 0;
      upstream.calls.length = 0;
      const made = { content: [{ type: "text", text: `{"id":"made-by-${name}"}` }] };
      upstream.state.respond = () => made;
      const answer = await rpc(baseUrl, "quo", token, "tools/call", { name, arguments: args });
      assert.equal(answer.status, 200, name);
      assert.deepEqual(answer.json.result, made, name);
      assertAuditedChange(db, upstream, name, args, quo.id, GARRETT, before);
    }

    // A read is still a read.
    upstream.calls.length = 0;
    const read = await rpc(baseUrl, "quo", token, "tools/call", { name: "fetch-messages", arguments: {} });
    assert.equal(read.json.result.isError, undefined);
    assert.equal(auditRows(db).at(-1)!.action_kind, "read");

    // Sending a message and deleting: refused, never sent.
    upstream.calls.length = 0;
    for (const [name, reason] of [
      ...QUO_SEND_TOOLS.map((name) => [name, "send_denied"]),
      ["delete-contact", "delete_denied"],
    ]) {
      const answer = await rpc(baseUrl, "quo", token, "tools/call", {
        name,
        arguments: { to: ["+13175550100"], content: "argument-canary-xyz" },
      });
      assert.deepEqual(answer.json.result, {
        isError: true,
        content: [{ type: "text", text: "This tool is not available to Docket Agent." }],
      }, name);
      assert.equal(auditRows(db).at(-1)!.error_message, `Denied by Docket Agent gateway: ${reason}`, name);
      assert.equal(auditRows(db).at(-1)!.action_kind, "mutation", name);
      assert.ok(!JSON.stringify(auditRows(db).at(-1)).includes("argument-canary"), name);
    }
    assert.equal(upstream.calls.length, 0);

    // The audit row cannot be written: the change is not sent.
    db.failOn("user_mcp_tool_audit_logs", "insert");
    const blocked = await rpc(baseUrl, "quo", token, "tools/call", {
      name: "create-task",
      arguments: calls["create-task"],
    });
    assert.equal(blocked.json.result.isError, true);
    assert.match(blocked.json.result.content[0].text, /could not create the required actor audit record/);
    assert.equal(upstream.calls.length, 0);

    // Each token reaches its own user's Quo row only.
    upstream.calls.length = 0;
    await rpc(baseUrl, "quo", otherToken, "tools/call", { name: "update-task", arguments: { id: "t-4" } });
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].connector.id, otherQuo.id);

    // Quo switched off for the backend (its URL unset): nothing goes out.
    setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
    upstream.calls.length = 0;
    const off = await rpc(baseUrl, "quo", token, "tools/call", {
      name: "create-contact",
      arguments: calls["create-contact"],
    });
    assert.equal(off.status, 401);
    assert.deepEqual(off.json, { error: "source_not_connected", source: "quo", state: "not_connected" });
    assert.equal(upstream.calls.length, 0);
  });
});

async function withBackend(
  env: NodeJS.ProcessEnv,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const port = 41000 + Math.floor(Math.random() * 1000);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: "postgres://docket:unused@127.0.0.1:5432/docket",
    NODE_ENV: "test",
    PGSSLMODE: "disable",
    ...env,
    PORT: String(port),
  };
  if (!("DOCKET_AGENT_OPS_TOKEN" in env)) delete childEnv.DOCKET_AGENT_OPS_TOKEN;
  const child: ChildProcessWithoutNullStreams = spawn(
    "./node_modules/.bin/tsx",
    ["src/index.ts"],
    { cwd: backendRoot, env: childEnv, stdio: "pipe" },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    // Generous: a loaded machine can take a while to start the backend.
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error("Backend did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await run(`http://127.0.0.1:${port}`);
  } catch (error) {
    throw new Error(`${String(error)}\nBackend output:\n${output}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  }
  capturedLogs.push(output);
}

test("the real backend answers 503 while off and 401 for a malformed bearer when on", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer dka_not-a-real-token",
    Origin: "https://evil.example",
  };

  await withBackend({}, async (baseUrl) => {
    const off = await request(`${baseUrl}/agent-mcp/practicepanther`, { method: "POST", headers, body });
    assert.equal(off.status, 503);
    assert.deepEqual(off.json, { error: "agent_gateway_disabled" });
    const opsOff = await request(`${baseUrl}/agent-mcp/ops/status`);
    assert.equal(opsOff.status, 503);
    // The rest of the app is untouched.
    assert.equal((await request(`${baseUrl}/health`)).status, 200);
  });

  await withBackend({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN }, async (baseUrl) => {
    const on = await request(`${baseUrl}/agent-mcp/practicepanther`, { method: "POST", headers, body });
    assert.equal(on.status, 401);
    assert.deepEqual(on.json, { error: "invalid_token" });
    // No CORS headers on this surface.
    assert.equal(on.headers.get("access-control-allow-origin"), null);
    assert.equal(on.headers.get("cache-control"), "no-store");

    const opsNoBearer = await request(`${baseUrl}/agent-mcp/ops/status`);
    assert.equal(opsNoBearer.status, 401);
    assert.deepEqual(opsNoBearer.json, { error: "invalid_ops_token" });

    // The gateway's 404, not the app's.
    const unknown = await request(`${baseUrl}/agent-mcp/a/b/c`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, { error: "not_found" });
  });
});

after(() => {
  Object.assign(console, originalConsole);
});

test("no log line and no response body holds a token or an upstream secret", () => {
  assert.ok(mintedTokens.length > 10);
  assert.ok(responseBodies.length > 50);
  assert.ok(capturedLogs.length > 0);
  const secrets = [
    ...mintedTokens,
    TEST_OPS_TOKEN,
    TEST_STATUS_TOKEN,
    FAKE_UPSTREAM_ACCESS_TOKEN,
  ];
  for (const secret of secrets) {
    for (const line of capturedLogs) {
      assert.ok(!line.includes(secret), "a secret reached the logs");
    }
    for (const body of responseBodies) {
      assert.ok(!body.includes(secret), "a secret reached a response body");
    }
  }
  // Nothing fell through the gateway to the rest of the app.
  for (const body of responseBodies) assert.ok(!body.includes("fell_through"));
});
