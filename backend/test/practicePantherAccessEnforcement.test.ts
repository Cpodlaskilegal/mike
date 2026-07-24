import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConnectorRow,
  Db,
  ToolCacheRow,
} from "../src/lib/mcp/types";
import type {
  McpApprovalPool,
  McpApprovalRow,
} from "../src/lib/mcp/approvals";
import type { AppUserRole } from "../src/lib/userRoles";

process.env.DATABASE_URL ??=
  "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.PGSSLMODE = "disable";
process.env.NODE_ENV = "test";

const connector: ConnectorRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user_id: "user-1",
  name: "PracticePanther MCP",
  transport: "streamable_http",
  server_url: "not-a-valid-runtime-url",
  auth_type: "none",
  enabled: true,
  tool_policy: { managedConnector: "practicepanther" },
  encrypted_auth_config: null,
  auth_config_iv: null,
  auth_config_tag: null,
  created_at: "2026-07-23T00:00:00.000Z",
  updated_at: "2026-07-23T00:00:00.000Z",
};

function tool(
  toolName: string,
  openaiToolName = `mcp_pp_${toolName.toLowerCase()}`,
): ToolCacheRow {
  return {
    id: `${toolName.slice(0, 8).padEnd(8, "0")}-0000-4000-8000-000000000000`,
    connector_id: connector.id,
    tool_name: toolName,
    openai_tool_name: openaiToolName,
    title: toolName,
    description: null,
    input_schema: { type: "object", properties: {} },
    output_schema: null,
    annotations: {},
    // Managed PP cache flags must never grant or remove access.
    enabled: false,
    requires_confirmation: true,
    last_seen_at: "2026-07-23T00:00:00.000Z",
  };
}

type Result = { data: unknown; error: { message: string } | null };

