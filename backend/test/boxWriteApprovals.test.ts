import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ConnectorRow, Db, ToolCacheRow } from "../src/lib/mcp/types";
import type { AppUserRole } from "../src/lib/userRoles";
import { MemoryApprovalPool } from "./helpers/memoryMcpApprovalPool";

process.env.DATABASE_URL ??= "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.PGSSLMODE = "disable";
process.env.NODE_ENV = "test";
process.env.MCP_CONNECTORS_ENCRYPTION_SECRET ??=
  "docket-box-approval-unit-test-secret";
process.env.PRACTICEPANTHER_MCP_ENABLED = "false";
process.env.BOX_MCP_ENABLED = "false";

beforeEach((t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network in offline Box approval test");
  });
});

const connector: ConnectorRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user_id: "user-1",
  name: "Box",
  transport: "streamable_http",
  server_url: "https://8.8.8.8/mcp",
  auth_type: "none",
  enabled: true,
  tool_policy: { managedConnector: "box" },
  encrypted_auth_config: null,
  auth_config_iv: null,
  auth_config_tag: null,
  created_at: "2026-09-15T00:00:00.000Z",
  updated_at: "2026-09-15T00:00:00.000Z",
};

function tool(
  name: string,
  overrides: Partial<ToolCacheRow> = {},
): ToolCacheRow {
  return {
    id: `tool-${name}`,
    connector_id: connector.id,
    tool_name: name,
    openai_tool_name: `mcp_box_${name}`,
    title: name,
    description: null,
    input_schema: { type: "object", properties: {} },
    output_schema: null,
    annotations: { readOnlyHint: false },
    enabled: true,
    requires_confirmation: true,
    last_seen_at: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

type Result = { data: unknown; error: { message: string } | null };
function fixture(role: AppUserRole, tools: ToolCacheRow[]) {
  const connectorRow = { ...connector };
  const audits: Record<string, unknown>[] = [];
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
          if (table === "app_users") return { data: { role }, error: null };
          if (table === "user_mcp_connector_tools")
            return {
              data:
                tools.find(
                  (row) =>
                    row.openai_tool_name === filters.get("openai_tool_name"),
                ) ?? null,
              error: null,
            };
          if (table === "user_mcp_connectors")
            return {
              data:
                filters.get("user_id") === connectorRow.user_id &&
                filters.get("id") === connectorRow.id &&
                connectorRow.enabled
                  ? connectorRow
                  : null,
              error: null,
            };
          throw new Error(`Unexpected maybeSingle table: ${table}`);
        },
        insert(row: Record<string, unknown>) {
          assert.equal(table, "user_mcp_tool_audit_logs");
          audits.push({ ...row });
          const result = { data: { id: row.id ?? "audit-1" }, error: null };
          return {
            ...result,
            select() {
              return {
                async single() {
                  return result;
                },
              };
            },
          };
        },
        update(row: Record<string, unknown>) {
          assert.equal(table, "user_mcp_tool_audit_logs");
          audits.push({ ...row });
          return {
            async eq() {
              return { data: null, error: null };
            },
          };
        },
        then<T1 = Result, T2 = never>(
          onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
          onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
        ) {
          const result = {
            data:
              table === "user_mcp_connectors"
                ? [connectorRow]
                : table === "user_mcp_connector_tools"
                  ? tools
                  : null,
            error: null,
          };
          return Promise.resolve(result).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  } as unknown as Db;
  return {
    db,
    audits,
    connector: connectorRow,
    approvals: new MemoryApprovalPool(),
  };
}

const context = { actorEmail: "User@Example.com", toolCallId: "call-1" };

for (const role of ["user", "admin"] as const) {
  test(`Box write tools stay discoverable for ${role} with an approval notice`, async () => {
    const { buildUserMcpTools } =
      require("../src/lib/mcp/servers") as typeof import("../src/lib/mcp/servers");
    const rows = [
      "upload_file",
      "copy_file",
      "create_folder",
      "move_file",
      "rename_file",
      "create_shared_link",
      "delete_file",
      "unreviewed_operation",
    ].map((name) => tool(name));
    const { db } = fixture(role, rows);
    const result = await buildUserMcpTools("user-1", db);
    assert.deepEqual(
      result.map((entry) => entry.function.name).sort(),
      rows.map((row) => row.openai_tool_name).sort(),
    );
    for (const entry of result)
      assert.match(
        entry.function.description ?? "",
        /reviews and approves this exact action once/,
      );
  });

  test(`Box upload produces a pending approval for ${role} before contacting MCP`, async (t) => {
    const connect = t.mock.method(Client.prototype, "connect", async () => {});
    const { executeMcpToolCall } =
      require("../src/lib/mcp/servers") as typeof import("../src/lib/mcp/servers");
    const upload = tool("upload_file");
    const { db, approvals } = fixture(role, [upload]);
    const result = await executeMcpToolCall(
      "user-1",
      upload.openai_tool_name,
      { name: "draft.docx", parent_id: "folder-1" },
      db,
      context,
      approvals,
    );
    assert.equal(result.event.status, "approval_required");
    assert.equal(approvals.rows.size, 1);
    assert.equal(connect.mock.callCount(), 0);
  });
}

for (const role of ["user", "admin"] as const) {
  test(`Box write classification cannot bypass approval with stale or absent cache flags for ${role}`, async (t) => {
    const connect = t.mock.method(Client.prototype, "connect", async () => {});
    const callTool = t.mock.method(Client.prototype, "callTool", async () => ({
      structuredContent: { id: "unexpected-write" },
    }));
    t.mock.method(Client.prototype, "close", async () => {});
    const { buildUserMcpTools, executeMcpToolCall } =
      require("../src/lib/mcp/servers") as typeof import("../src/lib/mcp/servers");
    const names = [
      "upload_file",
      "copy_file",
      "create_folder",
      "move_file",
      "rename_file",
      "create_shared_link",
      "delete_file",
      "set_metadata",
      "get_upload_url",
      "unreviewed_operation",
    ];
    const annotationCases = [
      {},
      { readOnlyHint: false },
      { readOnlyHint: true },
    ];
    for (const name of names) {
      for (const annotations of annotationCases) {
        for (const requires_confirmation of [false, undefined] as const) {
          const row = tool(name, {
            annotations,
            requires_confirmation,
          } as Partial<ToolCacheRow>);
          const { db, approvals } = fixture(role, [row]);
          const visible = await buildUserMcpTools("user-1", db);
          assert.equal(visible.length, 1, name);
          assert.match(
            visible[0].function.description ?? "",
            /approves this exact action once/,
            name,
          );
          const result = await executeMcpToolCall(
            "user-1",
            row.openai_tool_name,
            { id: "file-1" },
            db,
            context,
            approvals,
          );
          assert.equal(
            result.event.status,
            "approval_required",
            `${name} with ${JSON.stringify({ annotations, requires_confirmation })}`,
          );
          assert.equal(approvals.rows.size, 1);
        }
      }
    }
    assert.equal(connect.mock.callCount(), 0);
    assert.equal(callTool.mock.callCount(), 0);
  });

  test(`Box executes the exact reviewed upload once for ${role} and rejects replay`, async (t) => {
    const connect = t.mock.method(Client.prototype, "connect", async () => {});
    const calls: unknown[] = [];
    t.mock.method(Client.prototype, "callTool", async (request: unknown) => {
      calls.push(request);
      return { structuredContent: { id: "uploaded-file-1" } };
    });
    t.mock.method(Client.prototype, "close", async () => {});
    const { executeMcpToolCall, executeMcpToolApproval } =
      require("../src/lib/mcp/servers") as typeof import("../src/lib/mcp/servers");
    const upload = tool("upload_file");
    const { db, approvals, audits } = fixture(role, [upload]);
    const args = {
      name: "draft.docx",
      parent: { id: "folder-1" },
      content: "reviewed bytes",
    };
    const originalArgs = structuredClone(args);
    const proposal = await executeMcpToolCall(
      "user-1",
      upload.openai_tool_name,
      args,
      db,
      context,
      approvals,
    );
    assert.equal(proposal.event.status, "approval_required");
    assert.equal(connect.mock.callCount(), 0);
    assert.equal(calls.length, 0);
    const row = approvals.rows.get(proposal.event.approval_id!);
    assert.ok(row);
    assert.deepEqual(row.arguments_preview, originalArgs);
    args.content = "later assistant change";
    args.parent.id = "different-folder";
    const result = await executeMcpToolApproval({
      approvalId: row.id,
      userId: "user-1",
      db,
      approvalDb: approvals,
    });
    assert.equal(result.approval.status, "succeeded", JSON.stringify(result));
    assert.equal(result.event.status, "ok", JSON.stringify(result));
    assert.deepEqual(calls, [{ name: "upload_file", arguments: originalArgs }]);
    assert.equal(connect.mock.callCount(), 1);
    assert.equal(audits[0].actor_email, "user@example.com");
    assert.equal(audits[0].status, "pending");
    assert.equal(audits.at(-1)?.status, "ok");
    await assert.rejects(
      executeMcpToolApproval({
        approvalId: row.id,
        userId: "user-1",
        db,
        approvalDb: approvals,
      }),
      /no longer pending/,
    );
    assert.equal(calls.length, 1);
  });
}

test("Box blocks missing actors and keeps disabled tools and connectors off", async (t) => {
  const connect = t.mock.method(Client.prototype, "connect", async () => {});
  const callTool = t.mock.method(Client.prototype, "callTool", async () => ({
    structuredContent: {},
  }));
  t.mock.method(Client.prototype, "close", async () => {});
  const { buildUserMcpTools, executeMcpToolCall } =
    require("../src/lib/mcp/servers") as typeof import("../src/lib/mcp/servers");
  for (const role of ["user", "admin"] as const) {
    const upload = tool("upload_file", { requires_confirmation: false });
    const { db, approvals } = fixture(role, [upload]);
    const missingActor = await executeMcpToolCall(
      "user-1",
      upload.openai_tool_name,
      {},
      db,
      {},
      approvals,
    );
    assert.equal(missingActor.event.status, "error");
    assert.match(
      missingActor.event.error ?? "",
      /session email was unavailable/,
    );
    assert.equal(approvals.rows.size, 0);
    upload.enabled = false;
    assert.deepEqual(await buildUserMcpTools("user-1", db), []);
    const disabled = await executeMcpToolCall(
      "user-1",
      upload.openai_tool_name,
      {},
      db,
      context,
      approvals,
    );
    assert.equal(disabled.event.status, "error");
    assert.equal(approvals.rows.size, 0);
  }
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(callTool.mock.callCount(), 0);
});

test("Box wrong-user, expired, rejected and tampered approvals fail before MCP", async (t) => {
  const connect = t.mock.method(Client.prototype, "connect", async () => {});
  const callTool = t.mock.method(Client.prototype, "callTool", async () => ({
    structuredContent: {},
  }));
  t.mock.method(Client.prototype, "close", async () => {});
  const { executeMcpToolCall, executeMcpToolApproval } =
    require("../src/lib/mcp/servers") as typeof import("../src/lib/mcp/servers");
  const { rejectMcpApproval, McpApprovalError } =
    await import("../src/lib/mcp/approvals");
  for (const scenario of [
    "wrong-user",
    "expired",
    "rejected",
    "hash",
    "preview",
  ] as const) {
    const upload = tool("upload_file");
    const { db, approvals } = fixture("admin", [upload]);
    const proposal = await executeMcpToolCall(
      "user-1",
      upload.openai_tool_name,
      { name: "draft.docx", parent_id: "folder-1" },
      db,
      context,
      approvals,
    );
    assert.equal(proposal.event.status, "approval_required");
    const row = approvals.rows.get(proposal.event.approval_id!);
    assert.ok(row);
    if (scenario === "expired") row.expires_at = new Date(Date.now() - 1);
    if (scenario === "rejected")
      await rejectMcpApproval({
        approvalId: row.id,
        userId: "user-1",
        pool: approvals,
      });
    if (scenario === "hash") row.arguments_hash = "00".repeat(32);
    if (scenario === "preview")
      row.arguments_preview = {
        name: "safe-looking-file.docx",
        parent_id: "different-folder",
      };
    const code =
      scenario === "wrong-user"
        ? "not_found"
        : scenario === "expired"
          ? "expired"
          : scenario === "rejected"
            ? "not_pending"
            : "integrity_failed";
    await assert.rejects(
      executeMcpToolApproval({
        approvalId: row.id,
        userId: scenario === "wrong-user" ? "different-user" : "user-1",
        db,
        approvalDb: approvals,
      }),
      (error: unknown) =>
        error instanceof McpApprovalError && error.code === code,
      scenario,
    );
    assert.equal(connect.mock.callCount(), 0, scenario);
    assert.equal(callTool.mock.callCount(), 0, scenario);
  }
});

test("Box approvals cannot execute after the reviewed tool, schema, endpoint or enabled state changes", async (t) => {
  const connect = t.mock.method(Client.prototype, "connect", async () => {});
  const callTool = t.mock.method(Client.prototype, "callTool", async () => ({
    structuredContent: {},
  }));
  t.mock.method(Client.prototype, "close", async () => {});
  const { executeMcpToolCall, executeMcpToolApproval } =
    require("../src/lib/mcp/servers") as typeof import("../src/lib/mcp/servers");
  for (const scenario of [
    "tool",
    "schema",
    "endpoint",
    "custom-connector",
    "tool-disabled",
    "connector-disabled",
  ] as const) {
    const upload = tool("upload_file");
    const {
      db,
      approvals,
      connector: currentConnector,
    } = fixture("admin", [upload]);
    const proposal = await executeMcpToolCall(
      "user-1",
      upload.openai_tool_name,
      { name: "draft.docx" },
      db,
      context,
      approvals,
    );
    assert.equal(proposal.event.status, "approval_required");
    if (scenario === "tool") upload.tool_name = "delete_file";
    if (scenario === "schema")
      upload.input_schema = {
        type: "object",
        properties: { overwrite: { type: "boolean", default: true } },
      };
    if (scenario === "endpoint")
      currentConnector.server_url = "https://1.1.1.1/mcp";
    if (scenario === "custom-connector") {
      currentConnector.tool_policy = {};
      currentConnector.server_url = "https://1.1.1.1/mcp";
    }
    if (scenario === "tool-disabled") upload.enabled = false;
    if (scenario === "connector-disabled") currentConnector.enabled = false;
    const result = await executeMcpToolApproval({
      approvalId: proposal.event.approval_id!,
      userId: "user-1",
      db,
      approvalDb: approvals,
    });
    assert.equal(result.event.status, "error", scenario);
    assert.equal(result.approval.status, "failed", scenario);
    assert.equal(connect.mock.callCount(), 0, scenario);
    assert.equal(callTool.mock.callCount(), 0, scenario);
  }
});

test("Documented Box reads remain available without approval, including when hints are absent", async (t) => {
  const connect = t.mock.method(Client.prototype, "connect", async () => {});
  const calls: unknown[] = [];
  t.mock.method(Client.prototype, "callTool", async (request: unknown) => {
    calls.push(request);
    return { structuredContent: { files: [] } };
  });
  t.mock.method(Client.prototype, "close", async () => {});
  const { buildUserMcpTools, executeMcpToolCall } =
    require("../src/lib/mcp/servers") as typeof import("../src/lib/mcp/servers");
  const names = [
    "search_files_keyword",
    "get_file_content",
    "who_am_i",
    "ai_qa_single_file",
    "ai_extract_structured",
  ];
  for (const role of ["user", "admin"] as const) {
    for (const name of names) {
      for (const annotations of [{ readOnlyHint: true }, {}]) {
        const read = tool(name, { requires_confirmation: false, annotations });
        const { db, approvals } = fixture(role, [read]);
        const visible = await buildUserMcpTools("user-1", db);
        assert.equal(visible.length, 1, name);
        assert.doesNotMatch(
          visible[0].function.description ?? "",
          /reviews and approves/,
          name,
        );
        const before = calls.length;
        const result = await executeMcpToolCall(
          "user-1",
          read.openai_tool_name,
          { query: "pleading" },
          db,
          {},
          approvals,
        );
        assert.equal(result.event.status, "ok", JSON.stringify(result));
        assert.equal(approvals.rows.size, 0);
        assert.deepEqual(calls[before], {
          name,
          arguments: { query: "pleading" },
        });
      }
    }
  }
  assert.equal(calls.length, 20);
  assert.equal(connect.mock.callCount(), 20);
});
