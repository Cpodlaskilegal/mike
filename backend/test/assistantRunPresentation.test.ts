import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  assistantStartupFailureResponse,
  assistantStartupPlaceholderAnnotations,
  clearAssistantStartupAnnotations,
  classifyAssistantRunCreateError,
  loadAccessibleAssistantStartupFailures,
  loadAccessibleAssistantRunMetadata,
  persistAssistantUserMessage,
  recordAssistantStartupFailure,
} from "../src/lib/assistantRunPresentation";
import { createAssistantRunStartDiagnostic, registerAssistantStream, unregisterAssistantStream } from "../src/lib/assistantStreamLifecycle";

test("startup 500 contract distinguishes saved and unsaved prompts without client content", () => {
  const diagnostic = createAssistantRunStartDiagnostic({
    requestedStreamId: "019f7170-9f04-72c1-8364-45f504ca2153",
    route: "chat",
    startedAt: Date.now(),
  });
  const unsaved = assistantStartupFailureResponse(diagnostic, "chat-1", false,
    "Failed to save submitted message");
  const saved = assistantStartupFailureResponse(diagnostic, "chat-1", true,
    "Failed to create the assistant response placeholder");
  assert.deepEqual(unsaved, {
    detail: "Failed to save submitted message",
    message_saved: false,
    chat_id: "chat-1",
    request_id: diagnostic.streamRequestId,
  });
  assert.equal(saved.message_saved, true);
  assert.equal(saved.request_id, diagnostic.streamRequestId);
  assert.equal("content" in saved, false);
  assert.equal("files" in saved, false);
});

test("reload metadata includes safe failures for messages in an accessible shared chat", async () => {
  const rows = [
    {
      stream_request_id: "run-owned",
      assistant_message_id: "assistant-owned",
      chat_id: "shared-chat",
      user_id: "alice",
      status: "failed",
      error_code: "tool_iteration_limit",
      safe_error_message: "Docket reached its research-step limit before writing the final answer. Retry the request.",
      trace_id: "trace-owned",
      revision: "mike-api--42",
      git_sha: "abc123",
      created_at: "2026-09-29T12:00:00Z",
    },
    {
      stream_request_id: "run-other",
      assistant_message_id: "assistant-other",
      chat_id: "shared-chat",
      user_id: "bob",
      status: "failed",
      error_code: "provider_unavailable",
      safe_error_message: "Provider unavailable",
      trace_id: "trace-other",
      revision: "mike-api--42",
      git_sha: "abc123",
      created_at: "2026-09-29T12:01:00Z",
    },
  ];
  const filters: Record<string, string> = {};
  let messageIds: string[] = [];
  const query: any = {
    select() { return query; },
    eq(column: string, value: string) { filters[column] = value; return query; },
    in(column: string, values: string[]) {
      assert.equal(column, "assistant_message_id");
      messageIds = values;
      return query;
    },
    order() {
      return Promise.resolve({
        data: rows.filter((row) => Object.entries(filters).every(
          ([column, value]) => (row as Record<string, string>)[column] === value,
        ) && messageIds.includes(row.assistant_message_id)),
        error: null,
      });
    },
  };
  const db = { from(table: string) {
    assert.equal(table, "assistant_background_runs");
    return query;
  } } as any;

  const metadata = await loadAccessibleAssistantRunMetadata(db, "shared-chat", ["assistant-owned", "assistant-other"]);
  assert.deepEqual(filters, { chat_id: "shared-chat" });
  assert.deepEqual(messageIds, ["assistant-owned", "assistant-other"]);
  assert.equal(metadata.size, 2);
  assert.deepEqual(metadata.get("assistant-owned"), {
    run_id: "run-owned",
    status: "failed",
    error_code: "tool_iteration_limit",
    message: rows[0].safe_error_message,
    retryable: true,
    trace_id: "trace-owned",
    revision: "mike-api--42",
    git_sha: "abc123",
  });
  assert.deepEqual(metadata.get("assistant-other"), {
    run_id: "run-other",
    status: "failed",
    error_code: "provider_unavailable",
    message: "Provider unavailable",
    retryable: true,
    trace_id: "trace-other",
    revision: "mike-api--42",
    git_sha: "abc123",
  });
});

test("submitted prompt and attachments must be durable before a run starts", async () => {
  const writes: Record<string, unknown>[] = [];
  const db = { from(table: string) {
    assert.equal(table, "chat_messages");
    return { insert(row: Record<string, unknown>) {
      writes.push(row);
      return Promise.resolve({ data: null, error: null });
    } };
  } } as any;
  await persistAssistantUserMessage(db, "chat-1", {
    content: "Please review this filing.",
    files: [{ filename: "filing.pdf", document_id: "doc-1" }],
    workflow: { id: "review", title: "Review" },
  });
  assert.deepEqual(writes, [{
    chat_id: "chat-1",
    role: "user",
    content: "Please review this filing.",
    files: [{ filename: "filing.pdf", document_id: "doc-1" }],
    workflow: { id: "review", title: "Review" },
  }]);

  const failingDb = { from() { return { insert() {
    return Promise.resolve({ data: null, error: { message: "database error" } });
  } }; } } as any;
  await assert.rejects(
    persistAssistantUserMessage(failingDb, "chat-1", { content: "Retry me" }),
    /Failed to save submitted message/,
  );
});

