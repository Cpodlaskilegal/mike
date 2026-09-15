import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  MessageParam,
  MessageStreamParams,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

let adapter: typeof import("../src/lib/llm/claude");

test.before(async () => {
  adapter = await import("../src/lib/llm/claude");
});

const messages: MessageParam[] = [{ role: "user", content: "Hello" }];
const tools: Tool[] = [
  {
    name: "read_document",
    description: "Read one document",
    input_schema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
];

function messageFixture(input: {
  content: ContentBlock[];
  stopReason: Anthropic.Messages.StopReason;
}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: input.content,
    stop_reason: input.stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as Anthropic.Message;
}

const reasoningModels = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-5",
];

test("builds current Claude adaptive-thinking requests for every effort", () => {
  for (const model of reasoningModels) {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const request = adapter.buildClaudeStreamingRequest({
        model,
        systemPrompt: "Be precise.",
        messages,
        tools,
        enableThinking: true,
        reasoningEffort: effort,
      });

      assert.deepEqual(request, {
        model,
        system: "Be precise.",
        messages,
        tools,
        max_tokens: effort === "xhigh" || effort === "max" ? 64_000 : 16_384,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort },
      });
      assert.equal("temperature" in request, false);
      assert.equal("top_p" in request, false);
      assert.equal("top_k" in request, false);
      assert.equal("betas" in request, false);
      assert.equal("service_tier" in request, false);
    }
  }
});

test("defaults current Claude models to High and keeps required thinking enabled", () => {
  for (const model of reasoningModels) {
    const request = adapter.buildClaudeStreamingRequest({
      model,
      enableThinking: false,
      messages,
    });

    assert.deepEqual(request.thinking, {
      type: "adaptive",
      display: "summarized",
    });
    assert.deepEqual(request.output_config, { effort: "high" });

    for (const invalid of ["none", "minimal"] as const) {
      assert.throws(
        () =>
          adapter.buildClaudeStreamingRequest({
            model,
            enableThinking: false,
            messages,
            reasoningEffort: invalid,
          }),
        /Claude reasoning effort/,
      );
    }
  }
});

test("keeps older Claude model thinking behavior unchanged", () => {
  const request = adapter.buildClaudeStreamingRequest({
    model: "claude-opus-4-8",
    messages,
    enableThinking: true,
    reasoningEffort: "max",
  });

  assert.deepEqual(request.thinking, { type: "adaptive" });
  assert.deepEqual(request.output_config, { effort: "high" });
});

test("preserves thinking signatures and all assistant blocks across a tool continuation", () => {
  const assistantBlocks: ContentBlock[] = [
    {
      type: "thinking",
      thinking: "I should inspect the document.",
      signature: "sig_preserve_exactly",
    },
    {
      type: "text",
      text: "I’ll inspect that.",
      citations: null,
    },
    {
      type: "tool_use",
      id: "tool_1",
      name: "read_document",
      input: { document_id: "doc_1" },
      caller: { type: "direct" },
    },
  ];
  const response = messageFixture({
    content: assistantBlocks,
    stopReason: "tool_use",
  });

  const iteration = adapter.extractClaudeIterationContent(response);
  assert.equal(iteration.text, "I’ll inspect that.");
  assert.deepEqual(iteration.toolCalls, [
    {
      id: "tool_1",
      name: "read_document",
      input: { document_id: "doc_1" },
    },
  ]);
  assert.equal(iteration.assistantBlocks, assistantBlocks);

  const continuation = adapter.buildClaudeToolContinuation(
    iteration.assistantBlocks,
    [{ tool_use_id: "tool_1", content: "Document text" }],
  );
  assert.equal(continuation[0]?.content, assistantBlocks);
  assert.deepEqual(continuation, [
    { role: "assistant", content: assistantBlocks },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "Document text",
        },
      ],
    },
  ]);
});

test("Fable 5.1 preserves signed prefixes through multiple tool rounds and final synthesis", async (t) => {
  const { pool } = await import("../src/lib/supabase");
  // Keep usage accounting on the normal code path without requiring a database.
  t.mock.method(pool, "connect", async () => ({
    async query() {
      return { rows: [], rowCount: 0 };
    },
    release() {},
  }));
  const requests: MessageStreamParams[] = [];
  const responses = ["one", "two"].map((suffix) =>
    messageFixture({
      content: [
        {
          type: "thinking",
          thinking: `Read source ${suffix}.`,
          signature: `signed_${suffix}`,
        },
        { type: "redacted_thinking", data: `opaque_${suffix}` },
        {
          type: "tool_use",
          id: `tool_${suffix}`,
          name: "read_document",
          input: { document_id: suffix },
          caller: { type: "direct" },
        },
      ],
      stopReason: "tool_use",
    }),
  );
  responses.push(
    messageFixture({
      content: [
        {
          type: "text",
          text: "The sources support this final answer.",
          citations: null,
        },
      ],
      stopReason: "end_turn",
    }),
  );
  t.mock.method(
    Anthropic.Messages.prototype,
    "stream",
    (request: MessageStreamParams) => {
      const response = responses[requests.length];
      assert.ok(response, "No request is allowed after the final synthesis");
      requests.push(structuredClone(request));
      return {
        on() {},
        abort() {},
        async finalMessage() {
          return response;
        },
      };
    },
  );
  const toolExecutions: string[] = [];
  const result = await adapter.streamClaude({
    model: "claude-fable-5-1",
    systemPrompt: "Preserve every legal citation and source qualification.",
    messages: [{ role: "user", content: "Compare the two source documents." }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_document",
          description: "Read one document",
          parameters: tools[0].input_schema,
        },
      },
    ],
    maxIterations: 2,
    reasoningEffort: "high",
    apiKeys: { claude: "test-only-not-a-real-key" },
    async runTools(calls) {
      return calls.map((call) => {
        toolExecutions.push(call.id);
        return {
          tool_use_id: call.id,
          content: `Source ${call.input.document_id}`,
        };
      });
    },
  });
  assert.equal(result.fullText, "The sources support this final answer.");
  assert.deepEqual(toolExecutions, ["tool_one", "tool_two"]);
  assert.equal(requests.length, 3);
  const [first, second, final] = requests;
  assert.equal(first.tool_choice, undefined);
  assert.equal(second.tool_choice, undefined);
  assert.deepEqual(final.tool_choice, { type: "none" });
  for (const request of [second, final]) {
    assert.equal(request.system, first.system);
    assert.deepEqual(request.tools, first.tools);
    assert.deepEqual(request.messages[1], {
      role: "assistant",
      content: responses[0].content,
    });
    assert.deepEqual(
      request.messages.slice(0, first.messages.length),
      first.messages,
    );
  }
  assert.deepEqual(
    final.messages.slice(0, second.messages.length),
    second.messages,
  );
  assert.deepEqual(final.messages[3], {
    role: "assistant",
    content: responses[1].content,
  });
  assert.deepEqual(final.messages[4], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tool_two", content: "Source two" },
    ],
  });
  assert.equal(final.messages[5].role, "user");
  assert.match(String(final.messages[5].content), /FINAL RESPONSE REQUIRED/);
  assert.match(
    String(final.messages[5].content),
    /citation and output-format requirement/,
  );
});

