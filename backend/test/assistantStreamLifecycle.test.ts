import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantRunStartFailureRecord,
  assistantRunTerminalRecord,
  assistantRuntimeGitSha,
  assistantRuntimeRevision,
  assistantStreamAbortCause,
  assistantStreamTerminalEvent,
  isAssistantStreamRequestId,
  logAssistantRunTerminal,
  logAssistantRunSlowOnce,
  logAssistantRunStartUncertain,
  createAssistantRunStartDiagnostic,
  runAssistantStartupStep,
  PRO_BACKGROUND_CUTOFF_MS,
  registerAssistantStream,
  requestAssistantStreamCancellation,
  shouldContinueAssistantStreamAfterDisconnect,
  unregisterAssistantStream,
} from "../src/lib/assistantStreamLifecycle";

test("startup failures emit one content-free diagnostic for each failed step", async () => {
  const diagnostic = createAssistantRunStartDiagnostic({
    requestedStreamId: "019f7170-9f04-72c1-8364-45f504ca2153",
    route: "chat",
    startedAt: Date.now() - 100,
  });
  const record = assistantRunStartFailureRecord(diagnostic, "prompt_persist");
  assert.equal(record.event, "assistant_run_start_failure");
  assert.equal(record.run_id, diagnostic.streamRequestId);
  assert.equal(record.trace_id, diagnostic.traceId);
  assert.equal(record.revision, diagnostic.revision);
  assert.equal(record.git_sha, diagnostic.gitSha);
  assert.equal(record.status, "failed");
  assert.equal(record.terminal_subtype, "prompt_persist");
  assert.ok(record.elapsed_ms >= 100);
  assert.equal("user_id" in record, false);
  assert.equal("chat_id" in record, false);

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await assert.rejects(
      runAssistantStartupStep(diagnostic, "prompt_persist", async () => {
        throw new Error("Confidential client prompt");
      }),
      /Confidential client prompt/,
    );
    assert.equal(await runAssistantStartupStep(diagnostic, "placeholder_create", async () => "saved"), "saved");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("Confidential client prompt"), false);
    assert.equal(JSON.parse(lines[0]).terminal_subtype, "prompt_persist");
  } finally {
    console.log = originalLog;
  }
});

test("unconfirmed run creation emits a content-free structured diagnostic", () => {
  const diagnostic = createAssistantRunStartDiagnostic({
    requestedStreamId: "019f7170-9f04-72c1-8364-45f504ca2153",
    route: "chat",
    startedAt: Date.now() - 10,
  });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    logAssistantRunStartUncertain(diagnostic, "run_create");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.deepEqual({ event: record.event, run_id: record.run_id,
      trace_id: record.trace_id, revision: record.revision,
      git_sha: record.git_sha, status: record.status,
      terminal_subtype: record.terminal_subtype }, {
      event: "assistant_run_start_uncertain",
      run_id: diagnostic.streamRequestId,
      trace_id: diagnostic.traceId,
      revision: diagnostic.revision,
      git_sha: diagnostic.gitSha,
      status: "unknown",
      terminal_subtype: "run_create",
    });
    assert.equal(lines[0].includes("Confidential prompt"), false);
  } finally {
    console.log = originalLog;
  }
});