test("saved prompts and placeholders atomically carry only startup identifiers", async () => {
  const diagnostic = createAssistantRunStartDiagnostic({
    requestedStreamId: "019f7170-9f04-72c1-8364-45f504ca2153",
    route: "chat",
    startedAt: Date.now(),
  });
  let inserted: Record<string, unknown> | null = null;
  const db = { from(table: string) {
    assert.equal(table, "chat_messages");
    return { insert(row: Record<string, unknown>) {
      inserted = row;
      return { select() { return { maybeSingle: async () => ({
        data: { id: "user-message-1" }, error: null,
      }) }; } };
    } };
  } } as any;
  const id = await persistAssistantUserMessage(db, "chat-1", {
    content: "Confidential client prompt",
  }, diagnostic);
  assert.equal(id, "user-message-1");
  const marker = (inserted?.annotations as Record<string, any>)?.docket_assistant_startup;
  assert.equal(marker.request_id, diagnostic.streamRequestId);
  assert.equal(marker.status, "starting");
  assert.equal(JSON.stringify(marker).includes("Confidential client prompt"), false);
  assert.deepEqual(assistantStartupPlaceholderAnnotations(diagnostic), {
    docket_assistant_startup_request_id: diagnostic.streamRequestId,
  });
});

test("both routes persist the registered run ID and trace even after an active ID collision", async () => {
  const requestedStreamId = "019f7170-9f04-72c1-8364-45f504ca2153";
  const first = registerAssistantStream({
    requestedStreamId,
    userId: "alice",
    chatId: "chat-1",
    route: "chat",
    controller: new AbortController(),
  });
  const second = registerAssistantStream({
    requestedStreamId,
    userId: "alice",
    chatId: "chat-1",
    route: "chat",
    controller: new AbortController(),
  });
  try {
    assert.notEqual(second.streamRequestId, first.streamRequestId);
    const placeholder = assistantStartupPlaceholderAnnotations(second);
    assert.equal(placeholder.docket_assistant_startup_request_id, second.streamRequestId);
    const sourceRoot = resolve(new URL("..", import.meta.url).pathname);
    for (const file of ["src/routes/chat.ts", "src/routes/projectChat.ts"]) {
      const source = readFileSync(resolve(sourceRoot, file), "utf8");
      const registered = source.indexOf("const streamLifecycle = registerAssistantStream({");
      const aliased = source.indexOf("const startDiagnostic = streamLifecycle;", registered);
      const persisted = source.indexOf("persistAssistantUserMessage(db, chatId, lastUser, startDiagnostic)", aliased);
      assert.ok(registered >= 0 && aliased > registered && persisted > aliased,
        `${file} must persist the final registered run ID and trace`);
    }
  } finally {
    unregisterAssistantStream(second);
    unregisterAssistantStream(first);
  }
});

test("startup failures hydrate on saved prompts or tagged placeholders without a run", async () => {
  const now = Date.now();
  const diagnostic = createAssistantRunStartDiagnostic({
    requestedStreamId: "019f7170-9f04-72c1-8364-45f504ca2153",
    route: "project_chat",
    startedAt: now - 60_000,
  });
  const writes: Record<string, unknown>[] = [];
  const db = { from(table: string) {
    if (table === "chat_messages") return { update(value: Record<string, unknown>) {
      writes.push(value);
      return { eq() { return this; }, select() { return { maybeSingle: async () => ({
        data: { id: "user-1" }, error: null,
      }) }; } };
    } };
    assert.equal(table, "assistant_background_runs");
    return { select() { return this; }, eq(column: string, value: string) {
      assert.equal(column, "chat_id");
      assert.equal(value, "chat-1");
      return this;
    }, in() { return Promise.resolve({ data: [], error: null }); } };
  } } as any;
  await recordAssistantStartupFailure(db, "chat-1", "user-1", diagnostic,
    "run_create");
  const marker = (writes[0].annotations as Record<string, any>).docket_assistant_startup;
  assert.equal(marker.status, "failed");
  assert.equal(marker.error_code, "run_create");
  const messages = [
    { id: "user-1", role: "user", content: "Confidential prompt", annotations: writes[0].annotations },
    { id: "assistant-1", role: "assistant", content: null,
      annotations: assistantStartupPlaceholderAnnotations(diagnostic) },
  ];
  const hydrated = await loadAccessibleAssistantStartupFailures(db, "chat-1", messages);
  assert.equal("assistant_start_failure" in hydrated[0], false);
  assert.deepEqual(hydrated[1].assistant_start_failure, {
    request_id: diagnostic.streamRequestId,
    status: "failed",
    error_code: "run_create",
    message: "Docket could not start this response. Review your request and continue.",
    retryable: true,
    trace_id: diagnostic.traceId,
    revision: diagnostic.revision,
    git_sha: diagnostic.gitSha,
  });
  assert.equal(hydrated[0].annotations, null);
  assert.equal(hydrated[1].annotations, null);

  const withoutPlaceholder = await loadAccessibleAssistantStartupFailures(db,
    "chat-1", [messages[0]]);
  assert.equal(withoutPlaceholder[0].assistant_start_failure?.request_id,
    diagnostic.streamRequestId);
  assert.equal(withoutPlaceholder[0].assistant_start_failure?.error_code, "run_create");
});

