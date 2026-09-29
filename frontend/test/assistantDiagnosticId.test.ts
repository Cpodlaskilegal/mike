import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AssistantDiagnosticId } from "../src/app/components/assistant/AssistantDiagnosticId";

test("startup diagnostic displays a copyable Request ID without calling it a durable run", () => {
  const html = renderToStaticMarkup(createElement(AssistantDiagnosticId, {
    id: "request-123", kind: "request",
  }));
  assert.match(html, /Request ID:/);
  assert.match(html, /request-123/);
  assert.match(html, /Copy request ID/);
  assert.doesNotMatch(html, /Run ID:/);
});
