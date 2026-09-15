import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import type { StreamChatParams } from "../src/lib/llm";

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

type Row = Record<string, unknown>;

function scopedWorkflowDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      assert.ok(table in tables, `Unexpected database access: ${table}`);
      let rows = [...tables[table]];
      const query = {
        select() {
          return query;
        },
        eq(key: string, value: unknown) {
          rows = rows.filter((row) => row[key] === value);
          return query;
        },
        in(key: string, values: unknown[]) {
          rows = rows.filter((row) => values.includes(row[key]));
          return query;
        },
        then(resolve: (value: { data: Row[]; error: null }) => unknown) {
          return Promise.resolve(resolve({ data: rows, error: null }));
        },
      };
      return query;
    },
  };
}

test("limited-access turns describe actual sources without inheriting CMA permissions", async () => {
  const { buildTurnCapabilityContext, TOOLS, WORKFLOW_TOOLS } =
    await import("../src/lib/chatTools");
  const prompt = buildTurnCapabilityContext([...TOOLS, ...WORKFLOW_TOOLS]);

  assert.match(prompt, /CourtListener case-law tools are unavailable/);
  assert.match(prompt, /native own-mailbox tools are unavailable/);
  assert.match(prompt, /no connector tools are offered/);
  assert.match(prompt, /Project-wide discovery is unavailable/);
  assert.match(prompt, /do not grant access or authorize external actions/);
  assert.match(prompt, /CMA, firm, filesystem, mailbox, or service access/);
  assert.match(prompt, /tracked changes to an available DOCX/);
  assert.match(prompt, /ask a concise question in chat/);
  assert.doesNotMatch(prompt, /case-law tools are offered|mailbox are offered/);
});

