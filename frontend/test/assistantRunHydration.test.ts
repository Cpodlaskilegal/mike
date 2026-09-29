import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ASSISTANT_CANCELLATION_PENDING_MESSAGE,
  findHydratedAssistantRun,
  hydrateChatMessages,
  hydrateAssistantRun,
  markAssistantCancellationPending,
  terminalAssistantRunError,
} from "../src/app/lib/assistantRunHydration";
import { findRecoveryContext } from "../src/app/lib/assistantRecovery";

test("terminal run metadata keeps exact safe failure and run ID after reload", () => {
  const run = hydrateAssistantRun({
    run_id: "run-failed",
    status: "failed",
    error_code: "tool_iteration_limit",
    message: "The assistant reached its tool limit before finishing.",
    retryable: true,
    trace_id: "trace-1",
    revision: "rev-1",
  });
  assert.deepEqual(run, {
    streamRequestId: "run-failed",
    status: "failed",
    errorCode: "tool_iteration_limit",
    safeMessage: "The assistant reached its tool limit before finishing.",
    retryable: true,
    traceId: "trace-1",
    revision: "rev-1",
  });
  assert.equal(
    terminalAssistantRunError(run),
    "The assistant reached its tool limit before finishing.",
  );
});

test("active and cancelled runs do not become failed messages", () => {
  assert.equal(
    terminalAssistantRunError(hydrateAssistantRun({
      run_id: "run-active", status: "in_progress", error_code: null,
      message: null, retryable: false, trace_id: "trace-2", revision: "rev-1",
    })),
    undefined,
  );
  assert.equal(
    terminalAssistantRunError(hydrateAssistantRun({
      run_id: "run-cancelled", status: "cancelled", error_code: null,
      message: null, retryable: false, trace_id: "trace-3", revision: "rev-1",
    })),
    undefined,
  );
});

test("reloading a failed chat restores partial work, exact reason, retryability, and run ID", () => {
  const messages = hydrateChatMessages({
    messages: [
      { id: "user-1", role: "user", content: "Analyze", files: [{ filename: "Order.pdf", document_id: "doc-1" }] },
      {
        id: "assistant-1", role: "assistant",
        content: [{ type: "content", text: "Partial answer." }],
        assistant_run: {
          run_id: "run-failed", status: "failed", error_code: "tool_iteration_limit",
          message: "The assistant reached its tool limit before finishing.",
          retryable: true, trace_id: "trace-1", revision: "rev-1",
        },
      },
    ],
  });
  assert.equal(messages[0].files?.[0].document_id, "doc-1");
  assert.equal(messages[1].content, "Partial answer.");
  assert.equal(messages[1].pending, false);
  assert.equal(messages[1].error, "The assistant reached its tool limit before finishing.");
  assert.equal(messages[1].assistantRun?.streamRequestId, "run-failed");
  assert.equal(messages[1].assistantRun?.errorCode, "tool_iteration_limit");
  assert.equal(messages[1].assistantRun?.retryable, true);
});

test("terminal null content is recoverable rather than an infinite spinner", () => {
  const [message] = hydrateChatMessages({
    messages: [{
      id: "assistant-1", role: "assistant", content: null,
      assistant_run: {
        run_id: "run-failed", status: "failed", error_code: "empty_response",
        message: "The assistant returned no usable result.", retryable: true,
        trace_id: "trace-1", revision: "rev-1",
      },
    }],
  });
  assert.equal(message.pending, false);
  assert.equal(message.error, "The assistant returned no usable result.");
});

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
  const hook = readFileSync(
    new URL("../src/app/hooks/useAssistantChat.ts", import.meta.url),
    "utf8",
  );

  const hydrated = hydrateChatMessages({
    messages: [{ id: "assistant-1", role: "assistant", content: null }],
    active_run: {
      stream_request_id: "run-active", assistant_message_id: "assistant-1",
      project_id: "project-1", status: "cancel_requested",
    },
  });
  assert.equal(hydrated[0].assistantRun?.streamRequestId, "run-active");
  assert.equal(hydrated[0].assistantRun?.projectId, "project-1");
  assert.equal(hydrated[0].pending, true);
  assert.equal(hydrated[0].error, ASSISTANT_CANCELLATION_PENDING_MESSAGE);
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

