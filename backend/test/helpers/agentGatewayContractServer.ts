// The real /agent-mcp router on a loopback port, with the in-memory test
// database. The Docket Agent repo's contract test starts this and calls it
// with the code Docket Agent ships (its poller and its ops scripts), so the
// two sides are checked against each other and not against a copy.
//
//   npx tsx test/helpers/agentGatewayContractServer.ts <scenario.json>
//
// It prints one JSON line,
// {"base_url": "...", "ops_token": "...", "status_token": "..."}, and
// serves until its input closes. No real database. No network beyond
// 127.0.0.1. `npm test` does not run it.
//
// scenario.json:
//   {"users": [{"email", "role", "pp_user_id",
//               "practicepanther": "connected" | "stale" | "none",
//               "box": true | false, "quo": true | false,
//               "box_login": the Box account signed in (default: email),
//               "allowed": false to leave him off the allowed list}],
//    "allowed_without_user": [addresses on the allowed list that never
//                             signed in to Docket],
//    "tools": {"practicepanther": [...], "box": [...], "quo": [...]}}
//
// Three extra routes exist only here, outside /agent-mcp:
//   POST /__control/reset                          put the scenario back
//   POST /__control/practicepanther-writes/on|off  flip the write switch
//   POST /__control/box-organize/on|off            flip the Box organize switch

import {
  allowAgentEmails,
  createFakeDb,
  createMemoryRefreshLock,
  QUO_URL,
  seedAgentPracticePantherConnector,
  seedConnector,
  seedManagedBoxConnector,
  seedOAuthToken,
  seedTool,
  seedUser,
  setGatewayEnv,
  TEST_OPS_TOKEN,
  TEST_STATUS_TOKEN,
  type FakeDb,
} from "./agentGatewayFakes";
import { readFileSync } from "node:fs";
import express from "express";
import { toolRequiresConfirmation } from "../../src/lib/mcp/client";
import type { ConnectorRow } from "../../src/lib/mcp/types";
import { createAgentMcpRouter } from "../../src/routes/agentMcp";

type ScenarioUser = {
  email: string;
  role?: "user" | "admin";
  pp_user_id?: string | null;
  practicepanther?: "connected" | "stale" | "none";
  box?: boolean;
  quo?: boolean;
  box_login?: string | null;
  allowed?: boolean;
};
type Scenario = {
  users: ScenarioUser[];
  allowed_without_user?: string[];
  tools: { practicepanther: string[]; box: string[]; quo: string[] };
};