test("active slow run emits one content-free signal at ten minutes", () => {
  const stream = registerAssistantStream({
    userId: "owner",
    chatId: "confidential-chat",
    route: "project_chat",
    controller: new AbortController(),
    startedAt: Date.now() - 600_000,
  });
  const state = { logged: false };
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    assert.equal(logAssistantRunSlowOnce(stream, state, "in_progress", stream.startedAt + 599_999), false);
    assert.equal(logAssistantRunSlowOnce(stream, state, "cancel_requested", stream.startedAt + 600_001), true);
    assert.equal(logAssistantRunSlowOnce(stream, state, "in_progress", stream.startedAt + 600_000), false);
    assert.equal(logAssistantRunSlowOnce(stream, state, "in_progress", stream.startedAt + 900_000), false);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.event, "assistant_run_slow");
    assert.equal(record.run_id, stream.streamRequestId);
    assert.equal(record.trace_id, stream.traceId);
    assert.equal(record.revision, stream.revision);
    assert.equal(record.git_sha, stream.gitSha);
    assert.equal(record.status, "cancel_requested");
    assert.equal(record.elapsed_ms, 600_001);
    assert.equal(lines[0].includes("confidential-chat"), false);
  } finally {
    console.log = originalLog;
    unregisterAssistantStream(stream);
  }
});

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
  assert.equal(
    assistantRuntimeGitSha({ GIT_COMMIT_SHA: "cc8cef6c7e9e226d71b4f287c5d0d0ce3f2abb06" }),
    "cc8cef6c7e9e226d71b4f287c5d0d0ce3f2abb06",
  );
  assert.equal(assistantRuntimeGitSha({ GIT_COMMIT_SHA: "not-a-sha" }), null);
});

test("terminal diagnostics use allowlisted content-free fields", () => {
  const stream = registerAssistantStream({
    requestedStreamId: "019f7170-9f04-72c1-8364-45f504ca2153",
    userId: "owner",
    chatId: "confidential-chat",
    route: "chat",
    controller: new AbortController(),
    startedAt: Date.now() - 250,
  });
  try {
    const record = assistantRunTerminalRecord(stream, {
      status: "failed",
      terminalSubtype: "tool_iteration_limit",
      provider: "openai",
      model: "gpt-6-sol",
      errorCode: "tool_iteration_limit",
      providerRequestId: "req_123",
      providerResponseId: "resp_456",
      providerStatus: "failed",
      outputChars: 0,
      hasUsableResult: false,
    });
    assert.equal(record.event, "assistant_run_terminal");
    assert.equal(record.run_id, stream.streamRequestId);
    assert.equal(record.trace_id, stream.traceId);
    assert.equal(record.revision, stream.revision);
    assert.equal(record.git_sha, stream.gitSha);
    assert.equal(record.worker_revision, assistantRuntimeRevision());
    assert.equal(record.worker_git_sha, assistantRuntimeGitSha());
    assert.equal(record.status, "failed");
    assert.equal(record.terminal_subtype, "tool_iteration_limit");
    assert.equal(record.error_code, "tool_iteration_limit");
    assert.equal(record.provider_request_id, "req_123");
    assert.equal(record.provider_response_id, "resp_456");
    assert.equal(record.provider_status, "failed");
    assert.equal(record.output_chars, 0);
    assert.equal(record.usable_result, false);
    assert.ok(record.elapsed_ms >= 250);
    assert.equal("user_id" in record, false);
    assert.equal("chat_id" in record, false);
    assert.equal("prompt" in record, false);
  } finally {
    unregisterAssistantStream(stream);
  }
});

test("terminal logger emits one JSON line and rejects free-form diagnostic text", () => {
  const stream = registerAssistantStream({
    userId: "owner",
    chatId: "confidential-chat",
    route: "project_chat",
    controller: new AbortController(),
  });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    logAssistantRunTerminal(stream, {
      status: "failed",
      terminalSubtype: "Private client matter text",
      errorCode: "Client secret facts",
      provider: "openai",
      model: "confidential model text",
      providerRequestId: "request with spaces",
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("Private client matter text"), false);
    assert.equal(lines[0].includes("Client secret facts"), false);
    assert.equal(lines[0].includes("confidential-chat"), false);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.terminal_subtype, "unknown");
    assert.equal(parsed.error_code, "unknown");
    assert.equal(parsed.model, "unknown");
    assert.equal(parsed.provider_request_id, null);
  } finally {
    console.log = originalLog;
    unregisterAssistantStream(stream);
  }
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
        gitSha: stream.gitSha,
        retryable: true,
        continuing: true,
      },
    );
  } finally {
    unregisterAssistantStream(stream);
  }
});
