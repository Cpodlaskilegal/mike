import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorRow, Db, ToolCacheRow } from "../src/lib/mcp/types";

process.env.DATABASE_URL ??= "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

async function executeResolvedMcpToolCall(
  params: Parameters<
    typeof import("../src/lib/mcp/servers").executeResolvedMcpToolCall
  >[0],
) {
  const module = await import("../src/lib/mcp/servers");
  return module.executeResolvedMcpToolCall(params);
}

type AuditRow = Record<string, unknown>;

function fakeDb(options: { failInsert?: boolean; failUpdate?: boolean } = {}) {
  const rows: AuditRow[] = [];
  const updates: AuditRow[] = [];
  const db = {
    from(table: string) {
      assert.equal(table, "user_mcp_tool_audit_logs");
      return {
        insert(row: AuditRow) {
          const error = options.failInsert
            ? { message: "audit insert failed" }
            : null;
          if (!error) rows.push({ ...row });
          const result = {
            data: error ? null : { id: row.id ?? "read-audit" },
            error,
          };
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
        update(update: AuditRow) {
          return {
            async eq(column: string, value: unknown) {
              assert.equal(column, "id");
              updates.push({ ...update, id: value });
              return {
                error: options.failUpdate
                  ? { message: "audit update failed" }
                  : null,
              };
            },
          };
        },
      };
    },
  } as unknown as Db;
  return { db, rows, updates };
}

const connector: ConnectorRow = {
  id: "connector-1",
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
  created_at: "2026-07-22T00:00:00.000Z",
  updated_at: "2026-07-22T00:00:00.000Z",
};

function tool(overrides: Partial<ToolCacheRow> = {}): ToolCacheRow {
  return {
    id: "tool-1",
    connector_id: connector.id,
    tool_name: "Tasks_PostAccount",
    openai_tool_name: "mcp_practicepanther_tasks_posttask",
    title: "Create task",
    description: null,
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
    output_schema: null,
    annotations: { readOnlyHint: false },
    enabled: true,
    requires_confirmation: true,
    last_seen_at: "2026-07-22T00:00:00.000Z",
    ...overrides,
  };
}

const context = {
  actorEmail: "Mike.User@PodlaskiLegal.com",
  chatId: "chat-1",
  assistantMessageId: "message-1",
  assistantRunId: "run-1",
  traceId: "trace-1",
  projectId: "project-1",
  toolCallId: "call-1",
};

test("blocks a mutation when the authenticated session email is missing", async () => {
  const { db, rows } = fakeDb();
  let calls = 0;
  const result = await executeResolvedMcpToolCall({
    userId: "user-1",
    connector,
    tool: tool(),
    args: { subject: "Call client" },
    db,
    context: {},
    callTool: async () => {
      calls += 1;
      return {};
    },
  });

  assert.equal(result.event.status, "error");
  assert.match(result.event.error ?? "", /session email was unavailable/);
  assert.equal(calls, 0);
  assert.equal(rows.length, 0);
});

test("blocks a mutation when the fail-closed local audit insert fails", async () => {
  const { db } = fakeDb({ failInsert: true });
  let calls = 0;
  const result = await executeResolvedMcpToolCall({
    userId: "user-1",
    connector,
    tool: tool(),
    args: { subject: "Call client" },
    db,
    context,
    callTool: async () => {
      calls += 1;
      return {};
    },
  });

  assert.equal(result.event.status, "error");
  assert.match(result.event.error ?? "", /required actor audit record/);
  assert.equal(calls, 0);
});

test("blocks the primary mutation when the PracticePanther audit note cannot be created", async () => {
  const { db, rows, updates } = fakeDb();
  const calls: string[] = [];
  const result = await executeResolvedMcpToolCall({
    userId: "user-1",
    connector,
    tool: tool(),
    args: { subject: "Call client" },
    db,
    context,
    callTool: async (name) => {
      calls.push(name);
      return {
        isError: true,
        content: [{ type: "text", text: "note creation denied" }],
      };
    },
  });

  assert.deepEqual(calls, ["Notes_PostNote"]);
  assert.equal(result.event.status, "error");
  assert.match(result.event.error ?? "", /note creation denied/);
  assert.equal(rows[0].actor_email, "mike.user@podlaskilegal.com");
  assert.equal(rows[0].status, "pending");
  assert.equal(updates.at(-1)?.status, "error");
  assert.equal(updates.at(-1)?.practicepanther_audit_status, "failed");
});

test("records and tags a successful PracticePanther mutation in call order", async () => {
  const { db, rows, updates } = fakeDb();
  const calls: Array<{ name: string; args: AuditRow }> = [];
  const result = await executeResolvedMcpToolCall({
    userId: "user-1",
    connector,
    tool: tool(),
    args: { subject: "Call client", matter_ref: { id: "matter-1" } },
    db,
    context,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "Notes_PostNote") {
        return { structuredContent: { id: "note-1" } };
      }
      if (name === "Tasks_PostAccount") {
        return { structuredContent: { id: "task-1" } };
      }
      return { structuredContent: { id: "note-1" } };
    },
  });

  assert.deepEqual(
    calls.map((call) => call.name),
    ["Notes_PostNote", "Tasks_PostAccount", "Notes_PutNote"],
  );
  assert.match(
    String(calls[0].args.note),
    /Actor email: mike\.user@podlaskilegal\.com/,
  );
  assert.deepEqual(calls[0].args.matter_ref, { id: "matter-1" });
  assert.deepEqual(calls[1].args.tags, [
    "Docket actor: mike.user@podlaskilegal.com",
  ]);
  assert.match(String(calls[2].args.subject), /SUCCEEDED/);
  assert.equal(result.event.status, "ok");
  assert.equal(result.event.actor_email, "mike.user@podlaskilegal.com");
  assert.equal(result.event.practicepanther_audit_note_id, "note-1");
  assert.equal(result.event.practicepanther_audit_status, "finalized");
  assert.equal(rows[0].assistant_run_id, "run-1");
  assert.equal(rows[0].tool_call_id, "call-1");
  assert.equal(updates.at(-1)?.status, "ok");
  assert.equal(updates.at(-1)?.practicepanther_audit_status, "finalized");
  assert.deepEqual(updates.at(-1)?.target_refs, {
    resourceType: "Tasks",
    resourceId: "task-1",
    matterId: "matter-1",
  });
});