test("shared pending messages cannot reconstruct another user's Stop control", () => {
  const pending = {
    id: "assistant-shared", role: "assistant" as const, content: null,
    assistant_run: {
      run_id: "run-other", status: "in_progress", error_code: null,
      message: null, retryable: false, trace_id: "trace-other", revision: "rev-1",
    },
  };
  const shared = hydrateChatMessages({ messages: [pending] });
  assert.equal(shared[0].pending, true);
  assert.equal(shared[0].assistantRun, undefined);
  assert.equal(findHydratedAssistantRun(shared), null);

  const owned = hydrateChatMessages({
    messages: [pending],
    active_run: {
      stream_request_id: "run-other", assistant_message_id: "assistant-shared",
      project_id: "project-1", status: "in_progress",
    },
  });
  assert.equal(owned[0].assistantRun?.streamRequestId, "run-other");
  assert.equal(findHydratedAssistantRun(owned)?.streamRequestId, "run-other");
});

test("reloading a saved startup failure restores its Request ID and recovery after the user turn", () => {
  const messages = hydrateChatMessages({ messages: [{
    id: "user-start", role: "user", content: "Summarize this order",
    files: [{ filename: "Order.pdf", document_id: "doc-1" }],
    workflow: { id: "summary", title: "Summary" },
    assistant_start_failure: {
      request_id: "request-start", status: "failed", error_code: "run_create",
      message: "The assistant response could not start.", retryable: true,
      trace_id: "trace-start", revision: "rev-1", git_sha: null,
    },
  }] });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].files?.[0].document_id, "doc-1");
  assert.deepEqual(messages[0].workflow, { id: "summary", title: "Summary" });
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].error, "The assistant response could not start.");
  assert.equal(messages[1].startFailureRequestId, "request-start");
  assert.equal(messages[1].startFailureErrorCode, "run_create");
  assert.equal(messages[1].pending, false);
  assert.equal(messages[1].assistantRun, undefined);
  assert.equal(findRecoveryContext(messages, 1)?.latestUser.content, "Summarize this order");
});

test("reloaded Ask Inputs startup failure keeps the structured popup retry path", () => {
  const messages = hydrateChatMessages({ messages: [
    { id: "user-initial", role: "user", content: "Draft a summary" },
    { id: "assistant-ask", role: "assistant", content: [{
      type: "ask_inputs", request_id: "ask-1", items: [],
    }] },
    { id: "user-response", role: "user", content: "Responses to Docket's questions:\n1. Friday",
      assistant_start_failure: {
        request_id: "request-response", status: "failed", error_code: "placeholder_create",
        message: "The assistant response could not start.", retryable: true,
        trace_id: "trace-response", revision: "rev-1", git_sha: null,
      },
    },
  ] });
  assert.equal(messages[3].startFailureRequestId, "request-response");
  const context = findRecoveryContext(messages, 3);
  assert.equal(context?.isAskInputsResponse, true);
  assert.equal(context?.askInputsRequestId, "ask-1");
});

test("run-create startup failure uses its existing assistant placeholder without a duplicate bubble", () => {
  const messages = hydrateChatMessages({ messages: [
    { id: "user-1", role: "user", content: "Analyze" },
    { id: "assistant-placeholder", role: "assistant", content: null,
      assistant_start_failure: {
        request_id: "request-run-create", status: "failed", error_code: "run_create",
        message: "The assistant response could not start.", retryable: true,
        trace_id: "trace-run-create", revision: "rev-1", git_sha: null,
      },
    },
  ] });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].pending, false);
  assert.equal(messages[1].error, "The assistant response could not start.");
  assert.equal(messages[1].startFailureRequestId, "request-run-create");
  assert.equal(messages[1].startFailureErrorCode, "run_create");
});
