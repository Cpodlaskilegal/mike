import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

test("Ask Inputs tool persists a durable event and stops later tools in its batch", async () => {
  const { runToolCalls } = await import("../src/lib/chatTools");
  const inserts: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      assert.equal(table, "assistant_input_requests");
      return {
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { data: row, error: null };
        },
      };
    },
  };
  const lines: string[] = [];
  const result = await runToolCalls(
    [
      {
        id: "call_ask_1",
        function: {
          name: "ask_inputs",
          arguments: JSON.stringify({
            items: [
              {
                id: "governing-law",
                kind: "choice",
                question: "Which law governs?",
                options: ["Indiana", "Illinois"],
              },
            ],
          }),
        },
      },
      {
        id: "call_later_tool",
        function: { name: "list_documents", arguments: "{}" },
      },
    ],
    new Map(),
    "entra-user-1",
    db as any,
    (line: string) => lines.push(line),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { chatId: "chat-1", assistantMessageId: "assistant-message-1" },
  );

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].chat_id, "chat-1");
  assert.equal(inserts[0].assistant_message_id, "assistant-message-1");
  assert.match(String(inserts[0].id), /^ask-call_ask_1$/);
  assert.equal(result.askInputsEvents.length, 1);
  assert.match(lines.join(""), /"type":"ask_inputs"/);
  assert.equal(result.toolResults.length, 1, "later tools must not run before inputs arrive");
});

test("assistant runtime keeps Ask Inputs pause and live rich-citation plumbing", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../src/lib/chatTools.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /ASK_INPUTS_TOOL/);
  assert.match(source, /persistAskInputsRequest/);
  assert.match(source, /AskInputsPauseError/);
  assert.match(source, /streamPartialRichCitations/);
  assert.match(source, /assistantMessageId/);
});
