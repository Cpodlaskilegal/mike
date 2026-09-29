import assert from "node:assert/strict";
import test from "node:test";
import { checkProjectAccess } from "../src/lib/access";

process.env.DATABASE_URL ??= "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

function transactionDb(failure?: "audit" | "commit") {
  let row = { user_id: "owner", instructions: "", instruction_version: 0 };
  let history: unknown[][] = [];
  let snapshot: typeof row | null = null;
  const calls: string[] = [];
  return { calls, get row() { return row; }, get history() { return history; },
    database: { async connect() { return {
      async query(sql: string, params: unknown[] = []) {
        calls.push(sql);
        if (sql === "BEGIN") snapshot = { ...row };
        if (sql.startsWith("select")) return { rows: [{ ...row }] };
        if (sql.startsWith("update")) row = { ...row, instructions: String(params[1]), instruction_version: Number(params[2]) };
        if (sql.startsWith("insert")) {
          if (failure === "audit") throw new Error("synthetic audit outage");
          history.push(params);
        }
        if (sql === "ROLLBACK" && snapshot) { row = snapshot; history = []; }
        if (sql === "COMMIT" && failure === "commit") throw new Error("synthetic uncertain commit");
        return { rows: [] };
      }, release() { calls.push("release"); },
    }; } } as never,
  };
}

const input = { projectId: "project-1", userId: "owner", userEmail: "owner@example.com", instructions: "Use six summary headings.", expectedVersion: 0 };

test("owner saves and clears instructions with an atomic version and audit row", async () => {
  const { saveProjectInstructions } = await import("../src/lib/projectInstructions");
  const db = transactionDb();
  const saved = await saveProjectInstructions(input, db.database);
  assert.equal(saved.version, 1);
  assert.equal(saved.can_edit, true);
  assert.equal(db.history.length, 1);
  assert.deepEqual(db.history[0], [input.projectId, 1, input.instructions, "owner", input.userEmail]);
  assert.ok(db.calls.find((sql) => sql.includes("for update")));
  const cleared = await saveProjectInstructions({ ...input, instructions: "", expectedVersion: 1 }, db.database);
  assert.equal(cleared.version, 2);
  assert.equal(db.history.length, 2);
  assert.equal(db.history[1][2], "");
});

test("non-owner and stale concurrent edits leave content/history unchanged", async () => {
  const { saveProjectInstructions, ProjectInstructionsError } = await import("../src/lib/projectInstructions");
  for (const [userId, expectedVersion, status] of [["member", 0, 403], ["owner", 8, 409]] as const) {
    const db = transactionDb();
    await assert.rejects(() => saveProjectInstructions({ ...input, userId, expectedVersion }, db.database),
      (error: unknown) => error instanceof ProjectInstructionsError && error.status === status);
    assert.equal(db.row.instructions, "");
    assert.equal(db.history.length, 0);
    assert.ok(db.calls.includes("ROLLBACK"));
  }
});

test("audit failure rolls back content and uncertain commits require reload", async () => {
  const { saveProjectInstructions } = await import("../src/lib/projectInstructions");
  const db = transactionDb("audit");
  await assert.rejects(() => saveProjectInstructions(input, db.database));
  assert.equal(db.row.instruction_version, 0);
  assert.equal(db.row.instructions, "");
  assert.ok(db.calls.includes("ROLLBACK"));
  await assert.rejects(() => saveProjectInstructions(input, transactionDb("commit").database));
});

test("instruction body is bounded, versioned and rejects unrelated fields", async () => {
  const { parseProjectInstructionsBody } = await import("../src/lib/projectInstructions");
  assert.deepEqual(parseProjectInstructionsBody({ instructions: "  Summary  ", expected_version: 1 }), { ok: true, instructions: "Summary", expectedVersion: 1 });
  assert.equal(parseProjectInstructionsBody({ instructions: "x".repeat(5000), expected_version: 0 }).ok, true);
  for (const body of [{ instructions: "x".repeat(5001), expected_version: 0 }, { instructions: "text" }, { instructions: "text", expected_version: -1 }, { instructions: "text", expected_version: 0, user_id: "owner" }]) {
    assert.equal(parseProjectInstructionsBody(body).ok, false);
  }
});

test("current membership governs read access; revoked member cannot read and owner retains edit permission", async () => {
  let shared = ["member@example.com"];
  const db = { from() {
    return { select() { return this; }, eq() { return this; }, async single() { return { data: { id: "project-1", user_id: "owner", shared_with: shared } }; } };
  } } as never;
  assert.equal((await checkProjectAccess("project-1", "member", "MEMBER@example.com", db)).ok, true);
  shared = [];
  assert.equal((await checkProjectAccess("project-1", "member", "member@example.com", db)).ok, false);
  const owner = await checkProjectAccess("project-1", "owner", "owner@example.com", db);
  assert.equal(owner.ok && owner.isOwner, true);
});

test("project reads fail closed instead of treating a database outage as empty instructions", async () => {
  const { getProjectInstructions } = await import("../src/lib/projectInstructions");
  const db = { from() { return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null, error: { message: "synthetic outage" } }; } }; } } as never;
  await assert.rejects(() => getProjectInstructions("project-1", "owner", db), /Unable to load/);
});

test("both prompt assembly paths apply project instructions below firm rules with the saved version", async () => {
  const { buildMessages } = await import("../src/lib/chatTools");
  for (const context of [undefined, "Project matter context"]) {
    const messages = buildMessages([{ role: "user", content: "Synthetic summary" }], [], context, undefined, false, {
      firmInstructions: "Firm rule", projectInstructions: input.instructions, projectInstructionVersion: 4, personalInstructions: "Personal preference",
    }) as { role: string; content: string }[];
    assert.ok(messages[0].content.indexOf("Firm rule") < messages[0].content.indexOf(input.instructions));
    assert.match(messages[0].content, /PROJECT CUSTOM INSTRUCTIONS \(version 4\)/);
    assert.match(messages[0].content, /firm-wide instructions, project instructions, personal preferences/);
    assert.equal(messages[1].role, "user");
    assert.match(messages[1].content, /subordinate to Docket, firm-wide and project rules/);
  }
});
