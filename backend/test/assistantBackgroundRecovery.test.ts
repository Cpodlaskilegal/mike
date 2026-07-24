import assert from "node:assert/strict";
import test from "node:test";

import type { Response as OpenAIResponse } from "openai/resources/responses/responses";
import {
  reconcileStaleAssistantBackgroundRuns,
  type AssistantBackgroundRecoveryDependencies,
} from "../src/lib/assistantBackgroundRecovery";
import type { AssistantBackgroundRun } from "../src/lib/assistantBackgroundRuns";

const NOW = Date.parse("2026-07-17T18:00:00.000Z");
const STALE_UPDATED_AT = "2026-07-17T17:59:00.000Z";
const FRESH_UPDATED_AT = "2026-07-17T17:59:55.000Z";

function runRow(run: AssistantBackgroundRun): Record<string, unknown> {
  return {
    stream_request_id: run.streamRequestId,
    assistant_message_id: run.assistantMessageId,
    chat_id: run.chatId,
    user_id: run.userId,
    project_id: run.projectId,
    provider_response_id: run.providerResponseId,
    provider_request_id: run.providerRequestId,
    iteration: run.iteration,
    status: run.status,
    provider_status: run.providerStatus,
    model: run.model,
    reasoning_mode: run.reasoningMode,
    reasoning_effort: run.reasoningEffort,
    trace_id: run.traceId,
    revision: run.revision,
    finalization_owner: run.finalizationOwner,
    error_code: run.errorCode,
    safe_error_message: run.safeErrorMessage,
    request_started_at: run.requestStartedAt,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    completed_at: run.completedAt,
  };
}

function makeRun(
  overrides: Partial<AssistantBackgroundRun> = {},
): AssistantBackgroundRun {
  return {
    streamRequestId: "019f7170-9f04-72c1-8364-45f504ca2153",
    assistantMessageId: "019f7170-9f04-72c1-8364-45f504ca2154",
    chatId: "019f7170-9f04-72c1-8364-45f504ca2155",
    userId: "entra-user-1",
    projectId: null,
    providerResponseId: "resp_original",
    providerRequestId: "req_original",
    iteration: 1,
    status: "background_pending",
    providerStatus: "in_progress",
    model: "gpt-5.6-sol",
    reasoningMode: "pro",
    reasoningEffort: "max",
    traceId: "trace-123",
    revision: "mike-api--0000042",
    finalizationOwner: null,
    errorCode: null,
    safeErrorMessage: null,
    requestStartedAt: "2026-07-17T17:55:00.000Z",
    createdAt: "2026-07-17T17:55:00.000Z",
    updatedAt: STALE_UPDATED_AT,
    completedAt: null,
    ...overrides,
  };
}