test("finalizes the PracticePanther note as failed when the primary mutation fails", async () => {
  const { db, updates } = fakeDb();
  const calls: Array<{ name: string; args: AuditRow }> = [];
  const result = await executeResolvedMcpToolCall({
    userId: "user-1",
    connector,
    tool: tool(),
    args: { subject: "Call client" },
    db,
    context,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "Notes_PostNote") {
        return { structuredContent: { id: "note-1" } };
      }
      if (name === "Tasks_PostAccount") {
        return {
          isError: true,
          content: [{ type: "text", text: "task write failed" }],
        };
      }
      return { structuredContent: { id: "note-1" } };
    },
  });

  assert.deepEqual(
    calls.map((call) => call.name),
    ["Notes_PostNote", "Tasks_PostAccount", "Notes_PutNote"],
  );
  assert.match(String(calls[2].args.subject), /FAILED/);
  assert.match(String(calls[2].args.note), /Error: task write failed/);
  assert.equal(result.event.status, "error");
  assert.equal(result.event.execution_outcome, "failed");
  assert.equal(result.event.practicepanther_audit_status, "finalized");
  assert.equal(updates.at(-1)?.status, "error");
});

test("marks a lost primary mutation response as outcome uncertain", async () => {
  const { db, updates } = fakeDb();
  const calls: Array<{ name: string; args: AuditRow }> = [];
  const result = await executeResolvedMcpToolCall({
    userId: "user-1",
    connector,
    tool: tool(),
    args: { subject: "Call client" },
    db,
    context,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "Notes_PostNote") {
        return { structuredContent: { id: "note-1" } };
      }
      if (name === "Tasks_PostAccount") {
        throw new Error("MCP request timed out after dispatch");
      }
      return { structuredContent: { id: "note-1" } };
    },
  });

  assert.deepEqual(
    calls.map((call) => call.name),
    ["Notes_PostNote", "Tasks_PostAccount", "Notes_PutNote"],
  );
  assert.match(String(calls[2].args.subject), /OUTCOME UNCERTAIN/);
  assert.equal(result.event.status, "error");
  assert.equal(result.event.execution_outcome, "indeterminate");
  assert.equal(updates.at(-1)?.status, "error");
});

test("keeps successful attribution visible when final note status cannot be updated", async () => {
  const { db, updates } = fakeDb();
  const result = await executeResolvedMcpToolCall({
    userId: "user-1",
    connector,
    tool: tool(),
    args: { subject: "Call client" },
    db,
    context,
    callTool: async (name) => {
      if (name === "Notes_PostNote") {
        return { structuredContent: { id: "note-1" } };
      }
      if (name === "Notes_PutNote") {
        return {
          isError: true,
          content: [{ type: "text", text: "note update denied" }],
        };
      }
      return { structuredContent: { id: "task-1" } };
    },
  });

  assert.equal(result.event.status, "ok");
  assert.equal(result.event.practicepanther_audit_note_id, "note-1");
  assert.equal(result.event.practicepanther_audit_status, "created");
  assert.match(result.event.attribution_warning ?? "", /could not finalize/);
  assert.equal(updates.at(-1)?.status, "ok");
  assert.equal(updates.at(-1)?.practicepanther_audit_status, "created");
});

test("read calls do not require an email or create a PracticePanther note", async () => {
  const { db, rows } = fakeDb();
  const calls: string[] = [];
  const result = await executeResolvedMcpToolCall({
    userId: "user-1",
    connector,
    tool: tool({
      tool_name: "Matters_GetMatters",
      annotations: { readOnlyHint: true },
      requires_confirmation: false,
    }),
    args: {},
    db,
    context: {},
    callTool: async (name) => {
      calls.push(name);
      return { structuredContent: { results: [] } };
    },
  });

  assert.deepEqual(calls, ["Matters_GetMatters"]);
  assert.equal(result.event.status, "ok");
  assert.equal(result.event.action_kind, "read");
  assert.equal(rows[0].practicepanther_audit_status, "not_required");
});