function enforcementDb(input: {
  role: AppUserRole | null;
  tools: ToolCacheRow[];
  managedConnector?: boolean;
}) {
  const audits: Record<string, unknown>[] = [];
  const connectorRow: ConnectorRow = input.managedConnector === false
    ? { ...connector, tool_policy: {}, server_url: "https://proxy.example/mcp" }
    : connector;

  const db = {
    from(table: string) {
      const filters = new Map<string, unknown>();
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          filters.set(column, value);
          return query;
        },
        in(column: string, value: unknown) {
          filters.set(column, value);
          return query;
        },
        async maybeSingle(): Promise<Result> {
          if (table === "app_users") {
            return {
              data: input.role ? { role: input.role } : null,
              error: null,
            };
          }
          if (table === "user_mcp_connector_tools") {
            const row = input.tools.find(
              (candidate) =>
                candidate.openai_tool_name ===
                filters.get("openai_tool_name"),
            );
            return { data: row ?? null, error: null };
          }
          if (table === "user_mcp_connectors") {
            const matches =
              filters.get("id") === connectorRow.id &&
              filters.get("user_id") === connectorRow.user_id &&
              filters.get("enabled") === true;
            return { data: matches ? connectorRow : null, error: null };
          }
          throw new Error(`Unexpected maybeSingle table: ${table}`);
        },
        async insert(row: Record<string, unknown>) {
          assert.equal(table, "user_mcp_tool_audit_logs");
          audits.push({ ...row });
          return { data: null, error: null };
        },
        then<TResult1 = Result, TResult2 = never>(
          onfulfilled?:
            | ((value: Result) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null,
        ) {
          let result: Result;
          if (table === "user_mcp_connectors") {
            result = { data: [connectorRow], error: null };
          } else if (table === "user_mcp_connector_tools") {
            result = { data: input.tools, error: null };
          } else {
            result = { data: null, error: null };
          }
          return Promise.resolve(result).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  } as unknown as Db;
  return { db, audits, connector: connectorRow };
}

function capturingApprovalPool() {
  const rows: McpApprovalRow[] = [];
  const pool: McpApprovalPool = {
    async connect() {
      throw new Error("Approval execution was not expected.");
    },
    async query<T = Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ) {
      assert.match(text, /insert into user_mcp_tool_approvals/i);
      const now = values[21] as Date;
      const row: McpApprovalRow = {
        id: String(values[0]),
        request_key: String(values[1]),
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
      rows.push(row);
      return { rows: [row as T] };
    },
  };
  return { pool, rows };
}

async function withManagedConnectorAutocreateDisabled<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const priorPracticePanther = process.env.PRACTICEPANTHER_MCP_ENABLED;
  const priorBox = process.env.BOX_MCP_ENABLED;
  process.env.PRACTICEPANTHER_MCP_ENABLED = "false";
  process.env.BOX_MCP_ENABLED = "false";
  try {
    return await callback();
  } finally {
    if (priorPracticePanther === undefined) {
      delete process.env.PRACTICEPANTHER_MCP_ENABLED;
    } else {
      process.env.PRACTICEPANTHER_MCP_ENABLED = priorPracticePanther;
    }
    if (priorBox === undefined) {
      delete process.env.BOX_MCP_ENABLED;
    } else {
      process.env.BOX_MCP_ENABLED = priorBox;
    }
  }
}

test("tool discovery applies role policy and keeps approval writes visible", async () => {
  const { buildUserMcpTools } = await import("../src/lib/mcp/servers");
  const rows = [
    tool("BankAccounts_GetBankAccounts", "mcp_pp_bank_accounts"),
    tool("Matters_GetMatters", "mcp_pp_matters_read"),
    tool("Tasks_PostAccount", "mcp_pp_tasks_write"),
    tool("Unreviewed_NewTool", "mcp_pp_unknown"),
  ];

  await withManagedConnectorAutocreateDisabled(async () => {
    const user = enforcementDb({ role: "user", tools: rows });
    const userTools = await buildUserMcpTools("user-1", user.db);
    assert.deepEqual(
      userTools.map((entry) => entry.function.name).sort(),
      ["mcp_pp_matters_read", "mcp_pp_tasks_write"],
    );
    assert.match(
      userTools.find(
        (entry) => entry.function.name === "mcp_pp_tasks_write",
      )?.function.description ?? "",
      /reviews and approves this exact action once/,
    );

    const admin = enforcementDb({ role: "admin", tools: rows });
    const adminTools = await buildUserMcpTools("user-1", admin.db);
    assert.deepEqual(
      adminTools.map((entry) => entry.function.name).sort(),
      [
        "mcp_pp_bank_accounts",
        "mcp_pp_matters_read",
        "mcp_pp_tasks_write",
      ],
    );
  });
});

test("runtime denies non-admin admin-only tools despite forged cache flags", async () => {
  const { executeMcpToolCall } = await import("../src/lib/mcp/servers");
  const bankTool = tool(
    "BankAccounts_GetBankAccounts",
    "mcp_pp_bank_accounts",
  );
  bankTool.enabled = true;
  bankTool.requires_confirmation = false;
  const { db, audits } = enforcementDb({
    role: "user",
    tools: [bankTool],
  });

  const result = await executeMcpToolCall(
    "user-1",
    bankTool.openai_tool_name,
    {},
    db,
  );
  assert.equal(result.event.status, "error");
  assert.equal(result.event.policy_version, "2026-07-23.1");
  assert.match(
    String(audits[0]?.error_message),
    /Access denied by PracticePanther policy: admin_only/,
  );
});

test("runtime persists approval writes without contacting PracticePanther", async () => {
  const priorSecret = process.env.MCP_CONNECTORS_ENCRYPTION_SECRET;
  process.env.MCP_CONNECTORS_ENCRYPTION_SECRET =
    "docket-runtime-approval-boundary-test-secret";
  try {
    const { executeMcpToolCall } = await import("../src/lib/mcp/servers");
    const writeTool = tool("Tasks_PostAccount", "mcp_pp_tasks_write");
    writeTool.input_schema = {
      type: "object",
      properties: {
        subject: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    const { db, audits } = enforcementDb({
      role: "user",
      tools: [writeTool],
    });
    const approvals = capturingApprovalPool();

    const result = await executeMcpToolCall(
      "user-1",
      writeTool.openai_tool_name,
      { subject: "Call client" },
      db,
      {
        actorEmail: "user@example.com",
        chatId: "chat-1",
        assistantMessageId: "message-1",
        assistantRunId: "run-1",
        toolCallId: "call-1",
      },
      approvals.pool,
    );
    assert.equal(result.event.status, "approval_required");
    assert.equal(result.event.approval_status, "pending");
    assert.equal(approvals.rows.length, 1);
    assert.deepEqual(approvals.rows[0].arguments_preview, {
      subject: "Call client",
      tags: ["Docket actor: user@example.com"],
    });
    assert.equal(approvals.rows[0].actor_email, "user@example.com");
    assert.equal(audits.length, 0);
  } finally {
    if (priorSecret === undefined) {
      delete process.env.MCP_CONNECTORS_ENCRYPTION_SECRET;
    } else {
      process.env.MCP_CONNECTORS_ENCRYPTION_SECRET = priorSecret;
    }
  }
});

test("runtime denies raw API GETs and unknown tools without contacting MCP", async () => {
  const { executeMcpToolCall } = await import("../src/lib/mcp/servers");
  for (const currentTool of [
    tool("pp_api_request", "mcp_pp_raw"),
    tool("Unreviewed_NewTool", "mcp_pp_unknown"),
  ]) {
    const { db, audits } = enforcementDb({
      role: currentTool.tool_name === "pp_api_request" ? "user" : "admin",
      tools: [currentTool],
    });
    const result = await executeMcpToolCall(
      "user-1",
      currentTool.openai_tool_name,
      { method: "GET", path: "/api/v2/matters" },
      db,
    );
    assert.equal(result.event.status, "error");
    assert.equal(audits.length, 1);
    assert.match(
      String(audits[0].error_message),
      /Access denied by PracticePanther policy/,
    );
  }
});

test("non-admin custom connectors are denied at the runtime boundary", async () => {
  const { executeMcpToolCall } = await import("../src/lib/mcp/servers");
  const customTool = tool("Matters_GetMatters", "mcp_custom_matters");
  customTool.enabled = true;
  customTool.requires_confirmation = false;
  const { db, audits } = enforcementDb({
    role: "user",
    tools: [customTool],
    managedConnector: false,
  });

  const result = await executeMcpToolCall(
    "user-1",
    customTool.openai_tool_name,
    {},
    db,
  );
  assert.equal(result.event.status, "error");
  assert.match(
    String(audits[0]?.error_message),
    /custom connectors require admin role/,
  );
});

test("runtime fails closed when the current role cannot be verified", async () => {
  const { executeMcpToolCall } = await import("../src/lib/mcp/servers");
  const readTool = tool("Matters_GetMatters", "mcp_pp_matters_read");
  const { db, audits } = enforcementDb({
    role: null,
    tools: [readTool],
  });

  const result = await executeMcpToolCall(
    "user-1",
    readTool.openai_tool_name,
    {},
    db,
  );
  assert.equal(result.event.status, "error");
  assert.match(
    result.event.error ?? "",
    /could not verify the current user's role/,
  );
  assert.equal(audits.length, 0);
});