test("a starting marker never offers retry, and a matching run suppresses it", async () => {
  const diagnostic = createAssistantRunStartDiagnostic({
    requestedStreamId: "019f7170-9f04-72c1-8364-45f504ca2153",
    route: "chat",
    startedAt: Date.now() - 60_000,
  });
  const user = { id: "user-1", role: "user", content: "Prompt", annotations: {
    docket_assistant_startup: {
      request_id: diagnostic.streamRequestId,
      status: "starting",
      error_code: "startup_interrupted",
      trace_id: diagnostic.traceId,
      revision: diagnostic.revision,
      git_sha: diagnostic.gitSha,
      started_at: new Date(diagnostic.startedAt).toISOString(),
    },
  } };
  const assistant = { id: "assistant-1", role: "assistant", content: null,
    annotations: assistantStartupPlaceholderAnnotations(diagnostic) };
  const db = { from(table: string) {
    assert.equal(table, "assistant_background_runs");
    return { select() { return this; }, eq() { return this; }, in() {
      return Promise.resolve({ data: [{ stream_request_id: diagnostic.streamRequestId,
        assistant_message_id: "assistant-1" }], error: null });
    } };
  } } as any;
  const hydrated = await loadAccessibleAssistantStartupFailures(db, "chat-1", [user, assistant]);
  assert.equal("assistant_start_failure" in hydrated[0], false);
  assert.equal("assistant_start_failure" in hydrated[1], false);
  assert.equal(hydrated[0].annotations, null);
  const noRunDb = { from(table: string) {
    assert.equal(table, "assistant_background_runs");
    return { select() { return this; }, eq() { return this; }, in() {
      return Promise.resolve({ data: [], error: null });
    } };
  } } as any;
  const stillStarting = await loadAccessibleAssistantStartupFailures(noRunDb,
    "chat-1", [user, assistant]);
  assert.equal("assistant_start_failure" in stillStarting[0], false);
  assert.equal("assistant_start_failure" in stillStarting[1], false);
  await clearAssistantStartupAnnotations({ from() { return { update() {
    return { eq() { return this; }, select() { return { maybeSingle: async () => ({
      data: { id: "user-1" }, error: null,
    }) }; } };
  } }; } } as any, "chat-1", "user-1");
});

test("an old run reusing a request ID cannot hide a saved startup failure", async () => {
  const diagnostic = createAssistantRunStartDiagnostic({
    requestedStreamId: "019f7170-9f04-72c1-8364-45f504ca2153",
    route: "chat",
    startedAt: Date.now() - 60_000,
  });
  const user = { id: "user-new", role: "user", content: "New prompt", annotations: {
    docket_assistant_startup: {
      request_id: diagnostic.streamRequestId,
      status: "failed",
      error_code: "run_create",
      trace_id: diagnostic.traceId,
      revision: diagnostic.revision,
      git_sha: diagnostic.gitSha,
      started_at: new Date(diagnostic.startedAt).toISOString(),
    },
  } };
  const assistant = { id: "assistant-new", role: "assistant", content: null,
    annotations: assistantStartupPlaceholderAnnotations(diagnostic) };
  const db = { from(table: string) {
    assert.equal(table, "assistant_background_runs");
    return { select() { return this; }, eq() { return this; }, in() {
      return Promise.resolve({ data: [{ stream_request_id: diagnostic.streamRequestId,
        assistant_message_id: "assistant-old" }], error: null });
    } };
  } } as any;
  const hydrated = await loadAccessibleAssistantStartupFailures(db,
    "chat-1", [user, assistant]);
  assert.equal(hydrated[1].assistant_start_failure?.error_code, "run_create");
});

test("ambiguous run-create errors continue only for the matching committed starting row", async () => {
  const expected = {
    streamRequestId: "019f7170-9f04-72c1-8364-45f504ca2153",
    assistantMessageId: "assistant-new",
    chatId: "chat-1",
    userId: "alice",
    traceId: "trace-new",
  };
  const committed = { ...expected, status: "starting" };
  assert.equal(await classifyAssistantRunCreateError(async () => committed, expected), "committed");
  assert.equal(await classifyAssistantRunCreateError(async () => null, expected), "unknown");
  assert.equal(await classifyAssistantRunCreateError(async () => ({
    ...committed, assistantMessageId: "assistant-old",
  }), expected), "absent");
  assert.equal(await classifyAssistantRunCreateError(async () => ({
    ...committed, traceId: "trace-old",
  }), expected), "absent");
  assert.equal(await classifyAssistantRunCreateError(async () => ({
    ...committed, status: "completed",
  }), expected), "unknown");
  assert.equal(await classifyAssistantRunCreateError(async () => {
    throw new Error("database unavailable");
  }, expected), "unknown");
});
