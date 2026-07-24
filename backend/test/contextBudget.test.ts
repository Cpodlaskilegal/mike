import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

test("chat history compaction is deterministic and preserves the latest request", async () => {
  const { ASSISTANT_CONTEXT_LIMITS, compactChatHistory } =
    await import("../src/lib/chatTools");
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `old-${index}-start ${String(index).repeat(90_000)} old-${index}-end`,
  }));
  messages.push({
    role: "user",
    content: `CURRENT-REQUEST-START ${"z".repeat(110_000)} CURRENT-REQUEST-END`,
  });

  const first = compactChatHistory(messages);
  const second = compactChatHistory(messages);

  assert.deepEqual(first, second);
  assert.ok(first.omittedMessages > 0);
  assert.match(first.compactedPrefix ?? "", /compacted deterministically/);
  assert.equal(first.messages.at(-1)?.role, "user");
  assert.match(first.messages.at(-1)?.content ?? "", /CURRENT-REQUEST-START/);
  assert.match(first.messages.at(-1)?.content ?? "", /CURRENT-REQUEST-END/);

  const budgetedChars =
    (first.compactedPrefix?.length ?? 0) +
    first.messages.reduce(
      (total, message) =>
        total + message.content.length + message.role.length + 32,
      0,
    );
  assert.ok(budgetedChars <= ASSISTANT_CONTEXT_LIMITS.historyChars);
});

test("buildMessages injects the compacted prefix before retained history", async () => {
  const { buildMessages } = await import("../src/lib/chatTools");
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index}:${"x".repeat(70_000)}`,
  }));
  messages.push({ role: "user", content: "latest question" });

  const built = buildMessages(messages, []) as {
    role: string;
    content: string;
  }[];

  assert.equal(built[0].role, "system");
  assert.equal(built[1].role, "user");
  assert.match(built[1].content, /Earlier conversation compacted/);
  assert.equal(built.at(-1)?.content, "latest question");
});

test("document context keeps deterministic head and tail within its strict cap", async () => {
  const { truncateDocumentForContext } = await import("../src/lib/chatTools");
  const content = `${"A".repeat(2_000)}${"M".repeat(8_000)}${"Z".repeat(2_000)}`;

  const first = truncateDocumentForContext(content, "brief.pdf", 1_000);
  const second = truncateDocumentForContext(content, "brief.pdf", 1_000);

  assert.equal(first, second);
  assert.equal(first.length, 1_000);
  assert.ok(first.startsWith("A"));
  assert.ok(first.endsWith("Z"));
  assert.match(first, /DOCUMENT CONTENT TRUNCATED/);
  assert.match(first, /find_in_document/);
});

test("tool-result budget enforces both per-result and cumulative turn caps", async () => {
  const {
    ASSISTANT_CONTEXT_LIMITS,
    budgetToolResultContent,
    createToolResultContextBudget,
  } = await import("../src/lib/chatTools");

  const defaultBudget = createToolResultContextBudget();
  const oneLargeResult = budgetToolResultContent(
    "r".repeat(ASSISTANT_CONTEXT_LIMITS.toolResultChars + 50_000),
    "read_document",
    defaultBudget,
  );
  assert.equal(oneLargeResult.length, ASSISTANT_CONTEXT_LIMITS.toolResultChars);
  assert.match(oneLargeResult, /TOOL RESULT TRUNCATED/);

  const smallBudget = createToolResultContextBudget(500);
  const first = budgetToolResultContent(
    "a".repeat(400),
    "first_tool",
    smallBudget,
  );
  const second = budgetToolResultContent(
    "b".repeat(400),
    "second_tool",
    smallBudget,
  );
  const third = budgetToolResultContent(
    "c".repeat(10),
    "third_tool",
    smallBudget,
  );
  assert.equal(first.length + second.length + third.length, 500);
  assert.equal(smallBudget.usedChars, 500);
  assert.match(second, /TOOL RESULT TRUNCATED/);
  assert.equal(third, "");
});

test("runToolCalls applies the provider-facing cap to oversized tool output", async () => {
  const {
    ASSISTANT_CONTEXT_LIMITS,
    createToolResultContextBudget,
    runToolCalls,
  } = await import("../src/lib/chatTools");
  const docStore = new Map(
    Array.from({ length: 4_000 }, (_, index) => [
      `doc-${index}`,
      {
        filename: `document-${index}-${"n".repeat(100)}.pdf`,
        file_type: "pdf",
        storage_path: `documents/${index}.pdf`,
      },
    ]),
  );
  const budget = createToolResultContextBudget();

  const result = await runToolCalls(
    [
      {
        id: "call-list",
        function: { name: "list_documents", arguments: "{}" },
      },
    ],
    docStore,
    "user-1",
    {} as never,
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    budget,
  );

  const content = String(
    (result.toolResults[0] as { content?: unknown }).content ?? "",
  );
  assert.equal(content.length, ASSISTANT_CONTEXT_LIMITS.toolResultChars);
  assert.match(content, /TOOL RESULT TRUNCATED/);
});

test("fetch_documents schema exposes the runtime document-count cap", async () => {
  const { ASSISTANT_CONTEXT_LIMITS, PROJECT_EXTRA_TOOLS } =
    await import("../src/lib/chatTools");
  const fetchDocuments = PROJECT_EXTRA_TOOLS.find(
    (tool) => tool.function.name === "fetch_documents",
  );
  const docIds = (
    fetchDocuments?.function.parameters as {
      properties?: { doc_ids?: { maxItems?: number } };
    }
  ).properties?.doc_ids;

  assert.equal(docIds?.maxItems, ASSISTANT_CONTEXT_LIMITS.fetchedDocumentCount);
});
