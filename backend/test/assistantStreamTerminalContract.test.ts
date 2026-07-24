import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const backendRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(backendRoot, "..");

test("assistant routes hand extended runs to background and emit terminal JSON", () => {
  for (const relativePath of [
    "src/routes/chat.ts",
    "src/routes/projectChat.ts",
  ]) {
    const source = readFileSync(resolve(backendRoot, relativePath), "utf8");
    assert.match(source, /PRO_BACKGROUND_CUTOFF_MS/);
    assert.match(source, /shouldContinueAssistantStreamAfterDisconnect/);
    assert.match(source, /type:\s*"background_pending"/);
    assert.match(source, /type:\s*"cancellation_pending"/);
    assert.match(source, /const runPersistenceEnabled = true/);
    assert.match(source, /assistantStreamTerminalEvent/);
    assert.match(source, /requestAssistantStreamCancellation/);
    assert.match(source, /status:\s*"cancel_requested"/);
    assert.match(source, /getAssistantBackgroundRunById/);
    assert.match(source, /clearAllBackgroundTimers\(\)/);
    assert.match(source, /backgroundCompletionFinalizing/);
    assert.match(source, /X-Docket-Trace-Id/);
    assert.match(source, /revision:\s*streamLifecycle\.revision/);
  }
});

test("browser requires terminal JSON and DONE instead of accepting bare EOF", () => {
  const hook = readFileSync(
    resolve(repoRoot, "frontend/src/app/hooks/useAssistantChat.ts"),
    "utf8",
  );
  const contract = readFileSync(
    resolve(repoRoot, "frontend/src/app/lib/assistantSse.ts"),
    "utf8",
  );

  assert.match(hook, /data\.type === "stream_terminal"/);
  assert.match(hook, /sawTerminalEvent = true/);
  assert.match(hook, /parseAssistantStreamTerminalStatus/);
  assert.match(hook, /terminalStatus === "cancelled"/);
  assert.match(hook, /sawTerminalDone = true/);
  assert.match(hook, /requireAssistantStreamDone\(\{/);
  assert.match(contract, /!input\.sawDone \|\| !input\.sawTerminalEvent/);
});
