import assert from "node:assert/strict";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  MessageParam,
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

test("builds the exact Opus 5 adaptive-thinking request for every effort", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const request = adapter.buildClaudeStreamingRequest({
      model: "claude-opus-5",
      systemPrompt: "Be precise.",
      messages,
      tools,
      enableThinking: true,
      reasoningEffort: effort,
    });

    assert.deepEqual(request, {
      model: "claude-opus-5",
      system: "Be precise.",
      messages,
      tools,
      max_tokens: 16_384,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
    });
    assert.equal("temperature" in request, false);
    assert.equal("top_p" in request, false);
    assert.equal("top_k" in request, false);
    assert.equal("betas" in request, false);
    assert.equal("service_tier" in request, false);
  }
});

test("defaults Opus 5 to High while rejecting non-Opus effort values", () => {
  const request = adapter.buildClaudeStreamingRequest({
    model: "claude-opus-5",
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
          model: "claude-opus-5",
          messages,
          reasoningEffort: invalid,
        }),
      /Claude Opus 5 reasoning effort/,
    );
  }
});

test("keeps existing Claude model thinking behavior isolated from Opus 5", () => {
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
