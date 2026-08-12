import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

test("account export includes content-free native mailbox audit records", async () => {
  const [{ buildDocketDataExport }, { pool }] = await Promise.all([
    import("../src/lib/userDataLifecycle"),
    import("../src/lib/supabase"),
  ]);
  const originalQuery = pool.query;
  let nativeAuditSql = "";
  const auditRow = {
    id: "audit-1",
    actor_email: "user@example.com",
    tool_namespace: "microsoft_graph_mail",
    tool_name: "search_own_email",
    status: "ok",
    error_code: null,
    duration_ms: 12,
    result_size_chars: 321,
    target_ref_hash: null,
    chat_id: "chat-1",
    assistant_message_id: "message-1",
    assistant_run_id: "run-1",
    trace_id: "trace-1",
    project_id: null,
    tool_call_id: "call-1",
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  };

  pool.query = (async (sql: unknown, params?: unknown[]) => {
    assert.deepEqual(params, ["user-1"]);
    const text = String(sql);
    if (/from\s+assistant_native_tool_audit_logs/i.test(text)) {
      nativeAuditSql = text;
      return { rows: [auditRow], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof pool.query;

  try {
    const exported = await buildDocketDataExport(
      "account",
      "user-1",
      "user@example.com",
    );
    assert.deepEqual(exported.assistant_native_tool_audit_logs, [auditRow]);
    assert.match(nativeAuditSql, /where\s+user_id\s*=\s*\$1/i);
    assert.doesNotMatch(
      nativeAuditSql,
      /\b(query|body|access_token|refresh_token)\b/i,
    );
  } finally {
    pool.query = originalQuery;
  }
});

test("approved Docket data deletion removes the user's native mailbox audit records", async () => {
  const [{ executeApprovedDataDeletion }, { pool }] = await Promise.all([
    import("../src/lib/userDataLifecycle"),
    import("../src/lib/supabase"),
  ]);
  const originalConnect = pool.connect;
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  let released = false;
  const client = {
    async query(sql: string, params?: unknown[]) {
      statements.push({ sql, params });
      if (
        /from\s+data_deletion_requests/i.test(sql) &&
        /status\s*=\s*'approved'/i.test(sql)
      ) {
        return {
          rows: [
            {
              id: "request-1",
              user_id: "user-1",
              legal_hold: false,
              retention_until: null,
              workflow_submission_disposition: "retain",
            },
          ],
        };
      }
      if (/select\s+email\s+from\s+app_users/i.test(sql)) {
        return { rows: [{ email: "user@example.com" }] };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  pool.connect = (async () => client) as typeof pool.connect;

  try {
    await executeApprovedDataDeletion({
      requestId: "request-1",
      executorUserId: "admin-1",
    });
  } finally {
    pool.connect = originalConnect;
  }

  const normalized = statements.map(({ sql }) =>
    sql.replace(/\s+/g, " ").trim(),
  );
  const auditDeleteIndex = normalized.findIndex((sql) =>
    /^delete from assistant_native_tool_audit_logs where user_id = \$1$/i.test(
      sql,
    ),
  );
  const tombstoneIndex = normalized.findIndex((sql) =>
    /^update app_users set docket_data_status = 'deleted'/i.test(sql),
  );
  const commitIndex = normalized.findIndex((sql) => /^commit$/i.test(sql));
  assert.ok(auditDeleteIndex >= 0, "native mailbox audit rows must be deleted");
  assert.deepEqual(statements[auditDeleteIndex].params, ["user-1"]);
  assert.ok(auditDeleteIndex < tombstoneIndex);
  assert.ok(tombstoneIndex < commitIndex);
  assert.equal(released, true);
});

test("incremental and fresh schemas define the same content-free mailbox audit table", () => {
  for (const relativePath of [
    "migrations/20260812_assistant_native_tool_audit_logs.sql",
    "migrations/azure_postgres_schema.sql",
    "schema.sql",
  ]) {
    const sql = readFileSync(
      resolve(import.meta.dirname, "..", relativePath),
      "utf8",
    );
    const table = sql.match(
      /create table if not exists public\.assistant_native_tool_audit_logs\s*\(([\s\S]*?)\n\);/i,
    )?.[1];
    assert.ok(table, `${relativePath} must create the native tool audit table`);
    for (const column of [
      "user_id",
      "actor_email",
      "tool_namespace",
      "tool_name",
      "status",
      "error_code",
      "duration_ms",
      "result_size_chars",
      "target_ref_hash",
      "chat_id",
      "assistant_message_id",
      "assistant_run_id",
      "trace_id",
      "project_id",
      "tool_call_id",
      "created_at",
      "updated_at",
    ]) {
      assert.match(table, new RegExp(`\\b${column}\\b`, "i"));
    }
    assert.doesNotMatch(
      table,
      /\b(query|body|token|access_token|refresh_token|message_subject)\b/i,
    );
  }
});

test("incremental and fresh schemas mark mailbox chats as owner-private and standalone", () => {
  for (const relativePath of [
    "migrations/20260812_assistant_native_tool_audit_logs.sql",
    "migrations/azure_postgres_schema.sql",
    "schema.sql",
  ]) {
    const sql = readFileSync(
      resolve(import.meta.dirname, "..", relativePath),
      "utf8",
    );
    assert.match(
      sql,
      /contains_mailbox_data\s+boolean\s+not null\s+default false/i,
    );
    assert.match(
      sql,
      /check\s*\(not contains_mailbox_data or project_id is null\)/i,
    );
    assert.match(sql, /where\s+contains_mailbox_data/i);
  }
});
