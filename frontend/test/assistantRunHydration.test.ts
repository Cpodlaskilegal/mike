import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ASSISTANT_CANCELLATION_PENDING_MESSAGE,
  findHydratedAssistantRun,
  markAssistantCancellationPending,
} from "../src/app/lib/assistantRunHydration";

test("selects the newest pending message's durable run", () => {
  assert.deepEqual(
    findHydratedAssistantRun([
      {
        role: "assistant",
        content: "Already done",
        pending: false,
        assistantRun: {
          streamRequestId: "run-finished",
          status: "in_progress",
        },
      },
      {
        role: "assistant",
        content: "",
        pending: true,
        assistantRun: {
          streamRequestId: "run-active",
          projectId: "project-1",
          status: "cancel_requested",
        },
      },
    ]),
    {
      streamRequestId: "run-active",
      projectId: "project-1",
      status: "cancel_requested",
    },
  );
});

test("marks a hydrated run cancellation pending only after durable acknowledgement", () => {
  const messages = [
    { role: "user" as const, content: "Analyze this" },
    {
      role: "assistant" as const,
      content: "",
      pending: true,
      assistantRun: {
        streamRequestId: "run-active",
        status: "in_progress" as const,
      },
    },
  ];
  const updated = markAssistantCancellationPending(messages, "run-active");

  assert.notEqual(updated, messages);
  assert.equal(
    updated[1].error,
    ASSISTANT_CANCELLATION_PENDING_MESSAGE,
  );
  assert.equal(
    markAssistantCancellationPending(messages, "other-run"),
    messages,
  );
});

test("chat hydration restores the owned durable run onto its pending message", () => {
  const api = readFileSync(
    new URL("../src/app/lib/docketApi.ts", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(
    new URL("../src/app/hooks/useAssistantChat.ts", import.meta.url),
    "utf8",
  );

  assert.match(api, /raw\.active_run\?\.assistant_message_id === m\.id/);
  assert.match(api, /assistantRun: activeRun/);
  assert.match(api, /activeRun\?\.status === "cancel_requested"/);
  assert.match(hook, /findHydratedAssistantRun\(messages\)/);
  assert.match(hook, /\.then\(\(\) => \{/);
  assert.match(hook, /markAssistantCancellationPending/);
  assert.match(
    hook,
    /assistantRequestContinuesAfterDisconnect\(generationPayload\)/,
  );
  assert.match(hook, /getAssistantRunStatus\(/);
  assert.match(hook, /recoverableChatId = durableRun\.chat_id/);
  assert.match(hook, /cancelRequested: false,\s+continuingAfterDisconnect,/);
  assert.match(
    hook,
    /streamRequestId: hydratedRun\.streamRequestId[\s\S]*?controller: null/,
  );
  assert.match(
    hook,
    /cancelRequested: hydratedRun\.status === "cancel_requested"/,
  );
});
