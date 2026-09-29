import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_MODEL_POLICY_VERSION, assistantBudgetPolicy, assistantGenerationForRecovery, resolveAssistantModelSelection, validateAssistantModelIntent } from "../src/lib/assistantModelPolicy";
import { preflightAssistantModel } from "../src/lib/assistantModelPreflight";
import { hydrateChatMessages } from "../../frontend/src/app/lib/assistantRunHydration";
import { buildContinuationDraft } from "../../frontend/src/app/lib/assistantRecovery";

const allKeys = { openai: "synthetic-openai", claude: "synthetic-claude", gemini: "synthetic-gemini" };

function route(body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return resolveAssistantModelSelection({ body, apiKeys: allKeys, fileTypes: [], budgetPolicy: "balanced", ...extra });
}

test("new users select drafting/research/summary without naming a provider", () => {
  for (const task of ["drafting", "research", "summary"] as const) {
    const result = route({ task });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.selection.mode, "auto");
    assert.equal(result.selection.task, task);
    assert.equal(result.selection.model, task === "summary" ? "gpt-6-luna" : "gpt-6-sol");
    assert.equal(result.request.requestedModel, "auto");
    assert.equal(result.request.reasoningEffort, task === "summary" ? "medium" : "high");
    assert.equal(result.request.reasoningMode, "standard");
    assert.equal(result.selection.policyVersion, ASSISTANT_MODEL_POLICY_VERSION);
  }
});

test("task/workflow mappings and firm budget are deterministic", () => {
  const fromWorkflow = route({ model: "auto" }, { workflowTitle: "Draft a motion" });
  assert.equal(fromWorkflow.ok && fromWorkflow.selection.task, "drafting");
  const explicit = route({ task: "summary" }, { workflowTitle: "Legal research" });
  assert.equal(explicit.ok && explicit.selection.task, "summary");
  const economy = route({ task: "drafting" }, { budgetPolicy: "economy" });
  assert.equal(economy.ok && economy.selection.model, "gpt-6-luna");
  const quality = route({ task: "research" }, { budgetPolicy: "quality" });
  assert.equal(quality.ok && quality.selection.model, "gpt-6-astra");
  assert.equal(assistantBudgetPolicy(""), "balanced");
  assert.throws(() => assistantBudgetPolicy("unbounded"));
});

test("Auto filters unavailable providers and requires Gemini for current native media", () => {
  const claude = route({ task: "drafting" }, { apiKeys: { openai: " ", claude: "synthetic" } });
  assert.equal(claude.ok && claude.selection.model, "claude-sonnet-5");
  for (const fileType of ["mp3", "mp4"]) {
    const native = route({ task: "drafting" }, { fileTypes: [fileType] });
    assert.equal(native.ok && native.request.provider, "gemini");
    assert.match(native.ok ? native.selection.reason : "", /audio\/video/);
    assert.equal(route({}, { fileTypes: [fileType], apiKeys: { openai: "synthetic" } }).ok, false);
  }
  assert.equal(route({}, { apiKeys: {} }).ok, false);
  assert.equal(route({ task: "summary" }, { fileTypes: ["png", "pdf", "docx"] }).ok, true);
});

test("manual override preserves effort and mode and never silently substitutes an unknown/unavailable model", () => {
  const manual = route({ model: "gpt-6-astra", reasoning_effort: "max", reasoning_mode: "pro", task: "drafting" }, { budgetPolicy: "economy" });
  assert.equal(manual.ok, true);
  if (manual.ok) {
    assert.equal(manual.selection.mode, "manual");
    assert.equal(manual.request.providerModel, "gpt-6-astra");
    assert.equal(manual.request.reasoningMode, "pro");
    assert.equal(manual.request.reasoningEffort, "max");
  }
  assert.equal(route({ model: "invented-model" }).ok, false);
  assert.equal(route({ model: "claude-sonnet-5" }, { apiKeys: { openai: "synthetic" } }).ok, false);
  assert.equal(route({ model: "gpt-6-sol" }, { fileTypes: ["wav"] }).ok, false);
  const legacy = route({ model: "gpt-5.5" });
  assert.match(legacy.ok ? legacy.selection.reason : "", /mapped from gpt-5.5/);
});

test("invalid manual reasoning and Auto overrides fail before keys/providers are consulted", () => {
  for (const body of [
    { model: "gpt-6-astra", reasoning_effort: "none" },
    { model: "gpt-6-sol", reasoning_mode: "invented" },
    { model: "auto", reasoning_effort: "max" },
    { model: "auto", task: "invented" },
  ]) assert.equal(validateAssistantModelIntent(body).ok, false);
});

function attachmentDb(rows: Record<string, unknown>[], error: unknown = null) {
  return { from(table: string) {
    assert.equal(table, "documents");
    return { select() { return this; }, in() { return Promise.resolve({ data: rows, error }); } };
  } };
}