const scenarioPath = process.argv[2];
if (!scenarioPath) {
  console.error("usage: agentGatewayContractServer.ts <scenario.json>");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;

const MINUTE = 60_000;
const inHalfAnHour = () => new Date(Date.now() + 30 * MINUTE).toISOString();

let db: FakeDb = createFakeDb();
const ppUserIdByDocketUser = new Map<string, string | null>();
const boxLoginByDocketUser = new Map<string, string | null>();

function seedScenario(): void {
  db = createFakeDb(); // also empties the list of allowed users
  ppUserIdByDocketUser.clear();
  boxLoginByDocketUser.clear();
  setGatewayEnv({
    DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN,
    DOCKET_AGENT_STATUS_TOKEN: TEST_STATUS_TOKEN,
    DOCKET_AGENT_QUO_MCP_URL: QUO_URL,
  });
  allowAgentEmails(...(scenario.allowed_without_user ?? []));
  scenario.users.forEach((user, index) => {
    const userId = `user-${index + 1}`;
    // seedUser also puts him on DOCKET_AGENT_ALLOWED_EMAILS, unless told not to.
    seedUser(db, {
      id: userId,
      email: user.email,
      role: user.role ?? "user",
      allowed: user.allowed !== false,
    });
    ppUserIdByDocketUser.set(userId, user.pp_user_id ?? null);
    boxLoginByDocketUser.set(
      userId,
      user.box_login === undefined ? user.email : user.box_login,
    );

    if (user.practicepanther === "connected" || user.practicepanther === "stale") {
      const connector = seedAgentPracticePantherConnector(db, userId);
      // "stale": a sign-in that was started and never finished.
      seedOAuthToken(
        db,
        connector.id,
        user.practicepanther === "stale"
          ? { accessToken: false }
          : { expiresAt: inHalfAnHour() },
      );
      for (const name of scenario.tools.practicepanther) {
        // The cached flags must not matter for PracticePanther. Policy decides.
        seedTool(db, connector.id, name, {
          enabled: false,
          requires_confirmation: true,
        });
      }
    }
    if (user.box) {
      const connector = seedManagedBoxConnector(db, userId);
      seedOAuthToken(db, connector.id, { expiresAt: inHalfAnHour() });
      for (const name of scenario.tools.box) seedTool(db, connector.id, name);
    }
    if (user.quo) {
      const connector = seedConnector(db, {
        id: `quo-agent-${userId}`,
        user_id: userId,
        name: "Quo (Docket Agent)",
        server_url: QUO_URL,
        tool_policy: { docketAgentSource: "quo" },
      });
      seedOAuthToken(db, connector.id, { expiresAt: inHalfAnHour() });
      // The flags Docket's own tool refresh leaves on a row it does not
      // manage: a tool whose name says it changes something is marked as
      // needing confirmation and switched off (for chat). The gateway does
      // not consult them for Quo's contact and task changes.
      for (const name of scenario.tools.quo) {
        const requiresConfirmation = toolRequiresConfirmation({}, name);
        seedTool(db, connector.id, name, {
          requires_confirmation: requiresConfirmation,
          enabled: !requiresConfirmation,
        });
      }
    }
  });
}

/** Stands in for the upstream MCP servers. Answers the way FastMCP does. */
async function withUpstreamClient<T>(
  connector: ConnectorRow,
  run: (client: { callTool: any }) => Promise<T>,
): Promise<T> {
  return run({
    callTool: async (params: { name: string }) => {
      if (params.name === "pp_oauth_status") {
        const who = {
          authorized: true,
          user_id: ppUserIdByDocketUser.get(connector.user_id) ?? null,
          email: null,
          display_name: null,
          connection_type: "individual",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(who) }],
          structuredContent: who,
          isError: false,
        };
      }
      if (params.name === "who_am_i") {
        const me = {
          id: "1",
          name: "A Box User",
          login: boxLoginByDocketUser.get(connector.user_id) ?? null,
        };
        return { content: [{ type: "text", text: JSON.stringify(me) }] };
      }
      return { content: [{ type: "text", text: `result of ${params.name}` }] };
    },
  });
}

seedScenario();

const app = express();
app.post("/__control/reset", (_req, res) => {
  seedScenario();
  res.json({ ok: true });
});
app.post("/__control/practicepanther-writes/:value", (req, res) => {
  process.env.DOCKET_AGENT_PRACTICEPANTHER_WRITES =
    req.params.value === "on" ? "on" : "off";
  res.json({ ok: true });
});
app.post("/__control/box-organize/:value", (req, res) => {
  process.env.DOCKET_AGENT_BOX_ORGANIZE =
    req.params.value === "on" ? "on" : "off";
  res.json({ ok: true });
});
app.use(
  "/agent-mcp",
  createAgentMcpRouter({
    db: () => db.asDb(),
    now: () => Date.now(),
    withUpstreamClient,
    withRefreshLock: createMemoryRefreshLock(),
    refreshUpstreamToken: async (connector: ConnectorRow) => {
      for (const row of db.table("user_mcp_oauth_tokens")) {
        if (row.connector_id === connector.id) row.expires_at = inHalfAnHour();
      }
    },
    refreshTools: async () => undefined,
    validateServerUrl: async (url) => url,
  }),
);
// Anything that reaches this proves a request fell through the gateway.
app.use((_req, res) => res.status(418).json({ fell_through: true }));

const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address !== "object") process.exit(1);
  process.stdout.write(
    `${JSON.stringify({
      base_url: `http://127.0.0.1:${address.port}`,
      ops_token: TEST_OPS_TOKEN,
      status_token: TEST_STATUS_TOKEN,
    })}\n`,
  );
});

// Stop when the test that started this goes away.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
