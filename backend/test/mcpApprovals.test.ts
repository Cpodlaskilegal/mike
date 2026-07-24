import assert from "node:assert/strict";
import test from "node:test";
import type {
  McpApprovalPool,
  McpApprovalRow,
} from "../src/lib/mcp/approvals";
import type {
  ConnectorRow,
  McpToolEvent,
  ToolCacheRow,
} from "../src/lib/mcp/types";

process.env.DATABASE_URL ??=
  "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.PGSSLMODE = "disable";
process.env.NODE_ENV = "test";
process.env.MCP_CONNECTORS_ENCRYPTION_SECRET ??=
  "docket-mcp-approval-unit-test-secret";

async function approvalModule() {
  return import("../src/lib/mcp/approvals");
}

type QueryResult<T> = Promise<{ rows: T[] }>;

class MemoryApprovalPool implements McpApprovalPool {
  readonly rows = new Map<string, McpApprovalRow>();

  async connect() {
    return {
      query: <T = Record<string, unknown>>(text: string, values?: unknown[]) =>
        this.query<T>(text, values),
      release() {},
    };
  }

  async query<T = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): QueryResult<T> {
    const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [] };
    }

    if (sql.startsWith("insert into user_mcp_tool_approvals")) {
      const requestKey = String(values[1]);
      const existing = [...this.rows.values()].find(
        (row) => row.request_key === requestKey,
      );
      if (existing) return { rows: [] };
      const now = values[21] as Date;
      const row: McpApprovalRow = {
        id: String(values[0]),
        request_key: requestKey,
        user_id: String(values[2]),
        actor_email: String(values[22]),
        connector_id: String(values[3]),
        tool_id: String(values[4]),
        connector_name: String(values[5]),
        tool_name: String(values[6]),
        openai_tool_name: String(values[7]),
        encrypted_arguments: String(values[8]),
        arguments_iv: String(values[9]),
        arguments_tag: String(values[10]),
        arguments_hash: String(values[11]),
        arguments_preview: JSON.parse(String(values[12])) as Record<
          string,
          unknown
        >,
        policy_version: String(values[13]),
        status: "pending",
        chat_id: values[14] ? String(values[14]) : null,
        assistant_message_id: values[15] ? String(values[15]) : null,
        assistant_run_id: values[16] ? String(values[16]) : null,
        trace_id: values[17] ? String(values[17]) : null,
        project_id: values[18] ? String(values[18]) : null,
        tool_call_id: values[19] ? String(values[19]) : null,
        expires_at: values[20] as Date,
        decided_at: null,
        executed_at: null,
        error_message: null,
        result_event: null,
        result_content: null,
        created_at: now,
        updated_at: now,
      };
      this.rows.set(row.id, row);
      return { rows: [row as T] };
    }

    if (
      sql.startsWith("select * from user_mcp_tool_approvals") &&
      sql.includes("request_key = $1")
    ) {
      const row = [...this.rows.values()].find(
        (candidate) =>
          candidate.request_key === String(values[0]) &&
          candidate.user_id === String(values[1]),
      );
      return { rows: row ? [row as T] : [] };
    }

    if (
      sql.startsWith("select * from user_mcp_tool_approvals") &&
      sql.includes("id = $1") &&
      sql.includes("user_id = $2")
    ) {
      const row = this.rows.get(String(values[0]));
      return {
        rows:
          row && row.user_id === String(values[1]) ? [row as T] : [],
      };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("set status = 'expired'")
    ) {
      const row = this.rows.get(String(values[0]));
      const userMatches =
        !sql.includes("user_id = $2") || row?.user_id === String(values[1]);
      if (
        row &&
        userMatches &&
        row.status === "pending" &&
        new Date(row.expires_at).getTime() <= Date.now()
      ) {
        row.status = "expired";
        row.updated_at = new Date();
      }
      return { rows: [] };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("execution status is indeterminate")
    ) {
      const row = this.rows.get(String(values[0]));
      if (
        row &&
        row.user_id === String(values[1]) &&
        row.status === "executing" &&
        new Date(row.updated_at).getTime() <=
          Date.now() - Number(values[2])
      ) {
        row.status = "indeterminate";
        row.executed_at = new Date();
        row.error_message =
          "Execution status is indeterminate because Docket did not receive a final completion record. Verify the action in PracticePanther before attempting it again.";
        row.updated_at = new Date();
      }
      return { rows: [] };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("set status = 'failed'") &&
      sql.includes("integrity validation")
    ) {
      const row = this.rows.get(String(values[0]));
      if (row) {
        row.status = "failed";
        row.error_message =
          "Stored approval arguments failed integrity validation";
        row.updated_at = new Date();
      }
      return { rows: [] };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("set status = 'executing'")
    ) {
      const row = this.rows.get(String(values[0]));
      if (!row || row.status !== "pending") return { rows: [] };
      row.status = "executing";
      row.decided_at = new Date();
      row.updated_at = new Date();
      return { rows: [row as T] };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("set status = 'rejected'")
    ) {
      const row = this.rows.get(String(values[0]));
      if (!row || row.status !== "pending") return { rows: [] };
      row.status = "rejected";
      row.decided_at = new Date();
      row.updated_at = new Date();
      return { rows: [row as T] };
    }

    if (
      sql.startsWith("update user_mcp_tool_approvals") &&
      sql.includes("set status = $3")
    ) {
      const row = this.rows.get(String(values[0]));
      if (
        !row ||
        row.user_id !== String(values[1]) ||
        row.status !== "executing"
      ) {
        return { rows: [] };
      }
      row.status = values[2] as "succeeded" | "failed" | "indeterminate";
      row.executed_at = new Date();
      row.error_message = values[3] ? String(values[3]) : null;
      row.result_event = values[4]
        ? (JSON.parse(String(values[4])) as McpToolEvent)
        : null;
      row.result_content = values[5] ? String(values[5]) : null;
      row.updated_at = new Date();
      return { rows: [row as T] };
    }

    throw new Error(`Unexpected approval SQL in test: ${sql}`);
  }
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
  const {
    canonicalMcpArguments,
    mcpArgumentsHash,
    mcpArgumentsPreview,
  } = await approvalModule();
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
  assert.equal(
    mcpApprovalTerminalEvent(row)?.approval_status,
    "expired",
  );
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
  assert.equal(
    mcpApprovalTerminalEvent(row)?.approval_status,
    "failed",
  );
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
  assert.equal(
    mcpApprovalTerminalEvent(rejected)?.approval_status,
    "rejected",
  );
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
    resultContent: "{\"result\":{\"id\":\"task-1\"}}",
    pool: completedDb,
  });
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.result_event, event);
  assert.equal(finished.result_content, "{\"result\":{\"id\":\"task-1\"}}");
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
