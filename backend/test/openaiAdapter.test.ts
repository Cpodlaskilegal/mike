import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

let adapter: typeof import("../src/lib/llm/openai");

test.before(async () => {
  adapter = await import("../src/lib/llm/openai");
});

const GPT_5_6_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

const docketTool = {
  type: "function" as const,
  name: "read_document",
  description: "Read one document",
  parameters: {
    type: "object",
    properties: { doc_id: { type: "string" } },
    required: ["doc_id"],
  },
  strict: false,
};

function responseFixture(input: {
  model?: string;
  usage?: NonNullable<Response["usage"]>;
  outputText?: string;
  output?: ResponseOutputItem[];
  status?: Response["status"];
  errorMessage?: string;
  incompleteReason?: string;
} = {}): Response {
  return {
    id: "resp_test",
    model: input.model ?? "gpt-5.6-sol",
    usage: input.usage ?? null,
    output_text: input.outputText ?? "",
    output: input.output ?? [],
    status: input.status ?? "completed",
    error: input.errorMessage
      ? { code: "server_error", message: input.errorMessage }
      : null,
    incomplete_details: input.incompleteReason
      ? { reason: input.incompleteReason as "max_output_tokens" }
      : null,
  } as Response;
}

function functionCall(
  callId: string,
  name: string,
  argumentsJson: string,
): ResponseFunctionToolCall {
  return {
    id: `item_${callId}`,
    type: "function_call",
    call_id: callId,
    name,
    arguments: argumentsJson,
    status: "completed",
  };
}

test("builds separately typed Standard streaming requests for every GPT-5.6 family model", () => {
  for (const model of GPT_5_6_MODELS) {
    const request = adapter.buildOpenAIStandardStreamingRequest({
      model,
      input: "Hello",
      tools: [docketTool],
      parallel_tool_calls: true,
      reasoningEffort: "xhigh",
    });

    assert.equal(request.model, model);
    assert.equal(request.stream, true);
    assert.deepEqual(request.reasoning, { effort: "xhigh" });
    assert.equal("mode" in (request.reasoning ?? {}), false);
    assert.equal(request.parallel_tool_calls, true);
    assert.equal(request.tools?.[0]?.type, "function");
    assert.equal(
      (request.tools?.[0] as { strict?: boolean } | undefined)?.strict,
      false,
    );
  }
});

test("builds Pro as a stored background request without inventing a model slug", () => {
  for (const model of GPT_5_6_MODELS) {
    const request = adapter.buildOpenAIProBackgroundRequest({
      model,
      input: "Hello",
      tools: [docketTool],
      parallel_tool_calls: true,
      reasoningEffort: "medium",
    });

    assert.equal(request.model, model);
    assert.equal(request.stream, false);
    assert.equal(request.background, true);
    assert.equal(request.store, true);
    assert.deepEqual(request.reasoning, {
      effort: "medium",
      mode: "pro",
    });
    assert.equal(String(request.model).includes("-pro"), false);
  }
});

test("keeps one-shot Standard requests non-streaming and mode-free", () => {
  const request = adapter.buildOpenAIStandardNonStreamingRequest({
    model: "gpt-5.4",
    input: "Create a title",
    reasoningEffort: "low",
  });

  assert.equal(request.stream, false);
  assert.deepEqual(request.reasoning, { effort: "low" });
  assert.equal("mode" in (request.reasoning ?? {}), false);
});

test("selects streaming solely from reasoning mode", () => {
  assert.equal(adapter.shouldStreamOpenAI("standard"), true);
  assert.equal(adapter.shouldStreamOpenAI("pro"), false);
});

test("uses background execution for every Pro request and every Max request", () => {
  assert.equal(adapter.shouldUseOpenAIBackground("pro", "medium"), true);
  assert.equal(adapter.shouldUseOpenAIBackground("pro", "max"), true);
  assert.equal(adapter.shouldUseOpenAIBackground("standard", "max"), true);
  assert.equal(adapter.shouldUseOpenAIBackground("standard", "xhigh"), false);
});

