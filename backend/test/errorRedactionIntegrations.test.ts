import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

test("OpenAI failure telemetry passes a redacted error value", async () => {
  const openai = await source("lib/llm/openai.ts");

  assert.ok(
    openai.includes('from "../safeError"'),
    "OpenAI telemetry must import the error redactor",
  );
  assert.equal(
    (openai.match(/error:\s*safeErrorMessage\(error\),/g) ?? []).length,
    2,
  );
  assert.ok(
    openai.includes("buildOpenAIGenerationIdentity"),
    "OpenAI telemetry must construct an allowlisted model identity",
  );
  assert.ok(
    openai.includes("actual_response_model"),
    "OpenAI telemetry must explicitly distinguish actual response models",
  );
  assert.doesNotMatch(
    openai,
    /\.\.\.params\.aiObservability\?\.metadata/,
    "OpenAI telemetry must not spread arbitrary caller metadata into generation events",
  );
});

test("PostHog capture failures redact their console warning", async () => {
  const posthog = await source("lib/posthog.ts");

  assert.ok(
    posthog.includes('from "./safeError"'),
    "PostHog must import the error redactor",
  );
  assert.ok(
    posthog.includes('safeErrorMessage(error, "Failed to capture AI generation")'),
    "PostHog capture failure warning must use a safe fallback",
  );
});

test("tabular assistant failures log a safe error object", async () => {
  const tabular = await source("routes/tabular.ts");

  assert.ok(
    tabular.includes('from "../lib/safeError"'),
    "tabular assistant routes must import the safe logger",
  );
  assert.ok(
    (tabular.match(/safeErrorLog\(err\)/g) ?? []).length >= 5,
    "every tabular LLM catch should pass a redacted error object to console.error",
  );
});

test("chat stream routes log redacted errors while preserving generic SSE errors", async () => {
  for (const route of ["routes/chat.ts", "routes/projectChat.ts"]) {
    const routeSource = await source(route);

    assert.ok(
      routeSource.includes('from "../lib/safeError"'),
      `${route} must import the safe logger`,
    );
    assert.ok(
      routeSource.includes("safeErrorLog(err)"),
      `${route} must not log the raw assistant error`,
    );
    assert.ok(
      routeSource.includes("chatStreamErrorLine(err)"),
      `${route} must retain its structured SSE error response`,
    );
  }
});

test("touched assistant routes do not pass raw catch errors to console.error", async () => {
  const [chat, tabular] = await Promise.all([
    source("routes/chat.ts"),
    source("routes/tabular.ts"),
  ]);

  assert.ok(
    chat.includes('console.error("[generate-title]", safeErrorLog(err))'),
    "chat title generation must redact its caught error",
  );

  const rawExtractionLogs =
    tabular.match(
      /console\.error\([\s\S]{0,160}extraction error[\s\S]{0,80},\s*err,?\s*\)/g,
    ) ?? [];
  assert.equal(
    rawExtractionLogs.length,
    0,
    "regenerate-cell and bulk-generation extraction catches must use safeErrorLog(err)",
  );
  assert.ok(
    (tabular.match(/safeErrorLog\(err\)/g) ?? []).length >= 7,
    "both extraction catches must be covered by the safe logger",
  );
});
