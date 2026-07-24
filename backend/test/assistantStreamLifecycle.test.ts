import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantRuntimeRevision,
  assistantStreamAbortCause,
  assistantStreamTerminalEvent,
  isAssistantStreamRequestId,
  PRO_BACKGROUND_CUTOFF_MS,
  registerAssistantStream,
  requestAssistantStreamCancellation,
  shouldContinueAssistantStreamAfterDisconnect,
  unregisterAssistantStream,
} from "../src/lib/assistantStreamLifecycle";

test("registers a UUID run ID and authorizes explicit cancellation by owner", () => {
  const controller = new AbortController();
  const stream = registerAssistantStream({
    userId: "owner",
    chatId: "chat-1",
    route: "chat",
    controller,
  });

  try {
    assert.equal(isAssistantStreamRequestId(stream.streamRequestId), true);
    assert.equal(controller.signal.aborted, false);
    assert.equal(
      requestAssistantStreamCancellation({
        streamRequestId: stream.streamRequestId,
        userId: "different-user",
        route: "chat",
      }),
      null,
    );
    assert.equal(controller.signal.aborted, false);

    const cancelled = requestAssistantStreamCancellation({
      streamRequestId: stream.streamRequestId,
      userId: "owner",
      route: "chat",
    });
    assert.equal(cancelled, stream);
    assert.equal(controller.signal.aborted, true);
    assert.equal(assistantStreamAbortCause(stream), "explicit_user_cancel");
  } finally {
    unregisterAssistantStream(stream);
  }
});

test("project cancellation also requires the matching project", () => {
  const stream = registerAssistantStream({
    requestedStreamId: "019f7170-9f04-72c1-8364-45f504ca2153",
    userId: "owner",
    chatId: "chat-2",
    projectId: "project-1",
    route: "project_chat",
    controller: new AbortController(),
  });

  try {
    assert.equal(
      requestAssistantStreamCancellation({
        streamRequestId: stream.streamRequestId,
        userId: "owner",
        route: "project_chat",
        projectId: "project-2",
      }),
      null,
    );
    assert.equal(stream.controller.signal.aborted, false);
  } finally {
    unregisterAssistantStream(stream);
  }
});

test("reports the deployed Container Apps revision with safe fallbacks", () => {
  assert.equal(
    assistantRuntimeRevision({ CONTAINER_APP_REVISION: "mike-api--0000042" }),
    "mike-api--0000042",
  );
  assert.equal(assistantRuntimeRevision({}), "local");
});

test("hands Pro runs to background before ingress timeout but aborts Standard", () => {
  assert.equal(PRO_BACKGROUND_CUTOFF_MS, 225_000);
  assert.equal(shouldContinueAssistantStreamAfterDisconnect("pro"), true);
  assert.equal(
    shouldContinueAssistantStreamAfterDisconnect("standard", "max"),
    true,
  );
  assert.equal(shouldContinueAssistantStreamAfterDisconnect("standard"), false);
});

test("terminal events carry the same run, trace, and revision identifiers", () => {
  const stream = registerAssistantStream({
    requestedStreamId: "019f7170-9f04-72c1-8364-45f504ca2153",
    userId: "owner",
    chatId: "chat-terminal",
    route: "chat",
    controller: new AbortController(),
  });
  try {
    assert.deepEqual(
      assistantStreamTerminalEvent(stream, "background_pending", {
        retryable: true,
        continuing: true,
      }),
      {
        type: "stream_terminal",
        status: "background_pending",
        runId: stream.streamRequestId,
        traceId: stream.traceId,
        revision: stream.revision,
        retryable: true,
        continuing: true,
      },
    );
  } finally {
    unregisterAssistantStream(stream);
  }
});