test("available research, project, and mailbox tools remain bounded by their real scope", async () => {
  const { buildTurnCapabilityContext, TOOLS, PROJECT_EXTRA_TOOLS } =
    await import("../src/lib/chatTools");
  const { COURTLISTENER_TOOLS } =
    await import("../src/lib/legalSourcesTools/courtlistenerTools");
  const { OWN_MAILBOX_TOOLS } = await import("../src/lib/ownMailboxTools");
  const prompt = buildTurnCapabilityContext([
    ...TOOLS,
    ...PROJECT_EXTRA_TOOLS,
    ...COURTLISTENER_TOOLS,
    ...OWN_MAILBOX_TOOLS,
    { function: { name: "mcp_user_matter_read", parameters: {} } },
    { function: { name: "ask_inputs", parameters: {} } },
  ]);

  assert.match(prompt, /project discovery is available within this accessible project/);
  assert.match(prompt, /CourtListener case-law tools are offered/);
  assert.match(prompt, /not a comprehensive statutory database, citator, or general web browser/);
  assert.match(prompt, /signed-in user's own mailbox/);
  assert.match(prompt, /success still depends on delegated access/);
  assert.match(prompt, /only the offered connector tools/);
  assert.match(prompt, /Preserve every required approval/);
  assert.match(prompt, /use ask_inputs/);
  assert.doesNotMatch(prompt, /case-law tools are unavailable|no connector tools are offered/);
});

test("server workflow resolution includes only built-ins, owned, and explicitly shared assistants", async () => {
  const { buildWorkflowStore, runToolCalls } = await import("../src/lib/chatTools");
  const { SYSTEM_ASSISTANT_WORKFLOWS } = await import("../src/lib/systemWorkflows");
  const drafting = SYSTEM_ASSISTANT_WORKFLOWS.find(
    (workflow) => workflow.id === "builtin-legal-drafting",
  )!;
  const redline = SYSTEM_ASSISTANT_WORKFLOWS.find(
    (workflow) => workflow.id === "builtin-surgical-redline",
  )!;
  assert.ok(drafting);
  assert.ok(redline);
  const workflow = (id: string, owner: string, prompt: string, type = "assistant") => ({
    id, user_id: owner, title: id, prompt_md: prompt, type,
  });
  const db = scopedWorkflowDb({
    workflows: [
      workflow("mine", "alice", "Alice instructions"),
      workflow("shared", "bob", "Shared instructions"),
      workflow("private", "bob", "PRIVATE SENTINEL"),
      workflow("tabular", "alice", "TABULAR SENTINEL", "tabular"),
      workflow(drafting.id, "alice", "OWNED OVERRIDE SENTINEL"),
      workflow(redline.id, "bob", "SHARED OVERRIDE SENTINEL"),
    ],
    workflow_shares: [
      { workflow_id: "shared", shared_with_email: "alice@example.test" },
      { workflow_id: redline.id, shared_with_email: "alice@example.test" },
      { workflow_id: "private", shared_with_email: "charlie@example.test" },
    ],
  }) as unknown as Parameters<typeof buildWorkflowStore>[2];
  const store = await buildWorkflowStore("alice", "  ALICE@EXAMPLE.TEST ", db);

  assert.equal(store.get("mine")?.prompt_md, "Alice instructions");
  assert.equal(store.get("shared")?.prompt_md, "Shared instructions");
  assert.equal(store.has("private"), false);
  assert.equal(store.has("tabular"), false);
  assert.equal(store.get(drafting.id)?.prompt_md, drafting.prompt_md);
  assert.equal(store.get(redline.id)?.prompt_md, redline.prompt_md);

  const result = await runToolCalls(
    [drafting.id, "private"].map((id) => ({
      id,
      function: { name: "read_workflow", arguments: JSON.stringify({ workflow_id: id }) },
    })),
    new Map(), "alice", db, () => undefined, store,
  );
  assert.equal((result.toolResults[0] as { content: string }).content, drafting.prompt_md);
  assert.equal((result.toolResults[1] as { content: string }).content, "Workflow 'private' not found.");
  assert.deepEqual(result.workflowsApplied, [{ workflow_id: drafting.id, title: drafting.title }]);

  const withoutEmail = await buildWorkflowStore("alice", null, db);
  assert.equal(withoutEmail.has("shared"), false);
});

test("unoffered research, mailbox, project, and connector calls cannot execute during a workflow", async () => {
  const { runToolCalls } = await import("../src/lib/chatTools");
  const blockedNames = [
    "courtlistener_search_case_law",
    "read_own_email",
    "replicate_document",
    "mcp_private_matter_write",
  ];
  const calls = [...blockedNames, "read_workflow"].map((name) => ({
    id: name,
    function: {
      name,
      arguments: JSON.stringify({ query: "matter", workflow_id: "selected", doc_id: "doc-0" }),
    },
  }));
  const parameters: unknown[] = [
    calls,
    new Map(),
    "alice",
    { from() { throw new Error("Denied tools must not access the database"); } },
    () => undefined,
    new Map([["selected", { title: "Selected", prompt_md: "Use only supplied sources." }]]),
  ];
  parameters[17] = async () => { throw new Error("Denied connector must not execute"); };
  parameters[19] = async () => { throw new Error("Denied mailbox tool must not execute"); };
  parameters[21] = new Set(["read_workflow"]);
  const result = await (
    runToolCalls as unknown as (...args: unknown[]) => ReturnType<typeof runToolCalls>
  )(...parameters);

  assert.equal(result.toolResults.length, calls.length);
  for (const row of result.toolResults.slice(0, blockedNames.length)) {
    const payload = JSON.parse((row as { content: string }).content);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "tool_not_available");
  }
  assert.equal((result.toolResults.at(-1) as { content: string }).content, "Use only supplied sources.");
  assert.deepEqual(result.workflowsApplied, [{ workflow_id: "selected", title: "Selected" }]);
  assert.deepEqual(result.courtlistenerEvents, []);
  assert.deepEqual(result.mcpEvents, []);
  assert.deepEqual(result.docsReplicated, []);
});