function createFakeDb(initialRun: AssistantBackgroundRun) {
  const runs = new Map<string, Record<string, unknown>>([
    [initialRun.streamRequestId, runRow(initialRun)],
  ]);
  const messages = new Map<string, Record<string, unknown>>([
    [
      initialRun.assistantMessageId,
      { id: initialRun.assistantMessageId, content: null },
    ],
  ]);

  const db = {
    from(table: string) {
      let operation: "select" | "update" = "select";
      let values: Record<string, unknown> = {};
      let filterColumn: string | null = null;
      let filterValue: unknown;
      let expectedFinalizationOwner: unknown = undefined;
      let expectedStatus: unknown = undefined;
      let expectedUpdatedAt: unknown = undefined;
      let allowedStatuses: string[] | null = null;
      let requireNullContent = false;

      const execute = () => {
        const rows = table === "assistant_background_runs" ? runs : messages;
        const key = String(filterValue ?? "");
        const current = rows.get(key) ?? null;
        if (
          current &&
          expectedFinalizationOwner !== undefined &&
          current.finalization_owner !== expectedFinalizationOwner
        ) {
          return null;
        }
        if (
          current &&
          expectedStatus !== undefined &&
          current.status !== expectedStatus
        ) {
          return null;
        }
        if (
          current &&
          expectedUpdatedAt !== undefined &&
          current.updated_at !== expectedUpdatedAt
        ) {
          return null;
        }
        if (current && requireNullContent && current.content != null)
          return null;
        if (
          current &&
          allowedStatuses &&
          !allowedStatuses.includes(String(current.status))
        ) {
          return null;
        }
        if (operation === "update" && current) {
          const updated = { ...current, ...values };
          rows.set(key, updated);
          return updated;
        }
        return current;
      };

      const builder: any = {
        update(row: Record<string, unknown>) {
          operation = "update";
          values = row;
          return builder;
        },
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          if (column === "finalization_owner") {
            expectedFinalizationOwner = value;
            return builder;
          }
          if (column === "status") {
            expectedStatus = value;
            return builder;
          }
          if (column === "updated_at") {
            expectedUpdatedAt = value;
            return builder;
          }
          filterColumn = column;
          filterValue = value;
          assert.equal(
            column,
            table === "assistant_background_runs" ? "stream_request_id" : "id",
          );
          return builder;
        },
        in(column: string, values: unknown[]) {
          assert.equal(column, "status");
          allowedStatuses = values.map(String);
          return builder;
        },
        is(column: string, value: unknown) {
          assert.equal(column, "content");
          assert.equal(value, null);
          requireNullContent = true;
          return builder;
        },
        async maybeSingle() {
          return { data: execute(), error: null };
        },
        then(
          resolve: (value: unknown) => unknown,
          reject: (error: unknown) => unknown,
        ) {
          assert.ok(filterColumn);
          return Promise.resolve({ data: execute(), error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return builder;
    },
  } as unknown as AssistantBackgroundRecoveryDependencies["db"];

  return { db, runs, messages };
}

function completedTextResponse(text: string): OpenAIResponse {
  return {
    id: "resp_recovered",
    model: "gpt-5.6-sol",
    status: "completed",
    output_text: text,
    output: [],
  } as unknown as OpenAIResponse;
}

function completedToolResponse(): OpenAIResponse {
  return {
    id: "resp_with_tool",
    model: "gpt-5.6-sol",
    status: "completed",
    output_text: "",
    output: [
      {
        id: "fc_1",
        type: "function_call",
        status: "completed",
        call_id: "call_1",
        name: "read_document",
        arguments: '{"doc_id":"doc-0"}',
      },
    ],
  } as unknown as OpenAIResponse;
}

test("recovers a stale completed plain-text response and persists completion", async () => {
  const run = makeRun();
  const { db, runs, messages } = createFakeDb(run);
  const retrieved: string[] = [];

  const result = await reconcileStaleAssistantBackgroundRuns({
    db,
    now: () => NOW,
    listRuns: async () => [run],
    loadOpenAIKey: async () => "test-openai-key",
    retrieve: async ({ responseId }) => {
      retrieved.push(responseId);
      return {
        response: completedTextResponse(
          "Recovered answer.\n\n<CITATIONS>[]</CITATIONS>",
        ),
        providerRequestId: "req_recovered",
      };
    },
    cancel: async () => assert.fail("completed recovery must not cancel"),
  });

  assert.deepEqual(result, { inspected: 1, recovered: 1, failed: 0 });
  assert.deepEqual(retrieved, ["resp_original"]);
  assert.deepEqual(messages.get(run.assistantMessageId)?.content, [
    { type: "content", text: "Recovered answer." },
  ]);
  assert.equal(runs.get(run.streamRequestId)?.status, "completed");
  assert.equal(runs.get(run.streamRequestId)?.provider_status, "completed");
  assert.equal(
    runs.get(run.streamRequestId)?.provider_response_id,
    "resp_recovered",
  );
  assert.equal(
    runs.get(run.streamRequestId)?.provider_request_id,
    "req_recovered",
  );
  assert.equal(runs.get(run.streamRequestId)?.error_code, null);
  assert.equal(runs.get(run.streamRequestId)?.safe_error_message, null);
  assert.equal(typeof runs.get(run.streamRequestId)?.completed_at, "string");
});

test("marks a completed response with function calls as interrupted", async () => {
  const run = makeRun();
  const { db, runs, messages } = createFakeDb(run);

  const result = await reconcileStaleAssistantBackgroundRuns({
    db,
    now: () => NOW,
    listRuns: async () => [run],
    loadOpenAIKey: async () => null,
    retrieve: async () => ({
      response: completedToolResponse(),
      providerRequestId: "req_tool",
    }),
    cancel: async () => assert.fail("tool recovery must not cancel"),
  });

  assert.deepEqual(result, { inspected: 1, recovered: 1, failed: 0 });
  assert.equal(runs.get(run.streamRequestId)?.status, "interrupted");
  assert.equal(
    runs.get(run.streamRequestId)?.error_code,
    "background_tool_continuation_interrupted",
  );
  assert.match(
    String(runs.get(run.streamRequestId)?.safe_error_message),
    /using tools/i,
  );
  assert.match(
    JSON.stringify(messages.get(run.assistantMessageId)?.content),
    /without repeating a tool action/i,
  );
});

test("finalizes an already-saved answer without clobbering rich message data", async () => {
  const run = makeRun({
    status: "finalizing",
    providerStatus: "completed",
  });
  const { db, runs, messages } = createFakeDb(run);
  const richMessage = {
    id: run.assistantMessageId,
    content: [{ type: "content", text: "Saved answer." }],
    annotations: [{ doc_id: "doc-0", page: 2 }],
    citations: [{ kind: "document", title: "Exhibit A" }],
  };
  messages.set(run.assistantMessageId, richMessage);

  const result = await reconcileStaleAssistantBackgroundRuns({
    db,
    now: () => NOW,
    listRuns: async () => [run],
    loadOpenAIKey: async () =>
      assert.fail("saved finalization must not load key"),
    retrieve: async () => assert.fail("saved finalization must not retrieve"),
    cancel: async () => assert.fail("saved finalization must not cancel"),
  });

  assert.deepEqual(result, { inspected: 1, recovered: 1, failed: 0 });
  assert.equal(runs.get(run.streamRequestId)?.status, "completed");
  assert.deepEqual(messages.get(run.assistantMessageId), richMessage);
});

test("skips a fresh run", async () => {
  const run = makeRun({ updatedAt: FRESH_UPDATED_AT });
  const { db } = createFakeDb(run);
  let dependencyCalls = 0;

  const result = await reconcileStaleAssistantBackgroundRuns({
    db,
    now: () => NOW,
    listRuns: async () => [run],
    loadOpenAIKey: async () => {
      dependencyCalls += 1;
      return null;
    },
    retrieve: async () => {
      dependencyCalls += 1;
      return {
        response: completedTextResponse("unexpected"),
        providerRequestId: null,
      };
    },
    cancel: async () => {
      dependencyCalls += 1;
    },
  });

  assert.deepEqual(result, { inspected: 0, recovered: 0, failed: 0 });
  assert.equal(dependencyCalls, 0);
});

test("cancels a fresh cancel_requested run and persists cancellation", async () => {
  const run = makeRun({
    status: "cancel_requested",
    updatedAt: FRESH_UPDATED_AT,
  });
  const { db, runs, messages } = createFakeDb(run);
  const cancelled: { apiKey?: string | null; responseId: string }[] = [];

  const result = await reconcileStaleAssistantBackgroundRuns({
    db,
    now: () => NOW,
    listRuns: async () => [run],
    loadOpenAIKey: async () => "test-openai-key",
    retrieve: async () => ({
      response: {
        id: "resp_original",
        model: "gpt-5.6-sol",
        status: "in_progress",
        output: [],
      } as unknown as OpenAIResponse,
      providerRequestId: "req_cancel_check",
    }),
    cancel: async (input) => {
      cancelled.push(input);
    },
  });

  assert.deepEqual(result, { inspected: 1, recovered: 1, failed: 0 });
  assert.deepEqual(cancelled, [
    { apiKey: "test-openai-key", responseId: "resp_original" },
  ]);
  assert.equal(runs.get(run.streamRequestId)?.status, "cancelled");
  assert.equal(runs.get(run.streamRequestId)?.provider_status, "cancelled");
  assert.equal(
    runs.get(run.streamRequestId)?.error_code,
    "explicit_user_cancel",
  );
  assert.deepEqual(messages.get(run.assistantMessageId)?.content, [
    { type: "content", text: "Cancelled by user." },
  ]);
});

test("gives the owning handler a grace period before provider cancellation", async () => {
  const run = makeRun({
    status: "cancel_requested",
    updatedAt: "2026-07-17T17:59:59.000Z",
  });
  const { db, runs, messages } = createFakeDb(run);

  const result = await reconcileStaleAssistantBackgroundRuns({
    db,
    now: () => NOW,
    listRuns: async () => [run],
    loadOpenAIKey: async () => assert.fail("fresh cancel must wait"),
    retrieve: async () => assert.fail("fresh cancel must not retrieve"),
    cancel: async () => assert.fail("fresh cancel must not cancel"),
  });

  assert.deepEqual(result, { inspected: 1, recovered: 0, failed: 0 });
  assert.equal(runs.get(run.streamRequestId)?.status, "cancel_requested");
  assert.equal(messages.get(run.assistantMessageId)?.content, null);
});

test("keeps a Standard cancellation pending until its provider state is terminal", async () => {
  const run = makeRun({
    status: "cancel_requested",
    reasoningMode: "standard",
    reasoningEffort: "medium",
    updatedAt: FRESH_UPDATED_AT,
  });
  const { db, runs, messages } = createFakeDb(run);
  let cancelCalls = 0;

  const result = await reconcileStaleAssistantBackgroundRuns({
    db,
    now: () => NOW,
    listRuns: async () => [run],
    loadOpenAIKey: async () => "test-openai-key",
    retrieve: async () => ({
      response: {
        id: "resp_original",
        model: "gpt-5.6-sol",
        status: "in_progress",
        output: [],
      } as unknown as OpenAIResponse,
      providerRequestId: "req_standard_cancel_check",
    }),
    cancel: async () => {
      cancelCalls += 1;
    },
  });

  assert.deepEqual(result, { inspected: 1, recovered: 0, failed: 0 });
  assert.equal(cancelCalls, 0);
  assert.equal(runs.get(run.streamRequestId)?.status, "cancel_requested");
  assert.equal(messages.get(run.assistantMessageId)?.content, null);
});

test("gives the owning handler time to abort a cancellation without a provider ID", async () => {
  const run = makeRun({
    status: "cancel_requested",
    providerResponseId: null,
    providerRequestId: null,
    updatedAt: FRESH_UPDATED_AT,
  });
  const { db, runs, messages } = createFakeDb(run);

  const result = await reconcileStaleAssistantBackgroundRuns({
    db,
    now: () => NOW,
    listRuns: async () => [run],
    loadOpenAIKey: async () => assert.fail("fresh no-ID cancel must wait"),
    retrieve: async () => assert.fail("fresh no-ID cancel must not retrieve"),
    cancel: async () => assert.fail("fresh no-ID cancel must not cancel"),
  });

  assert.deepEqual(result, { inspected: 1, recovered: 0, failed: 0 });
  assert.equal(runs.get(run.streamRequestId)?.status, "cancel_requested");
  assert.equal(messages.get(run.assistantMessageId)?.content, null);
});
