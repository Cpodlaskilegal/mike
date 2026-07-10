import assert from "node:assert/strict";
import test from "node:test";
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
  outputText?: string;
  output?: ResponseOutputItem[];
  status?: Response["status"];
  errorMessage?: string;
  incompleteReason?: string;
} = {}): Response {
  return {
    id: "resp_test",
    model: "gpt-5.6-sol",
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

test("builds Pro as a non-streaming mode without inventing a model slug", () => {
  for (const model of GPT_5_6_MODELS) {
    const request = adapter.buildOpenAIProNonStreamingRequest({
      model,
      input: "Hello",
      tools: [docketTool],
      parallel_tool_calls: true,
      reasoningEffort: "medium",
    });

    assert.equal(request.model, model);
    assert.equal(request.stream, false);
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