test("selected workflow stays first when the same message includes attachments", async () => {
  const { buildMessages } = await import("../src/lib/chatTools");
  const result = buildMessages([
    {
      role: "user",
      content: "Revise the termination clause.",
      workflow: { id: "builtin-surgical-redline", title: "Surgical Redline" },
      files: [{ document_id: "document-1", filename: "contract.docx" }],
    },
  ], [{ doc_id: "doc-0", filename: "contract.docx" }], undefined, {
    "doc-0": { document_id: "document-1", filename: "contract.docx" },
  });
  const last = result.at(-1) as { role: string; content: string };
  assert.match(last.content, /^\[Workflow: Surgical Redline \(id: builtin-surgical-redline\)\]/);
  assert.match(last.content, /doc-0: contract\.docx/);
  assert.match(last.content, /Revise the termination clause\.$/);
});

test("streaming enforces its offered tools and suppresses disabled grouped research calls", async () => {
  // Execute the real stream entrypoint with a fake provider and connector
  // discovery. This catches missing dispatch wiring without a network call.
  const sourcePath = fileURLToPath(new URL("../src/lib/chatTools.ts", import.meta.url));
  const moduleRequire = createRequire(sourcePath);
  const emissions: string[] = [];
  const calls = [
    { id: "find-1", name: "courtlistener_find_in_case", input: { cluster_id: 42, query: "notice" } },
    { id: "find-2", name: "courtlistener_find_in_case", input: { cluster_id: 42, query: "waiver" } },
    { id: "private-1", name: "mcp_private_read", input: {} },
    { id: "workflow-1", name: "read_workflow", input: { workflow_id: "selected" } },
  ];
  let providerInvocations = 0;
  const isolatedRequire = Object.assign((id: string) => {
    if (id === "./mcpConnectors") {
      return {
        ...moduleRequire(id),
        buildUserMcpTools: async () => [],
        executeMcpToolCall: async () => { throw new Error("Unavailable connector executed"); },
      };
    }
    if (id === "./llm") {
      return {
        ...moduleRequire(id),
        streamChatWithTools: async (params: StreamChatParams) => {
          providerInvocations += 1;
          const names = params.tools?.map((tool) => tool.function.name) ?? [];
          assert.ok(names.includes("read_workflow"));
          assert.ok(!names.includes("courtlistener_find_in_case"));
          assert.ok(!names.includes("mcp_private_read"));
          assert.match(params.systemPrompt ?? "", /CourtListener case-law tools are unavailable/);
          assert.match(params.systemPrompt ?? "", /no connector tools are offered/);
          const results = await params.runTools!(calls);
          assert.equal(results.length, 4);
          for (const row of results.slice(0, 3)) {
            assert.equal(JSON.parse(row.content).error, "tool_not_available");
          }
          assert.equal(results[3].content, "Use supplied sources.");
          params.callbacks.onContentDelta("The selected workflow is loaded.");
          return { fullText: "The selected workflow is loaded.", toolCalls: [] };
        },
      };
    }
    return moduleRequire(id);
  }, { resolve: moduleRequire.resolve });
  const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const isolatedModule = { exports: {} };
  new Function("require", "module", "exports", "__dirname", "__filename", compiled.outputText)(
    isolatedRequire, isolatedModule, isolatedModule.exports, dirname(sourcePath), sourcePath,
  );
  const { runLLMStream } = isolatedModule.exports as typeof import("../src/lib/chatTools");
  const result = await runLLMStream({
    apiMessages: [{ role: "system", content: "Apply the selected workflow." }, { role: "user", content: "Review." }],
    docStore: new Map(),
    docIndex: {},
    userId: "alice",
    db: { from() { throw new Error("Unavailable tools must not access the database"); } } as unknown as Parameters<typeof runLLMStream>[0]["db"],
    write: (event) => { emissions.push(event); },
    workflowStore: new Map([["selected", { title: "Selected", prompt_md: "Use supplied sources." }]]),
    model: "test-provider",
    includeResearchTools: false,
  });

  assert.equal(providerInvocations, 1);
  assert.ok(result.events.some((event) => event.type === "workflow_applied"));
  assert.ok(result.events.every((event) => !event.type.startsWith("courtlistener_")));
  assert.ok(emissions.every((event) => !event.includes("courtlistener_find_in_case")));
});
