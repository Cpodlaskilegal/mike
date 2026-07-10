import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

test("OpenAI bulk generation keeps its 4096-token cap while forwarding cancellation", async () => {
  const [tabular, llmIndex, openai] = await Promise.all([
    source("routes/tabular.ts"),
    source("lib/llm/index.ts"),
    source("lib/llm/openai.ts"),
  ]);

  assert.ok(
    /completeText\(\{[\s\S]*?maxTokens:\s*4096,[\s\S]*?abortSignal:\s*signal/.test(
      tabular,
    ),
    "Tabular OpenAI generation must preserve maxTokens: 4096 and pass its signal",
  );
  assert.match(llmIndex, /abortSignal\?\s*:\s*AbortSignal/);
  assert.match(openai, /abortSignal\?\s*:\s*AbortSignal/);
  assert.match(openai, /abortSignal:\s*params\.abortSignal/);
});