test("preflight uses stored file type and workflow title, rejects unavailable/foreign attachments and workflow", async () => {
  const input = {
    body: {}, messages: [{ role: "user", content: "Summarize", files: [{ document_id: "doc-1", filename: "spoofed.docx" }], workflow: { id: "wf-1", title: "spoofed summary" } }],
    projectId: "project-1", userId: "member-1", apiKeys: allKeys,
    workflowStore: new Map([["wf-1", { title: "Legal research", prompt_md: "synthetic" }]]),
    db: attachmentDb([{ id: "doc-1", user_id: "owner-1", project_id: "project-1", file_type: "mp4", status: "ready" }]) as never,
  };
  const selected = await preflightAssistantModel(input);
  assert.equal(selected.ok && selected.request.provider, "gemini");
  assert.equal(selected.ok && selected.selection.task, "research");
  assert.equal((await preflightAssistantModel({ ...input, projectId: "other-project" })).ok, false);
  assert.equal((await preflightAssistantModel({ ...input, workflowStore: new Map() })).ok, false);
  assert.equal((await preflightAssistantModel({ ...input, db: attachmentDb([]) as never })).ok, false);
  await assert.rejects(() => preflightAssistantModel({ ...input, db: attachmentDb([], { message: "offline" }) as never }));
});

test("saved selection and project instruction version remain visible after chat hydration", () => {
  const selected = route({ task: "drafting" });
  assert.ok(selected.ok);
  const messages = hydrateChatMessages({ messages: [{ id: "message-1", role: "assistant", content: "Synthetic draft", assistant_run: {
    run_id: "run-1", status: "completed", error_code: null, message: null, retryable: false, trace_id: "trace-1", revision: "local",
    model_selection: selected.selection, project_instruction_version: 3,
  } }] });
  assert.deepEqual(messages[0].modelSelection, selected.selection);
  assert.equal(messages[0].projectInstructionVersion, 3);
  assert.equal(messages[0].assistantRun?.modelSelection?.policyVersion, ASSISTANT_MODEL_POLICY_VERSION);
});

test("reload and Continue preserve manual Pro/Max task/model intent", async () => {
  const selected = route({ model: "gpt-6-astra", task: "drafting", reasoning_effort: "max", reasoning_mode: "pro" });
  assert.ok(selected.ok);
  const generation = assistantGenerationForRecovery(selected.request, selected.selection);
  let stored: Record<string, unknown> | undefined;
  const db = { from() { return { insert(row: Record<string, unknown>) {
    stored = row; return Promise.resolve({ error: null });
  } }; } } as never;
  process.env.DATABASE_URL ??= "postgresql://docket:unused@127.0.0.1:5432/docket";
  const { persistAssistantUserMessage } = await import("../src/lib/assistantRunPresentation");
  await persistAssistantUserMessage(db, "chat-1", { content: "Draft a synthetic motion", generation });
  assert.deepEqual(stored?.generation, generation);
  const messages = hydrateChatMessages({ messages: [{ id: "user-message", role: "user", content: "Draft a synthetic motion", generation }] });
  const retry = buildContinuationDraft(messages[0]);
  assert.deepEqual(retry.generation, generation);
  assert.notEqual(retry.generation, messages[0].generation);
  assert.equal(retry.generation?.model, "gpt-6-astra");
  assert.equal(retry.generation?.reasoning_effort, "max");
  assert.equal(retry.generation?.reasoning_mode, "pro");
});

test("run persistence and authorized message metadata retain the selected policy and instruction version", async () => {
  const selected = route({ task: "research" });
  assert.ok(selected.ok);
  let row: Record<string, unknown> = {};
  const filters: [string, unknown][] = [];
  const db = { from(table: string) {
    assert.equal(table, "assistant_background_runs");
    const query = {
      insert(value: Record<string, unknown>) { row = { ...value, created_at: "2026-09-29T12:00:00Z", request_started_at: "2026-09-29T12:00:00Z" }; return query; },
      select() { return query; }, eq(key: string, value: unknown) { filters.push([key, value]); return query; },
      in(key: string, value: unknown) { filters.push([key, value]); return query; }, order() { return query; },
      async single() { return { data: row, error: null }; },
      then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: [row], error: null }).then(resolve); },
    };
    return query;
  } } as never;
  const { createAssistantBackgroundRun } = await import("../src/lib/assistantBackgroundRuns");
  const saved = await createAssistantBackgroundRun(db, {
    streamRequestId: "run-1", assistantMessageId: "message-1", chatId: "chat-1", userId: "member-1",
    model: selected.request.providerModel, traceId: "trace-1", revision: "local", modelSelection: selected.selection, projectInstructionVersion: 5,
  });
  assert.deepEqual(saved.modelSelection, selected.selection);
  assert.equal(saved.projectInstructionVersion, 5);
  const { loadAccessibleAssistantRunMetadata } = await import("../src/lib/assistantRunPresentation");
  const metadata = await loadAccessibleAssistantRunMetadata(db, "chat-1", ["message-1"]);
  assert.deepEqual(metadata.get("message-1")?.model_selection, selected.selection);
  assert.equal(metadata.get("message-1")?.project_instruction_version, 5);
  assert.deepEqual(filters, [["chat_id", "chat-1"], ["assistant_message_id", ["message-1"]]]);
});
