import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AssistantStreamPrematureEofError,
  createAssistantStreamRequestId,
  parseAssistantStreamTerminalStatus,
  requireAssistantStreamDone,
} from "../src/app/lib/assistantSse";

test("accepts only an explicitly completed assistant SSE stream", () => {
  assert.doesNotThrow(() =>
    requireAssistantStreamDone({ sawDone: true, sawTerminalEvent: true }),
  );
  assert.throws(
    () =>
      requireAssistantStreamDone({ sawDone: false, sawTerminalEvent: true }),
    (error: unknown) =>
      error instanceof AssistantStreamPrematureEofError && error.retryable,
  );
  assert.throws(
    () =>
      requireAssistantStreamDone({ sawDone: true, sawTerminalEvent: false }),
    (error: unknown) =>
      error instanceof AssistantStreamPrematureEofError && error.retryable,
  );
});

test("accepts only known assistant terminal statuses", () => {
  assert.equal(parseAssistantStreamTerminalStatus("completed"), "completed");
  assert.equal(
    parseAssistantStreamTerminalStatus("background_pending"),
    "background_pending",
  );
  assert.equal(
    parseAssistantStreamTerminalStatus("cancellation_pending"),
    "cancellation_pending",
  );
  assert.equal(parseAssistantStreamTerminalStatus("cancelled"), "cancelled");
  assert.equal(parseAssistantStreamTerminalStatus("error"), "error");
  assert.equal(parseAssistantStreamTerminalStatus("unknown"), null);
  assert.equal(parseAssistantStreamTerminalStatus(undefined), null);
});

test("creates UUID stream request IDs for cancellation and background polling", () => {
  assert.match(
    createAssistantStreamRequestId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test("the chat hook does not reinterpret premature EOF as background success", () => {
  const hook = readFileSync(
    new URL("../src/app/hooks/useAssistantChat.ts", import.meta.url),
    "utf8",
  );
  assert.match(hook, /requireAssistantStreamDone\(\{/);
  assert.doesNotMatch(
    hook,
    /error instanceof AssistantStreamPrematureEofError/,
  );
  assert.doesNotMatch(hook, /cancelFallbackRef/);
  assert.doesNotMatch(hook, /explicitCancelIdsRef/);
  assert.match(hook, /parseAssistantStreamTerminalStatus/);
  assert.match(hook, /terminalStatus === "cancelled"/);
  assert.match(hook, /continuingRunNeedsPolling/);
  assert.match(hook, /continuingAfterDisconnect/);
  assert.match(hook, /pending: true/);
});
