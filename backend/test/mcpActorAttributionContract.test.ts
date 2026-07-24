import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const backendRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(backendRoot, "..");

function source(path: string) {
  return readFileSync(resolve(backendRoot, path), "utf8");
}

test("authenticated Entra email reaches every assistant MCP execution path", () => {
  const auth = source("src/middleware/auth.ts");
  const chatTools = source("src/lib/chatTools.ts");

  assert.match(auth, /const normalizedEmail = userEmail\.toLowerCase\(\)/);
  assert.match(auth, /res\.locals\.userEmail = normalizedEmail/);
  assert.match(chatTools, /actorEmail: userEmail/);
  assert.match(chatTools, /toolCallId: tc\.id/);

  for (const route of [
    "src/routes/chat.ts",
    "src/routes/projectChat.ts",
    "src/routes/tabular.ts",
  ]) {
    const routeSource = source(route);
    assert.match(routeSource, /const userEmail = res\.locals\.userEmail/);
    assert.match(routeSource, /runLLMStream\s*\(\s*\{[\s\S]*?userEmail,/);
  }
});

test("incremental and fresh schemas retain the durable actor-attribution contract", () => {
  const incremental = source("migrations/20260722_mcp_actor_attribution.sql");
  const fresh = source("migrations/azure_postgres_schema.sql");
  const databaseAdapter = source("src/lib/supabase.ts");

  for (const schema of [incremental, fresh]) {
    assert.match(schema, /actor_email text/);
    assert.match(schema, /action_kind/);
    assert.match(schema, /target_refs jsonb/);
    assert.match(schema, /practicepanther_audit_note_id text/);
    assert.match(schema, /assistant_run_id text/);
    assert.match(schema, /tool_call_id text/);
    assert.match(schema, /action_kind = 'mutation'/);
    assert.match(schema, /assistant_message_id, tool_call_id/);
  }
  assert.match(
    databaseAdapter,
    /user_mcp_tool_audit_logs: new Set\(\["target_refs"\]\)/,
  );
});

test("the UI surfaces the session actor and PracticePanther audit note", () => {
  const eventTypes = readFileSync(
    resolve(repoRoot, "frontend/src/app/components/shared/types.ts"),
    "utf8",
  );
  const eventBlocks = readFileSync(
    resolve(
      repoRoot,
      "frontend/src/app/components/assistant/message/EventBlocks.tsx",
    ),
    "utf8",
  );

  assert.match(eventTypes, /actor_email\?: string/);
  assert.match(eventTypes, /practicepanther_audit_note_id\?: string/);
  assert.match(eventBlocks, /change as \$\{event\.actor_email\}/);
  assert.match(
    eventBlocks,
    /PP audit note \$\{event\.practicepanther_audit_note_id\}/,
  );
});
