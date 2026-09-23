import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

const backendRoot = new URL("..", import.meta.url).pathname;

function fakeReadDb(
  results: Record<
    string,
    { data: Record<string, unknown> | null; error: null | { message: string } }
  >,
) {
  return {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve(results[table]);
        },
      };
    },
  };
}

function fakeWriteDb(
  result: { data: Record<string, unknown> | null; error: null | { message: string } },
) {
  const calls: { table: string; row: Record<string, unknown>; conflict: string }[] = [];
  return {
    calls,
    from(table: string) {
      return {
        upsert(row: Record<string, unknown>, options: { onConflict: string }) {
          calls.push({ table, row, conflict: options.onConflict });
          return this;
        },
        select() { return this; },
        single() { return Promise.resolve(result); },
      };
    },
  };
}

test("custom instruction payloads are trimmed, bounded, and may be cleared", async () => {
  const { parseCustomInstructionsBody, CUSTOM_INSTRUCTIONS_MAX_LENGTH } =
    await import("../src/lib/userInstructions");
  assert.deepEqual(
    parseCustomInstructionsBody({ instructions: "  Use short paragraphs.  " }),
    {
      ok: true,
      instructions: "Use short paragraphs.",
    },
  );
  assert.deepEqual(parseCustomInstructionsBody({ instructions: " \n " }), {
    ok: true,
    instructions: "",
  });
  assert.equal(
    parseCustomInstructionsBody({
      instructions: "x".repeat(CUSTOM_INSTRUCTIONS_MAX_LENGTH),
    }).ok,
    true,
  );
  assert.equal(
    parseCustomInstructionsBody({
      instructions: "x".repeat(CUSTOM_INSTRUCTIONS_MAX_LENGTH + 1),
    }).ok,
    false,
  );
  assert.equal(parseCustomInstructionsBody({ instructions: null }).ok, false);
  assert.equal(
    parseCustomInstructionsBody({ instructions: "a", role: "admin" }).ok,
    false,
  );
});

test("instruction reads use empty text only for absent rows", async () => {
  const { getEffectiveCustomInstructions } =
    await import("../src/lib/userInstructions");
  const loaded = await getEffectiveCustomInstructions(
    "user-1",
    fakeReadDb({
      user_profiles: {
        data: { personal_instructions: "My style" },
        error: null,
      },
      firm_instructions: { data: { instructions: "Firm policy" }, error: null },
    }) as never,
  );
  assert.deepEqual(loaded, {
    personalInstructions: "My style",
    firmInstructions: "Firm policy",
  });
  const empty = await getEffectiveCustomInstructions(
    "user-1",
    fakeReadDb({
      user_profiles: { data: null, error: null },
      firm_instructions: { data: null, error: null },
    }) as never,
  );
  assert.deepEqual(empty, { personalInstructions: "", firmInstructions: "" });
});

test("instruction reads fail closed on either database error or malformed values", async () => {
  const { getEffectiveCustomInstructions } =
    await import("../src/lib/userInstructions");
  const good = { data: { instructions: "Firm policy" }, error: null };
  await assert.rejects(() =>
    getEffectiveCustomInstructions(
      "user-1",
      fakeReadDb({
        user_profiles: { data: null, error: { message: "column missing" } },
        firm_instructions: good,
      }) as never,
    ),
  );
  await assert.rejects(() =>
    getEffectiveCustomInstructions(
      "user-1",
      fakeReadDb({
        user_profiles: { data: { personal_instructions: "mine" }, error: null },
        firm_instructions: { data: null, error: { message: "table missing" } },
      }) as never,
    ),
  );
  await assert.rejects(() =>
    getEffectiveCustomInstructions(
      "user-1",
      fakeReadDb({
        user_profiles: { data: { personal_instructions: null }, error: null },
        firm_instructions: good,
      }) as never,
    ),
  );
});

test("personal and firm saves target separate rows and report database failures", async () => {
  const { savePersonalInstructions, saveFirmInstructions } =
    await import("../src/lib/userInstructions");
  const personalDb = fakeWriteDb({
    data: { personal_instructions: "Short answers" }, error: null,
  });
  assert.equal(
    await savePersonalInstructions("user-1", "Short answers", personalDb as never),
    "Short answers",
  );
  assert.equal(personalDb.calls.length, 1);
  assert.equal(personalDb.calls[0].table, "user_profiles");
  assert.equal(personalDb.calls[0].conflict, "user_id");
  assert.equal(personalDb.calls[0].row.user_id, "user-1");
  assert.equal(personalDb.calls[0].row.personal_instructions, "Short answers");

  const firmDb = fakeWriteDb({ data: { instructions: "Firm style" }, error: null });
  assert.equal(
    await saveFirmInstructions("admin-1", "Firm style", firmDb as never),
    "Firm style",
  );
  assert.equal(firmDb.calls.length, 1);
  assert.equal(firmDb.calls[0].table, "firm_instructions");
  assert.equal(firmDb.calls[0].conflict, "id");
  assert.equal(firmDb.calls[0].row.id, 1);
  assert.equal(firmDb.calls[0].row.updated_by_user_id, "admin-1");

  const failedDb = fakeWriteDb({ data: null, error: { message: "database unavailable" } });
  await assert.rejects(() => savePersonalInstructions("user-1", "text", failedDb as never));
  await assert.rejects(() => saveFirmInstructions("admin-1", "text", failedDb as never));
});

test("instruction routes require authentication and firm updates require admin", () => {
  const source = readFileSync(join(backendRoot, "src/routes/user.ts"), "utf8");
  assert.match(source, /userRouter\.get\("\/instructions", requireAuth,/);
  assert.match(
    source,
    /userRouter\.put\("\/instructions\/personal", requireAuth,/,
  );
  assert.match(
    source,
    /userRouter\.put\(\s*"\/instructions\/firm",\s*requireAuth,\s*requireAdmin,/,
  );
});

test("personal instructions are included in account export", () => {
  const source = readFileSync(
    join(backendRoot, "src/lib/userDataLifecycle.ts"),
    "utf8",
  );
  assert.match(
    source,
    /select display_name, organisation, personal_instructions, tier,/,
  );
});
