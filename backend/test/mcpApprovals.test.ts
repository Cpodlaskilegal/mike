import { MemoryApprovalPool } from "./helpers/memoryMcpApprovalPool";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConnectorRow,
  McpToolEvent,
  ToolCacheRow,
} from "../src/lib/mcp/types";

process.env.DATABASE_URL ??= "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.PGSSLMODE = "disable";
process.env.NODE_ENV = "test";
process.env.MCP_CONNECTORS_ENCRYPTION_SECRET ??=
  "docket-mcp-approval-unit-test-secret";

async function approvalModule() {
  return import("../src/lib/mcp/approvals");
}

const connector: ConnectorRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user_id: "user-1",
  name: "PracticePanther MCP",
  transport: "streamable_http",
  server_url: "https://example.com/mcp",
  auth_type: "none",
  enabled: true,
  tool_policy: { managedConnector: "practicepanther" },
  encrypted_auth_config: null,
  auth_config_iv: null,
  auth_config_tag: null,
  created_at: "2026-07-23T00:00:00.000Z",
  updated_at: "2026-07-23T00:00:00.000Z",
};

const tool: ToolCacheRow = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  connector_id: connector.id,
  tool_name: "Tasks_PostAccount",
  openai_tool_name: "mcp_pp_tasks_post",
  title: "Create task",
  description: null,
  input_schema: { type: "object" },
  output_schema: null,
  annotations: { readOnlyHint: false },
  enabled: true,
  requires_confirmation: true,
  last_seen_at: "2026-07-23T00:00:00.000Z",
};

const context = {
  actorEmail: "user@example.com",
  chatId: "chat-1",
  assistantMessageId: "message-1",
  assistantRunId: "run-1",
  traceId: "trace-1",
  projectId: "project-1",
  toolCallId: "call-1",
};

async function createApproval(
  db: MemoryApprovalPool,
  overrides: {
    args?: Record<string, unknown>;
    userId?: string;
    now?: Date;
  } = {},
) {
  const { createPendingMcpApproval } = await approvalModule();
  return createPendingMcpApproval({
    userId: overrides.userId ?? "user-1",
    connector,
    tool,
    args: overrides.args ?? { subject: "Call client" },
    context,
    policyVersion: "test-policy",
    now: overrides.now,
    pool: db,
  });
}

test("canonical arguments are stable and hidden approval fields fail closed", async () => {
  const { canonicalMcpArguments, mcpArgumentsHash, mcpArgumentsPreview } =
    await approvalModule();
  const left = {
    z: 1,
    nested: { token: "secret", b: 2, a: 1 },
    apiKey: "also-secret",
  };
  const right = {
    apiKey: "also-secret",
    nested: { a: 1, b: 2, token: "secret" },
    z: 1,
  };

  assert.equal(canonicalMcpArguments(left), canonicalMcpArguments(right));
  assert.equal(mcpArgumentsHash(left), mcpArgumentsHash(right));
  assert.throws(
    () => mcpArgumentsPreview(left),
    /argument would be hidden from review/,
  );
});

test("stored arguments are encrypted and mismatched retries fail closed", async () => {
  const { decryptString } = await import("../src/lib/mcp/client");
  const { canonicalMcpArguments } = await approvalModule();
  const db = new MemoryApprovalPool();
  const firstArgs = {
    subject: "Call client",
    matter_ref: { id: "matter-1" },
  };
  const first = await createApproval(db, { args: firstArgs });
  const duplicate = await createApproval(db, { args: firstArgs });
  assert.equal(duplicate.id, first.id);
  await assert.rejects(
    createApproval(db, {
      args: { subject: "Replace the original action" },
    }),
    /no longer matches the original approval request/,
  );
  assert.notEqual(first.encrypted_arguments, canonicalMcpArguments(firstArgs));
  assert.equal(
    decryptString(
      first.encrypted_arguments,
      first.arguments_iv,
      first.arguments_tag,
    ),
    canonicalMcpArguments(firstArgs),
  );
  assert.deepEqual(first.arguments_preview, {
    subject: "Call client",
    matter_ref: { id: "matter-1" },
  });
});

test("approval preview preserves every non-sensitive executed field", async () => {
  const { mcpArgumentsPreview } = await approvalModule();
  const manyFields = Object.fromEntries(
    Array.from({ length: 61 }, (_, index) => [`field_${index + 1}`, index + 1]),
  );
  const recipients = Array.from(
    { length: 26 },
    (_, index) => `recipient-${index + 1}@example.com`,
  );
  const longText = "x".repeat(1200);
  const preview = mcpArgumentsPreview({
    ...manyFields,
    recipients,
    longText,
  });

  assert.equal(preview.field_61, 61);
  assert.deepEqual(preview.recipients, recipients);
  assert.equal(preview.longText, longText);
});

