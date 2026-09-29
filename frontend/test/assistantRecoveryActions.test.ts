import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AssistantRecoveryActions } from "../src/app/components/assistant/AssistantRecoveryActions";

test("failed run offers reviewable continuation and a copyable support ID", () => {
  const html = renderToStaticMarkup(createElement(AssistantRecoveryActions, {
    runId: "run-123",
    errorCode: "tool_iteration_limit",
    canContinue: true,
    showRestore: false,
    onContinue: () => {},
    onRestore: () => {},
  }));
  assert.match(html, /Continue in a new message/);
  assert.doesNotMatch(html, /Restore original request/);
  assert.match(html, /run-123/);
  assert.match(html, /Copy run ID/);
  assert.match(html, /tool_iteration_limit/);
  assert.doesNotMatch(html, /disabled=""/);
});

test("nonretryable run cannot initiate continuation", () => {
  const html = renderToStaticMarkup(createElement(AssistantRecoveryActions, {
    runId: "run-456",
    errorCode: "provider_rejected",
    canContinue: false,
    onContinue: () => {},
    onRestore: () => {},
  }));
  assert.match(html, /Continue in a new message[^<]*<\/button>/);
  assert.match(html, /disabled=""/);
});

test("Ask Inputs recovery does not offer a misleading original-request replay", () => {
  const html = renderToStaticMarkup(createElement(AssistantRecoveryActions, {
    runId: "run-ask",
    canContinue: true,
    showRestore: false,
    onContinue: () => {},
    onRestore: () => {},
  }));
  assert.match(html, /Continue in a new message/);
  assert.doesNotMatch(html, /Restore original request/);
});

test("saved startup failure offers reviewable actions with a Request ID", () => {
  const html = renderToStaticMarkup(createElement(AssistantRecoveryActions, {
    requestId: "request-start",
    startupSaved: true,
    canContinue: true,
    onContinue: () => {},
    onRestore: () => {},
  }));
  assert.match(html, /Request ID:/);
  assert.match(html, /Copy request ID/);
  assert.match(html, /request-start/);
  assert.match(html, /Continue in a new message/);
  assert.match(html, /Restore original request/);
  assert.match(html, /saved.*response did not start/i);
  assert.doesNotMatch(html, /Run ID:/);
});

test("saved Ask Inputs failure points back to the structured questions", () => {
  const html = renderToStaticMarkup(createElement(AssistantRecoveryActions, {
    requestId: "request-ask",
    startupSaved: true,
    canContinue: false,
    showRestore: false,
    onRetryInputs: () => {},
    onContinue: () => {},
    onRestore: () => {},
  }));
  assert.match(html, /Return to Docket&#x27;s questions/);
  assert.doesNotMatch(html, /Continue in a new message/);
  assert.doesNotMatch(html, /Restore original request/);
});

test("unconfirmed startup outcome shows Request ID without any retry action", () => {
  const html = renderToStaticMarkup(createElement(AssistantRecoveryActions, {
    requestId: "request-unknown",
    startupSaved: true,
    statusUnconfirmed: true,
    canContinue: true,
    onRetryInputs: () => {},
    onContinue: () => {},
    onRestore: () => {},
  }));
  assert.match(html, /Request ID:/);
  assert.match(html, /request-unknown/);
  assert.match(html, /status is unconfirmed/i);
  assert.match(html, /Do not resubmit/i);
  assert.doesNotMatch(html, /Continue in a new message/);
  assert.doesNotMatch(html, /Restore original request/);
  assert.doesNotMatch(html, /Return to Docket/);
});