test("Fable 5.1 final synthesis works with a zero tool budget and no tool definitions", () => {
  const result = adapter.buildClaudeToolLoopRequest({
    model: "claude-fable-5-1",
    systemPrompt: "Preserve citations.",
    messages,
    iteration: 0,
    maxToolIterations: 0,
  });
  assert.equal(result.finalSynthesis, true);
  assert.equal(result.request.system, "Preserve citations.");
  assert.equal(result.request.tools, undefined);
  assert.equal(result.request.tool_choice, undefined);
  assert.deepEqual(result.request.messages.slice(0, messages.length), messages);
  assert.match(
    String(result.request.messages.at(-1)?.content),
    /complete final answer now/,
  );
});

test("Sonnet 5 tabular completion forwards Low effort while retaining its 2048-token cap", async (t) => {
  const { pool } = await import("../src/lib/supabase");
  const { completeText } = await import("../src/lib/llm");
  t.mock.method(pool, "connect", async () => ({
    async query() { return { rows: [], rowCount: 0 }; },
    release() {},
  }));
  let submitted: Anthropic.MessageCreateParams | undefined;
  t.mock.method(Anthropic.Messages.prototype, "create", async (request: Anthropic.MessageCreateParams) => {
    submitted = request;
    return messageFixture({
      content: [{ type: "text", text: '{"answer":"September 15"}', citations: null }],
      stopReason: "end_turn",
    });
  });
  const result = await completeText({
    model: "claude-sonnet-5", systemPrompt: "Extract the requested fact.",
    user: "The deadline is September 15.", reasoningEffort: "low", maxTokens: 2048,
    apiKeys: { claude: "test-only-not-a-real-key" },
  });
  assert.equal(result, '{"answer":"September 15"}');
  assert.equal(submitted?.model, "claude-sonnet-5");
  assert.equal(submitted?.max_tokens, 2048);
  assert.deepEqual(submitted?.output_config, { effort: "low" });
  assert.deepEqual(submitted?.thinking, { type: "adaptive", display: "summarized" });
});

test("keeps refusal and max-token partial text usable", () => {
  for (const stopReason of ["refusal", "max_tokens"] as const) {
    const response = messageFixture({
      content: [
        {
          type: "text",
          text: "Useful partial response.",
          citations: null,
        },
      ],
      stopReason,
    });
    const iteration = adapter.extractClaudeIterationContent(response);

    assert.equal(iteration.text, "Useful partial response.");
    assert.doesNotThrow(() =>
      adapter.assertUsableClaudeStopReason(response.stop_reason),
    );
  }
});

test("classifies context exhaustion and an unexpected paused turn", () => {
  assert.throws(
    () => adapter.assertUsableClaudeStopReason("model_context_window_exceeded"),
    (error: unknown) =>
      error instanceof adapter.ClaudeStopReasonError &&
      error.code === "model_context_window_exceeded" &&
      error.retryable === false &&
      error.message.includes("request too large"),
  );

  assert.throws(
    () => adapter.assertUsableClaudeStopReason("pause_turn"),
    (error: unknown) =>
      error instanceof adapter.ClaudeStopReasonError &&
      error.code === "pause_turn" &&
      error.retryable === true,
  );
});

test("aborts the Anthropic stream when the caller abort signal fires", async () => {
  const controller = new AbortController();
  let abortCount = 0;
  let rejectFinal: (error: Error) => void = () => undefined;
  const final = new Promise<Anthropic.Message>((_resolve, reject) => {
    rejectFinal = reject;
  });
  const stream = {
    abort() {
      abortCount += 1;
      const error = new Error("Stream aborted.");
      error.name = "APIUserAbortError";
      rejectFinal(error);
    },
    finalMessage() {
      return final;
    },
  };

  const pending = adapter.waitForClaudeFinalMessage(stream, controller.signal);
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(abortCount, 1);
});

test("does not begin waiting when the caller signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let abortCount = 0;
  let finalMessageCalled = false;
  const stream = {
    abort() {
      abortCount += 1;
    },
    async finalMessage() {
      finalMessageCalled = true;
      throw new Error("should not be called");
    },
  };

  await assert.rejects(
    adapter.waitForClaudeFinalMessage(stream, controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(abortCount, 1);
  assert.equal(finalMessageCalled, false);
});
