import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function section(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing route marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing route marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("approval decisions accept only a decision and bind execution to auth user", async () => {
  const source = await readFile(
    new URL("../src/routes/user.ts", import.meta.url),
    "utf8",
  );
  const route = section(
    source,
    "// POST /user/mcp-approvals/:approvalId/decision",
    "// GET /user/data-export",
  );

  assert.match(
    route,
    /userRouter\.post\(\s*"\/mcp-approvals\/:approvalId\/decision",\s*requireAuth,/,
  );
  assert.doesNotMatch(route, /requireAdmin/);
  assert.match(route, /const userId = res\.locals\.userId as string/);
  assert.match(route, /decision !== "approve" && decision !== "reject"/);
  assert.match(
    route,
    /executeMcpToolApproval\(\{\s*approvalId,\s*userId,/,
  );
  assert.doesNotMatch(route, /req\.body\?\.(args|arguments|connector|tool)/);
});

test("all approval terminal paths retry durable chat persistence", async () => {
  const userRouteSource = await readFile(
    new URL("../src/routes/user.ts", import.meta.url),
    "utf8",
  );
  const getRoute = section(
    userRouteSource,
    "// GET /user/mcp-approvals/:approvalId",
    "// POST /user/mcp-approvals/:approvalId/decision",
  );
  const decisionRoute = section(
    userRouteSource,
    "// POST /user/mcp-approvals/:approvalId/decision",
    "// GET /user/data-export",
  );
  assert.match(
    getRoute,
    /await persistApprovalTerminalOutcome\(approval\)/,
  );
  assert.match(
    decisionRoute,
    /rejectMcpApproval\(\{ approvalId, userId \}\)[\s\S]*await persistApprovalTerminalOutcome\(approval\)/,
  );
  assert.match(
    decisionRoute,
    /getMcpApprovalForUser\(approvalId, userId\)[\s\S]*persistApprovalTerminalOutcome\(terminalApproval\)/,
  );

  for (const relativePath of [
    "../src/routes/chat.ts",
    "../src/routes/projectChat.ts",
  ]) {
    const streamRouteSource = await readFile(
      new URL(relativePath, import.meta.url),
      "utf8",
    );
    const saveIndex = streamRouteSource.indexOf(".update(assistantPayload)");
    const reconcileIndex = streamRouteSource.indexOf(
      "await reconcileMcpApprovalTerminalEventsForMessage",
    );
    assert.notEqual(saveIndex, -1, `${relativePath} must save the placeholder`);
    assert.ok(
      reconcileIndex > saveIndex,
      `${relativePath} must reconcile approvals after the placeholder save`,
    );
  }
});

test("custom connector mutation stays admin-only while managed Box remains usable", async () => {
  const source = await readFile(
    new URL("../src/routes/user.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /userRouter\.post\("\/mcp-connectors", requireAuth, requireAdmin,/,
  );
  assert.match(
    source,
    /"\/mcp-connectors\/:connectorId",\s*requireAuth,\s*requireAdmin,/,
  );

  const refresh = section(
    source,
    "// POST /user/mcp-connectors/:connectorId/refresh-tools",
    "// PATCH /user/mcp-connectors/:connectorId/tools/:toolId",
  );
  assert.match(refresh, /current\.managedBy === null/);
  assert.match(refresh, /isAdminUser\(db, userId\)/);
  assert.doesNotMatch(refresh, /requireAdmin,/);

  const oauth = section(
    source,
    "// POST /user/mcp-connectors/:connectorId/oauth/start",
    "// GET /user/mcp-connectors/oauth/callback",
  );
  assert.match(oauth, /connector\.managedBy !== "box"/);
});

test("approval schema stores encrypted exact arguments and one-time states", async () => {
  const migration = await readFile(
    new URL(
      "../migrations/20260723_practicepanther_access_control.sql",
      import.meta.url,
    ),
    "utf8",
  );

  for (const column of [
    "encrypted_arguments text not null",
    "arguments_iv text not null",
    "arguments_tag text not null",
    "arguments_hash text not null",
    "arguments_preview jsonb not null",
    "policy_version text not null",
    "actor_email text not null",
  ]) {
    assert.match(migration, new RegExp(column.replaceAll(" ", "\\s+")));
  }
  assert.match(migration, /'pending'[\s\S]*'executing'/);
  assert.match(migration, /'indeterminate'/);
  assert.match(migration, /request_key text not null unique/);

  for (const relativePath of [
    "../migrations/20260723_practicepanther_access_control.sql",
    "../schema.sql",
    "../migrations/azure_postgres_schema.sql",
  ]) {
    const schema = await readFile(new URL(relativePath, import.meta.url), "utf8");
    assert.match(
      schema,
      /idx_user_mcp_tool_approvals_message_terminal[\s\S]*assistant_message_id,\s*chat_id,\s*status[\s\S]*status in \('succeeded', 'failed', 'indeterminate', 'rejected', 'expired'\)/,
    );
  }
});