test("claiming is initiating-user-bound and single use", async () => {
  const { claimMcpApprovalForExecution, McpApprovalError } =
    await approvalModule();
  const db = new MemoryApprovalPool();
  const row = await createApproval(db);

  await assert.rejects(
    claimMcpApprovalForExecution({
      approvalId: row.id,
      userId: "different-user",
      pool: db,
    }),
    (error: unknown) =>
      error instanceof McpApprovalError && error.code === "not_found",
  );
  assert.equal(row.status, "pending");

  const claimed = await claimMcpApprovalForExecution({
    approvalId: row.id,
    userId: "user-1",
    pool: db,
  });
  assert.deepEqual(claimed.args, { subject: "Call client" });
  assert.equal(claimed.row.status, "executing");

  await assert.rejects(
    claimMcpApprovalForExecution({
      approvalId: row.id,
      userId: "user-1",
      pool: db,
    }),
    (error: unknown) =>
      error instanceof McpApprovalError && error.code === "not_pending",
  );
});

test("expired approvals cannot be claimed", async () => {
  const { claimMcpApprovalForExecution, McpApprovalError } =
    await approvalModule();
  const db = new MemoryApprovalPool();
  const row = await createApproval(db, {
    now: new Date(Date.now() - 60 * 60 * 1000),
  });

  await assert.rejects(
    claimMcpApprovalForExecution({
      approvalId: row.id,
      userId: "user-1",
      pool: db,
    }),
    (error: unknown) =>
      error instanceof McpApprovalError && error.code === "expired",
  );
  assert.equal(row.status, "expired");
  const { mcpApprovalTerminalEvent } = await import("../src/lib/mcp/servers");
  assert.equal(mcpApprovalTerminalEvent(row)?.approval_status, "expired");
});

test("stale executing approvals become indeterminate failures, never retries", async () => {
  const { claimMcpApprovalForExecution, getMcpApprovalForUser } =
    await approvalModule();
  const db = new MemoryApprovalPool();
  const row = await createApproval(db);
  await claimMcpApprovalForExecution({
    approvalId: row.id,
    userId: "user-1",
    pool: db,
  });
  row.updated_at = new Date(Date.now() - 6 * 60 * 1000);

  const refreshed = await getMcpApprovalForUser(row.id, "user-1", db);
  assert.equal(refreshed?.status, "indeterminate");
  assert.match(refreshed?.error_message ?? "", /status is indeterminate/);
  const { mcpApprovalTerminalEvent } = await import("../src/lib/mcp/servers");
  assert.equal(
    refreshed ? mcpApprovalTerminalEvent(refreshed)?.approval_status : null,
    "indeterminate",
  );
});

test("tampered stored arguments fail integrity validation before execution", async () => {
  const { claimMcpApprovalForExecution, McpApprovalError } =
    await approvalModule();
  const db = new MemoryApprovalPool();
  const row = await createApproval(db);
  row.arguments_hash = "00".repeat(32);

  await assert.rejects(
    claimMcpApprovalForExecution({
      approvalId: row.id,
      userId: "user-1",
      pool: db,
    }),
    (error: unknown) =>
      error instanceof McpApprovalError && error.code === "integrity_failed",
  );
  assert.equal(row.status, "failed");
  const { mcpApprovalTerminalEvent } = await import("../src/lib/mcp/servers");
  assert.equal(mcpApprovalTerminalEvent(row)?.approval_status, "failed");
});

test("rejection is final and a completed claim cannot be replayed", async () => {
  const {
    claimMcpApprovalForExecution,
    finishMcpApproval,
    McpApprovalError,
    rejectMcpApproval,
  } = await approvalModule();
  const rejectedDb = new MemoryApprovalPool();
  const rejected = await createApproval(rejectedDb);
  await rejectMcpApproval({
    approvalId: rejected.id,
    userId: "user-1",
    pool: rejectedDb,
  });
  assert.equal(rejected.status, "rejected");
  const { mcpApprovalTerminalEvent } = await import("../src/lib/mcp/servers");
  assert.equal(mcpApprovalTerminalEvent(rejected)?.approval_status, "rejected");
  await assert.rejects(
    claimMcpApprovalForExecution({
      approvalId: rejected.id,
      userId: "user-1",
      pool: rejectedDb,
    }),
    (error: unknown) =>
      error instanceof McpApprovalError && error.code === "not_pending",
  );

  const completedDb = new MemoryApprovalPool();
  const completed = await createApproval(completedDb);
  await claimMcpApprovalForExecution({
    approvalId: completed.id,
    userId: "user-1",
    pool: completedDb,
  });
  const event: McpToolEvent = {
    type: "mcp_tool_call",
    connector_id: connector.id,
    connector_name: connector.name,
    tool_name: tool.tool_name,
    openai_tool_name: tool.openai_tool_name,
    status: "ok",
    action_kind: "mutation",
  };
  const finished = await finishMcpApproval({
    approvalId: completed.id,
    userId: "user-1",
    status: "succeeded",
    event,
    resultContent: '{"result":{"id":"task-1"}}',
    pool: completedDb,
  });
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.result_event, event);
  assert.equal(finished.result_content, '{"result":{"id":"task-1"}}');
  await assert.rejects(
    finishMcpApproval({
      approvalId: completed.id,
      userId: "user-1",
      status: "succeeded",
      event,
      pool: completedDb,
    }),
    (error: unknown) =>
      error instanceof McpApprovalError && error.code === "not_pending",
  );
});
