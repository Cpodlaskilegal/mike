import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { toChatStreamError } from "../src/lib/chatErrors";
import {
  assertFinalSynthesisResult,
  buildToolLoopIteration,
  normalizeMaxToolIterations,
  ToolIterationLimitError,
} from "../src/lib/llm/types";

const backendRoot = resolve(new URL("..", import.meta.url).pathname);

test("tool iteration budget reserves exactly one tools-disabled synthesis turn", () => {
  const tools = [{ name: "courtlistener_search_case_law" }];
  const maxToolIterations = normalizeMaxToolIterations(10);

  for (let iteration = 0; iteration < maxToolIterations; iteration += 1) {
    const plan = buildToolLoopIteration(
      iteration,
      maxToolIterations,
      tools,
      "Preserve legal citations.",
    );
    assert.equal(plan.finalSynthesis, false);
    assert.equal(plan.tools, tools);
    assert.equal(plan.systemPrompt, "Preserve legal citations.");
  }

  const synthesis = buildToolLoopIteration(
    maxToolIterations,
    maxToolIterations,
    tools,
    "Preserve legal citations.",
  );
  assert.equal(synthesis.finalSynthesis, true);
  assert.deepEqual(synthesis.tools, []);
  assert.match(synthesis.systemPrompt, /Preserve legal citations\./);
  assert.match(synthesis.systemPrompt, /FINAL RESPONSE REQUIRED/);
  assert.match(synthesis.systemPrompt, /complete final answer now/);
  assert.match(synthesis.systemPrompt, /citation and output-format requirement/);
});

test("tool iteration limits are bounded to usable integer values", () => {
  assert.equal(normalizeMaxToolIterations(undefined), 10);
  assert.equal(normalizeMaxToolIterations(Number.NaN), 10);
  assert.equal(normalizeMaxToolIterations(Number.POSITIVE_INFINITY), 10);
  assert.equal(normalizeMaxToolIterations(-4), 0);
  assert.equal(normalizeMaxToolIterations(3.9), 3);
});

test("tool-loop exhaustion is a named retryable incomplete-response error", () => {
  const error = new ToolIterationLimitError("openai", {
    providerResponseId: "resp-1",
    providerRequestId: "req-1",
  });

  assert.equal(error.name, "TOOL_ITERATION_LIMIT");
  assert.equal(error.retryable, true);
  assert.equal(error.provider, "openai");
  assert.equal(error.providerResponseId, "resp-1");
  assert.deepEqual(toChatStreamError(error), {
    type: "error",
    code: "incomplete_response",
    retryable: true,
    message:
      "Docket reached its research-step limit before writing the final answer. Retry the request.",
  });
});

test("final synthesis rejects whitespace and further tool calls", () => {
  assert.doesNotThrow(() =>
    assertFinalSynthesisResult("openai", {
      text: "I cannot provide that answer.",
      toolCallCount: 0,
    }),
  );
  for (const result of [
    { text: " \n", toolCallCount: 0 },
    { text: "I need one more search.", toolCallCount: 1 },
  ]) {
    assert.throws(
      () => assertFinalSynthesisResult("openai", result),
      (error: unknown) =>
        error instanceof ToolIterationLimitError &&
        error.name === "TOOL_ITERATION_LIMIT",
    );
  }
});

test("every provider adapter uses the shared final-synthesis loop contract", () => {
  for (const relativePath of [
    "src/lib/llm/openai.ts",
    "src/lib/llm/claude.ts",
    "src/lib/llm/gemini.ts",
  ]) {
    const source = readFileSync(resolve(backendRoot, relativePath), "utf8");
    assert.match(source, /buildToolLoopIteration\(/);
    assert.match(
      source,
      /for \(let iter = 0; iter <= maxToolIterations; iter\+\+\)/,
    );
    assert.match(source, /assertFinalSynthesisResult\(/);
  }
});
