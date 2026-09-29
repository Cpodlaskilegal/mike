import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildContinuationDraft,
  isConfirmedPreflightFailure,
  parseAssistantHttpRejection,
  preflightDraftFromResult,
  rollbackOptimisticPreflight,
  withDisplayedDocument,
  findRecoveryContext,
  findRecoverySource,
  shouldOfferContinue,
  shouldRestoreSubmittedDraft,
  shouldApplyRecoveryDraft,
} from "../src/app/lib/assistantRecovery";
import { hydrateChatMessages } from "../src/app/lib/assistantRunHydration";

const source = {
  role: "user" as const,
  content: "Summarize the attached order and update the case note.",
  files: [{ filename: "Order.pdf", document_id: "doc-1" }],
  workflow: { id: "case-summary", title: "Case summary" },
};

test("a failed response can continue from its original request after hydration", () => {
  const messages = hydrateChatMessages({ messages: [
    { id: "user-1", ...source },
    {
      id: "assistant-1", role: "assistant",
      content: [{ type: "content", text: "The order addresses two issues." }],
      assistant_run: {
        run_id: "run-1", status: "failed", error_code: "tool_iteration_limit",
        message: "The tool limit was reached.", retryable: true,
        trace_id: "trace-1", revision: "rev-1",
      },
    },
  ] });
  const prior = findRecoverySource(messages, 1);
  assert.deepEqual(prior, source);
  assert.equal(shouldOfferContinue(messages[1]), true);

  const draft = buildContinuationDraft(prior!);
  assert.match(draft.content, /Summarize the attached order/);
  assert.match(draft.content, /do not repeat completed work/i);
  assert.deepEqual(draft.files, source.files);
  assert.deepEqual(draft.workflow, source.workflow);
  assert.notEqual(draft.files, source.files);
});