test("polls a background response and records provider IDs before completion", async () => {
  const queued = responseFixture({ status: "queued" });
  queued.id = "resp_background";
  const inProgress = responseFixture({ status: "in_progress" });
  inProgress.id = queued.id;
  const completed = responseFixture({ status: "completed", outputText: "Done" });
  completed.id = queued.id;
  const pending = [inProgress, completed];
  const progress: Array<{
    phase: string;
    responseId: string | null | undefined;
    requestId: string | null | undefined;
    status: string | null | undefined;
  }> = [];
  let retrieveCount = 0;

  const openai = {
    responses: {
      retrieve() {
        const data = pending[retrieveCount++];
        return {
          withResponse: async () => ({
            data,
            request_id: `req_poll_${retrieveCount}`,
          }),
        };
      },
      cancel: async () => queued,
    },
  } as unknown as Pick<OpenAI, "responses">;

  const result = await adapter.waitForOpenAIBackgroundResponse(openai, queued, {
    providerRequestId: "req_create",
    pollIntervalMs: 0,
    maxWaitMs: 1_000,
    onProviderProgress: (update) => {
      progress.push({
        phase: update.phase,
        responseId: update.providerResponseId,
        requestId: update.providerRequestId,
        status: update.providerStatus,
      });
    },
  });

  assert.equal(result.response, completed);
  assert.equal(result.providerRequestId, "req_poll_2");
  assert.equal(retrieveCount, 2);
  assert.deepEqual(progress, [
    {
      phase: "started",
      responseId: "resp_background",
      requestId: "req_create",
      status: "queued",
    },
    {
      phase: "polling",
      responseId: "resp_background",
      requestId: "req_poll_1",
      status: "in_progress",
    },
    {
      phase: "polling",
      responseId: "resp_background",
      requestId: "req_poll_2",
      status: "completed",
    },
    {
      phase: "completed",
      responseId: "resp_background",
      requestId: "req_poll_2",
      status: "completed",
    },
  ]);
});

test("cancels the provider background response on an explicit abort", async () => {
  const queued = responseFixture({ status: "queued" });
  queued.id = "resp_cancel";
  const controller = new AbortController();
  controller.abort();
  const cancelledIds: string[] = [];
  const openai = {
    responses: {
      retrieve() {
        throw new Error("retrieve should not run after abort");
      },
      cancel: async (responseId: string) => {
        cancelledIds.push(responseId);
        return queued;
      },
    },
  } as unknown as Pick<OpenAI, "responses">;

  await assert.rejects(
    adapter.waitForOpenAIBackgroundResponse(openai, queued, {
      abortSignal: controller.signal,
      providerRequestId: "req_cancel",
      pollIntervalMs: 0,
    }),
    (error: unknown) => {
      const candidate = error as Error & {
        providerResponseId?: string;
        providerRequestId?: string;
      };
      return (
        candidate.name === "AbortError" &&
        candidate.providerResponseId === "resp_cancel" &&
        candidate.providerRequestId === "req_cancel"
      );
    },
  );
  assert.deepEqual(cancelledIds, ["resp_cancel"]);
});

test("cancels an assigned background response when durable ID persistence fails", async () => {
  const queued = responseFixture({ status: "queued" });
  queued.id = "resp_persistence_failure";
  const cancelledIds: string[] = [];
  const openai = {
    responses: {
      retrieve() {
        throw new Error("retrieve should not run after persistence failure");
      },
      cancel: async (responseId: string) => {
        cancelledIds.push(responseId);
        return queued;
      },
    },
  } as unknown as Pick<OpenAI, "responses">;

  await assert.rejects(
    adapter.waitForOpenAIBackgroundResponse(openai, queued, {
      providerRequestId: "req_persistence_failure",
      pollIntervalMs: 0,
      onProviderProgress: () => {
        throw new Error("database unavailable");
      },
    }),
    /database unavailable/,
  );
  assert.deepEqual(cancelledIds, ["resp_persistence_failure"]);
});

test("replays all response output before matching function call outputs", () => {
  const reasoning = {
    id: "reasoning_1",
    type: "reasoning",
    summary: [],
  } as ResponseOutputItem;
  const first = functionCall("call_a", "read_document", '{"doc_id":"d1"}');
  const second = functionCall("call_b", "find_in_document", '{"query":"rent"}');
  const response = responseFixture({ output: [reasoning, first, second] });

  const continuation = adapter.buildToolContinuationInput(response, [
    { tool_use_id: "call_a", content: "Document A" },
    { tool_use_id: "call_b", content: "Match B" },
  ]);

  assert.equal(continuation.length, 5);
  assert.equal(continuation[0], reasoning);
  assert.equal(continuation[1], first);
  assert.equal(continuation[2], second);
  assert.deepEqual(continuation.slice(3), [
    {
      type: "function_call_output",
      call_id: "call_a",
      output: "Document A",
    },
    {
      type: "function_call_output",
      call_id: "call_b",
      output: "Match B",
    },
  ]);
});

test("extracts completed output text", () => {
  assert.deepEqual(
    adapter.extractCompletedOpenAIOutput(
      responseFixture({ outputText: "Answer" }),
    ),
    { kind: "text", text: "Answer" },
  );
});

test("extracts refusal content when output_text is empty", () => {
  const response = responseFixture({
    output: [
      {
        id: "msg_refusal",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "refusal", refusal: "I cannot help with that." }],
      },
    ],
  });

  assert.deepEqual(adapter.extractCompletedOpenAIOutput(response), {
    kind: "refusal",
    text: "I cannot help with that.",
  });
});

test("returns tool calls instead of treating a tool iteration as empty", () => {
  const response = responseFixture({
    output: [functionCall("call_a", "read_document", "{}")],
  });
  assert.deepEqual(adapter.extractCompletedOpenAIOutput(response), {
    kind: "tool_calls",
    text: "",
  });
});

test("throws a named safe error for an empty completed response", () => {
  assert.throws(
    () => adapter.extractCompletedOpenAIOutput(responseFixture()),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "OPENAI_EMPTY_RESPONSE" &&
      !error.message.includes("sk-"),
  );
});

test("keeps failed and incomplete completed-response errors explicit and sanitized", () => {
  assert.throws(
    () =>
      adapter.extractCompletedOpenAIOutput(
        responseFixture({
          status: "failed",
          errorMessage: "provider failed with sk-proj-secretsecretsecret",
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "OPENAI_RESPONSE_FAILED" &&
      !error.message.includes("sk-proj-secretsecretsecret"),
  );

  assert.throws(
    () =>
      adapter.extractCompletedOpenAIOutput(
        responseFixture({
          status: "incomplete",
          incompleteReason: "max_output_tokens",
        }),
      ),
    (error: unknown) =>
      error instanceof Error && error.name === "OPENAI_RESPONSE_INCOMPLETE",
  );
});

test("executes Standard stream callbacks using Docket's browser-facing event vocabulary", async () => {
  const final = responseFixture({ outputText: "Hello world" });
  const events = [
    { type: "response.output_text.delta", delta: "Hello " },
    {
      type: "response.reasoning_summary_text.delta",
      delta: "Checking the record",
    },
    { type: "response.reasoning_summary_text.done", text: "Checking the record" },
    { type: "response.output_text.delta", delta: "world" },
    { type: "response.completed", response: final },
  ] as ResponseStreamEvent[];
  const browserEvents: Array<{ type: string; text?: string }> = [];

  const result = await adapter.consumeOpenAIStandardStream(
    (async function* () {
      yield* events;
    })(),
    {
      enableThinking: true,
      onDelta: (text) =>
        browserEvents.push({ type: "content_delta", text }),
      onReasoningDelta: (text) =>
        browserEvents.push({ type: "reasoning_delta", text }),
      onReasoningBlockEnd: () =>
        browserEvents.push({ type: "reasoning_block_end" }),
    },
  );

  assert.equal(result.response, final);
  assert.deepEqual(browserEvents, [
    { type: "content_delta", text: "Hello " },
    { type: "reasoning_delta", text: "Checking the record" },
    { type: "reasoning_block_end" },
    { type: "content_delta", text: "world" },
  ]);
});

test("resumes an incomplete response stream exactly once from its last sequence", async () => {
  const created = responseFixture({ status: "in_progress" });
  created.id = "resp_resume";
  const final = responseFixture({ outputText: "Hello world" });
  final.id = "resp_resume";
  const emitted: string[] = [];
  const resumeCalls: Array<{ responseId: string; startingAfter: number | null }> = [];

  const result = await adapter.consumeOpenAIStreamWithSingleResume(
    (async function* () {
      yield {
        type: "response.created",
        response: created,
        sequence_number: 0,
      } as ResponseStreamEvent;
      yield {
        type: "response.output_text.delta",
        delta: "Hello ",
        sequence_number: 1,
      } as ResponseStreamEvent;
    })(),
    {
      onDelta: (delta) => emitted.push(delta),
      resume: async (responseId, startingAfter) => {
        resumeCalls.push({ responseId, startingAfter });
        return (async function* () {
          yield {
            type: "response.output_text.delta",
            delta: "world",
            sequence_number: 2,
          } as ResponseStreamEvent;
          yield {
            type: "response.completed",
            response: final,
            sequence_number: 3,
          } as ResponseStreamEvent;
        })();
      },
    },
  );

  assert.equal(result.response, final);
  assert.equal(result.providerResponseId, "resp_resume");
  assert.equal(result.lastSequenceNumber, 3);
  assert.equal(result.recoveryAttempted, true);
  assert.deepEqual(resumeCalls, [
    { responseId: "resp_resume", startingAfter: 1 },
  ]);
  assert.deepEqual(emitted, ["Hello ", "world"]);
});

test("records the response cursor when the one allowed stream resume also ends early", async () => {
  const created = responseFixture({ status: "in_progress" });
  created.id = "resp_still_incomplete";
  let resumeCount = 0;

  await assert.rejects(
    adapter.consumeOpenAIStreamWithSingleResume(
      (async function* () {
        yield {
          type: "response.created",
          response: created,
          sequence_number: 4,
        } as ResponseStreamEvent;
      })(),
      {
        resume: async () => {
          resumeCount += 1;
          return (async function* () {
            yield {
              type: "response.in_progress",
              response: created,
              sequence_number: 5,
            } as ResponseStreamEvent;
          })();
        },
      },
    ),
    (error: unknown) => {
      const candidate = error as Error & {
        providerResponseId?: string;
        lastSequenceNumber?: number;
        recoveryAttempted?: boolean;
      };
      return (
        candidate.name === "OPENAI_STREAM_INCOMPLETE" &&
        candidate.providerResponseId === "resp_still_incomplete" &&
        candidate.lastSequenceNumber === 5 &&
        candidate.recoveryAttempted === true
      );
    },
  );

  assert.equal(resumeCount, 1);
});

test("emits Pro final text and refusal content through the existing content callback", () => {
  const emitted: string[] = [];
  const text = adapter.emitCompletedOpenAIContent(
    responseFixture({ outputText: "Final answer" }),
    (delta) => emitted.push(delta),
  );
  const refusal = adapter.emitCompletedOpenAIContent(
    responseFixture({
      output: [
        {
          id: "msg_refusal",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "Cannot comply" }],
        },
      ],
    }),
    (delta) => emitted.push(delta),
  );

  assert.deepEqual(text, { kind: "text", text: "Final answer" });
  assert.deepEqual(refusal, { kind: "refusal", text: "Cannot comply" });
  assert.deepEqual(emitted, ["Final answer", "Cannot comply"]);
});

test("emits distinct normalized tool-call starts from completed output", () => {
  const started: Array<{ id: string; name: string }> = [];
  const response = responseFixture({
    output: [
      functionCall("call_a", "read_document", '{"doc_id":"d1"}'),
      functionCall("call_b", "find_in_document", '{"query":"rent"}'),
    ],
  });

  const calls = adapter.emitOpenAIToolCallStarts(response, (call) =>
    started.push({ id: call.id, name: call.name }),
  );

  assert.deepEqual(started, [
    { id: "call_a", name: "read_document" },
    { id: "call_b", name: "find_in_document" },
  ]);
  assert.deepEqual(
    calls.map((call) => call.id),
    ["call_a", "call_b"],
  );
});

test("sanitizes Standard stream errors before they escape the adapter", async () => {
  const secret = "sk-proj-streamsecretsecret";
  const events = [
    {
      type: "error",
      code: "server_error",
      message: `authorization: Bearer ${secret}`,
      param: null,
      sequence_number: 1,
    },
  ] as ResponseStreamEvent[];

  await assert.rejects(
    adapter.consumeOpenAIStandardStream(
      (async function* () {
        yield* events;
      })(),
      {},
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "OPENAI_STREAM_ERROR" &&
      !error.message.includes(secret),
  );
});

test("propagates aborts during a Standard stream without emitting later deltas", async () => {
  const controller = new AbortController();
  const emitted: string[] = [];

  await assert.rejects(
    adapter.consumeOpenAIStandardStream(
      (async function* () {
        yield {
          type: "response.output_text.delta",
          delta: "first",
        } as ResponseStreamEvent;
        controller.abort();
        yield {
          type: "response.output_text.delta",
          delta: "second",
        } as ResponseStreamEvent;
      })(),
      {
        abortSignal: controller.signal,
        onDelta: (delta) => emitted.push(delta),
      },
    ),
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError",
  );

  assert.deepEqual(emitted, ["first"]);
});

test("normalizes usage from the actual response model including cache writes", () => {
  const response = responseFixture({
    model: "gpt-5.6-terra",
    usage: {
      input_tokens: 1_000_000,
      input_tokens_details: {
        cached_tokens: 200_000,
        cache_write_tokens: 100_000,
      },
      output_tokens: 1_000_000,
      output_tokens_details: { reasoning_tokens: 250_000 },
      total_tokens: 2_000_000,
    },
  });

  assert.deepEqual(adapter.normalizeOpenAIUsage(response), {
    provider: "openai",
    model: "gpt-5.6-terra",
    inputTokens: 1_000_000,
    cachedInputTokens: 200_000,
    cacheCreation5mTokens: 100_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
    providerResponseId: "resp_test",
  });
});

test("builds the ledger record from response.model rather than the requested selection", () => {
  const response = responseFixture({
    model: "gpt-5.6-terra",
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 150,
    },
  });

  const record = adapter.buildOpenAILedgerUsage(response, {
    apiKeys: {
      ownerUserId: "owner-1",
      sources: { openai: "user_api_key" },
    },
    aiObservability: {
      distinctId: "viewer-1",
      route: "chat",
      chatId: "chat-1",
      projectId: "project-1",
    },
  });

  assert.equal(record.model, "gpt-5.6-terra");
  assert.equal(record.providerResponseId, "resp_test");
  assert.equal(record.billingSource, "user_api_key");
  assert.equal(record.context?.userId, "owner-1");
  assert.equal(record.cachedInputTokens, 20);
  assert.equal(record.cacheCreation5mTokens, 10);
});

test("prices the actual response model and leaves an unknown actual model unpriced", async () => {
  const spend = await import("../src/lib/llmSpend");
  const terra = adapter.normalizeOpenAIUsage(
    responseFixture({
      model: "gpt-5.6-terra",
      usage: {
        input_tokens: 1_000_000,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 1_000_000,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2_000_000,
      },
    }),
  );
  const unknown = { ...terra, model: "gpt-5.6-future" };

  assert.equal(spend.calculateLlmCostNanos(terra).totalCostNanos, 17_500_000_000n);
  assert.equal(spend.calculateLlmCostNanos(unknown).pricingStatus, "unpriced");
});

test("builds approved success metadata with actual response model as primary", () => {
  const identity = adapter.buildOpenAIGenerationIdentity({
    resolvedModel: "gpt-5.6-sol",
    actualResponseModel: "gpt-5.6-terra",
    streaming: false,
    metadata: {
      requested_model: "gpt-5.6-sol",
      resolved_model: "gpt-5.6-sol",
      reasoning_mode: "pro",
      reasoning_effort: "high",
      model_resolution_status: "direct",
      assistant_run_id: "019f7170-9f04-72c1-8364-45f504ca2153",
    },
  });

  assert.deepEqual(identity, {
    model: "gpt-5.6-terra",
    metadata: {
      requested_model: "gpt-5.6-sol",
      resolved_model: "gpt-5.6-sol",
      actual_response_model: "gpt-5.6-terra",
      reasoning_mode: "pro",
      reasoning_effort: "high",
      streaming: false,
      model_resolution_status: "direct",
      assistant_run_id: "019f7170-9f04-72c1-8364-45f504ca2153",
    },
  });
});

test("failure identity keeps resolved model, sets actual null, and drops unsafe metadata", () => {
  const secret = "sk-proj-metadatasecretsecret";
  const identity = adapter.buildOpenAIGenerationIdentity({
    resolvedModel: "gpt-5.6-sol",
    actualResponseModel: null,
    streaming: true,
    metadata: {
      requested_model: "gpt-5.6-sol",
      resolved_model: "gpt-5.6-sol",
      reasoning_mode: "standard",
      reasoning_effort: "medium",
      model_resolution_status: "direct",
      api_key: secret,
      prompt: "privileged prompt text",
      document_content: "private document body",
      raw_provider_error: `authorization: Bearer ${secret}`,
    },
  });
  const serialized = JSON.stringify(identity);

  assert.equal(identity.model, "gpt-5.6-sol");
  assert.equal(identity.metadata.actual_response_model, null);
  assert.deepEqual(Object.keys(identity.metadata).sort(), [
    "actual_response_model",
    "model_resolution_status",
    "reasoning_effort",
    "reasoning_mode",
    "requested_model",
    "resolved_model",
    "streaming",
  ]);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("privileged prompt text"), false);
  assert.equal(serialized.includes("private document body"), false);
  assert.equal(serialized.includes("authorization"), false);
});