test("Ask Inputs continuation keeps initiating task and labels the latest answer accurately", () => {
  const messages = hydrateChatMessages({ messages: [
    { id: "user-1", role: "user", content: "Draft a case summary.", files: [{ filename: "Brief.pdf", document_id: "doc-1" }], workflow: { id: "case-summary", title: "Case summary" } },
    { id: "assistant-1", role: "assistant", content: [{ type: "ask_inputs", request_id: "ask-1", items: [] }] },
    { id: "user-2", role: "user", content: "Responses to Docket's questions:\n1. Deadline?\nFriday", files: [{ filename: "Order.pdf", document_id: "doc-2" }] },
    { id: "assistant-2", role: "assistant", content: null, assistant_run: {
      run_id: "run-2", status: "failed", error_code: "empty_response",
      message: "No usable result.", retryable: true, trace_id: "trace-2", revision: "rev-1",
    } },
  ] });
  const context = findRecoveryContext(messages, 3);
  assert.ok(context);
  assert.equal(context.isAskInputsResponse, true);
  assert.equal(context.askInputsRequestId, "ask-1");
  assert.equal(context.initiatingUser?.content, "Draft a case summary.");
  const draft = buildContinuationDraft(context);
  assert.match(draft.content, /Initiating request:\nDraft a case summary/);
  assert.match(draft.content, /Latest response to Docket's questions:/);
  assert.doesNotMatch(draft.content, /Original request:\nResponses to Docket/);
  assert.deepEqual(draft.files?.map((file) => file.document_id), ["doc-1", "doc-2"]);
  assert.deepEqual(draft.workflow, { id: "case-summary", title: "Case summary" });
});

test("cancelled, pending, and nonretryable runs cannot be continued", () => {
  assert.equal(
    shouldOfferContinue({ role: "assistant", content: "", pending: true }),
    false,
  );
  assert.equal(
    shouldOfferContinue({
      role: "assistant", content: "", error: "Stopped",
      assistantRun: { streamRequestId: "run-2", status: "cancelled", retryable: false },
    }),
    false,
  );
  assert.equal(
    shouldOfferContinue({
      role: "assistant", content: "", error: "Rejected",
      assistantRun: { streamRequestId: "run-3", status: "failed", retryable: false },
    }),
    false,
  );
});

test("preflight failure restores the submitted draft only if the user has not begun another", () => {
  assert.equal(shouldRestoreSubmittedDraft({ kind: "preflight_failed" }, 7, 7), true);
  assert.equal(shouldRestoreSubmittedDraft({ kind: "preflight_failed" }, 7, 8), false);
  assert.equal(shouldRestoreSubmittedDraft({ kind: "sent", chatId: null }, 7, 7), false);
  assert.equal(shouldRestoreSubmittedDraft({ kind: "sent", chatId: "chat-1" }, 7, 7), false);
});

test("a received non-SSE HTTP rejection restores the draft, while ambiguous transport and terminal failures do not", () => {
  assert.equal(isConfirmedPreflightFailure({ authRequired: false, httpRejectedBeforeStream: true, streamStarted: false }), true);
  assert.equal(isConfirmedPreflightFailure({ authRequired: true, httpRejectedBeforeStream: false, streamStarted: false }), true);
  assert.equal(isConfirmedPreflightFailure({ authRequired: false, httpRejectedBeforeStream: false, streamStarted: false }), false);
  assert.equal(isConfirmedPreflightFailure({ authRequired: false, httpRejectedBeforeStream: true, streamStarted: true }), false);
  assert.equal(isConfirmedPreflightFailure({ authRequired: false, httpRejectedBeforeStream: true, streamStarted: false, messageSaved: true }), false);
});

test("typed startup failure distinguishes saved prompts from unsaved drafts", () => {
  assert.deepEqual(parseAssistantHttpRejection(JSON.stringify({
    detail: "Failed to create the assistant response placeholder",
    message_saved: true, chat_id: "chat-saved", request_id: "request-saved",
  })), {
    messageSaved: true, chatId: "chat-saved", requestId: "request-saved",
    runStatus: null, retryable: null,
  });
  assert.deepEqual(parseAssistantHttpRejection(JSON.stringify({
    detail: "Failed to save submitted message",
    message_saved: false, chat_id: "chat-unsaved", request_id: "request-unsaved",
  })), {
    messageSaved: false, chatId: "chat-unsaved", requestId: "request-unsaved",
    runStatus: null, retryable: null,
  });
  assert.deepEqual(parseAssistantHttpRejection("Service unavailable"), {
    messageSaved: null, chatId: null, requestId: null, runStatus: null, retryable: null,
  });
});

test("unconfirmed saved startup outcome keeps its Request ID but blocks retry", () => {
  const unknown = parseAssistantHttpRejection(JSON.stringify({
    detail: "The assistant start status could not be confirmed",
    message_saved: true, chat_id: "chat-1", request_id: "request-1",
    run_status: "unknown", retryable: false,
  }));
  assert.deepEqual(unknown, {
    messageSaved: true, chatId: "chat-1", requestId: "request-1",
    runStatus: "unknown", retryable: false,
  });
  assert.equal(isConfirmedPreflightFailure({
    authRequired: false, httpRejectedBeforeStream: true, streamStarted: false,
    messageSaved: unknown.messageSaved, runStatus: unknown.runStatus,
  }), false);
  assert.equal(isConfirmedPreflightFailure({
    authRequired: false, httpRejectedBeforeStream: true, streamStarted: false,
    messageSaved: false, runStatus: "unknown",
  }), false);
  assert.equal(isConfirmedPreflightFailure({
    authRequired: false, httpRejectedBeforeStream: true, streamStarted: false,
    messageSaved: false, retryable: false,
  }), false);
});

test("saved startup failure retains its first turn or existing chat without automatic replay", () => {
  const saved = parseAssistantHttpRejection(JSON.stringify({
    detail: "Failed to start the extended assistant response",
    message_saved: true, chat_id: "chat-saved", request_id: "request-saved",
  }));
  const isPreflight = isConfirmedPreflightFailure({
    authRequired: false, httpRejectedBeforeStream: true, streamStarted: false,
    messageSaved: saved.messageSaved,
  });
  assert.equal(isPreflight, false);
  assert.equal(preflightDraftFromResult({ kind: "sent", chatId: saved.chatId }, source), null);
  const existing = [
    { role: "user" as const, content: "Earlier question" },
    { role: "assistant" as const, content: "Earlier answer" },
  ];
  const savedTurns = [...existing, source, { role: "assistant" as const, content: "", error: "Start failed" }];
  assert.deepEqual(savedTurns.slice(0, 2), existing);
  assert.equal(savedTurns.filter((message) => message.role === "user").length, 2);
});

test("first-turn preflight failure carries its draft into the replacement chat view", () => {
  assert.deepEqual(preflightDraftFromResult({ kind: "preflight_failed", message: "Failed to save submitted message" }, source), {
    ...source, error: "Failed to save submitted message",
  });
  assert.equal(preflightDraftFromResult({ kind: "sent", chatId: null }, source), null);
});

test("preflight rollback removes only the unsent optimistic pair in new, existing, and project chats", () => {
  const assistant = { role: "assistant" as const, content: "" };
  const prior = [
    { role: "user" as const, content: "Prior question" },
    { role: "assistant" as const, content: "Prior answer" },
  ];
  assert.deepEqual(rollbackOptimisticPreflight([source, assistant], source), []);
  assert.deepEqual(rollbackOptimisticPreflight([...prior, source, assistant], source), prior);
  const projectSubmitted = withDisplayedDocument(source, { filename: "Open.docx", documentId: "doc-open" });
  assert.deepEqual(rollbackOptimisticPreflight([projectSubmitted, assistant], projectSubmitted), []);
  const changed = [...prior, source, assistant];
  assert.equal(rollbackOptimisticPreflight(changed, prior[0]), changed);
  const priorUser = { ...source };
  const replacedUser = { ...source };
  assert.deepEqual(
    rollbackOptimisticPreflight([replacedUser, assistant], replacedUser, priorUser),
    [priorUser],
  );
});

test("late preflight handoff preserves a draft the user edited while waiting", () => {
  assert.equal(shouldApplyRecoveryDraft(0), true);
  assert.equal(shouldApplyRecoveryDraft(1), false);
  assert.equal(shouldApplyRecoveryDraft(3), false);
});

test("a project displayed document is persisted with the submitted request once", () => {
  const enriched = withDisplayedDocument(source, {
    filename: "Current draft.docx", documentId: "doc-open",
  });
  assert.equal(enriched.content, source.content);
  assert.deepEqual(enriched.workflow, source.workflow);
  assert.deepEqual(enriched.files?.map((file) => file.document_id), ["doc-1", "doc-open"]);
  assert.deepEqual(withDisplayedDocument(enriched, {
    filename: "Current draft.docx", documentId: "doc-open",
  }).files, enriched.files);
  assert.equal(withDisplayedDocument(source, null), source);
  assert.deepEqual(
    preflightDraftFromResult({ kind: "preflight_failed", message: "Start failed", draft: enriched }, source)?.files,
    enriched.files,
  );
});

test("preflight draft handoff reaches mounted first-turn and project composers", () => {
  const initialPage = readFileSync(new URL("../src/app/(pages)/assistant/page.tsx", import.meta.url), "utf8");
  const chatPage = readFileSync(new URL("../src/app/(pages)/assistant/chat/[id]/page.tsx", import.meta.url), "utf8");
  const projectPage = readFileSync(new URL("../src/app/(pages)/projects/[id]/assistant/chat/[chatId]/page.tsx", import.meta.url), "utf8");
  const chatView = readFileSync(new URL("../src/app/components/assistant/ChatView.tsx", import.meta.url), "utf8");
  const initialView = readFileSync(new URL("../src/app/components/assistant/InitialView.tsx", import.meta.url), "utf8");
  const askInputsPopup = readFileSync(new URL("../src/app/components/assistant/AskInputsPopup.tsx", import.meta.url), "utf8");
  const chatInput = readFileSync(new URL("../src/app/components/assistant/ChatInput.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/app/hooks/useAssistantChat.ts", import.meta.url), "utf8");
  assert.match(initialPage, /preflightDraftFromResult\(result, message\)/);
  assert.match(initialPage, /recoveryDraft=\{preflightDraft\}/);
  assert.match(initialView, /recoveryDraft=\{recoveryDraft\}/);
  assert.match(chatPage, /preflightDraftFromResult\(result, launchMessage\)/);
  assert.match(chatPage, /recoveryDraft=\{preflightDraft\}/);
  assert.match(projectPage, /preflightDraftFromResult\(result, launchMessage\)/);
  assert.match(projectPage, /recoveryDraft=\{preflightDraft\}/);
  assert.match(projectPage, /const launchMessage = withDisplayedDocument\(/);
  assert.match(chatView, /recoveryDraft=\{recoveryDraft\}/);
  for (const view of [chatView, projectPage]) {
    assert.match(view, /requestId=\{msg\.startFailureRequestId\}/);
    assert.match(view, /statusUnconfirmed=\{msg\.startFailureUnconfirmed\}/);
    assert.match(view, /showRestore=\{!!msg\.startFailureRequestId/);
    assert.match(view, /onRetryInputs=\{/);
  }
  assert.match(askInputsPopup, /id=\{askInputsElementId\(event\.request_id\)\}/);
  assert.match(chatInput, /shouldApplyRecoveryDraft\(draftEpochRef\.current\)/);
  assert.match(chatInput, /setDeferredRecoveryDraft\(recoveryDraft\)/);
  assert.match(chatInput, /Restore failed request/);
  assert.match(chatInput, /result\.draft \?\? submitted/);
  assert.match(hook, /withDisplayedDocument\(message, opts\?\.displayedDoc\)/);
  assert.match(hook, /\[\.\.\.messages\.slice\(0, -1\), message\]/);
  assert.match(hook, /parseAssistantHttpRejection\(errText\)/);
  assert.match(hook, /rollbackOptimisticPreflight\([\s\S]*?isMessageAlreadyAdded \? lastMessage : undefined/);
  assert.match(hook, /keepStartupChat && recoverableChatId/);
  assert.match(hook, /startFailureRequestId: httpRejectedBeforeStream/);
  assert.match(hook, /startFailureUnconfirmed:/);
  assert.match(hook, /requestId: httpStartFailure\?\.requestId \?\? undefined/);
});
