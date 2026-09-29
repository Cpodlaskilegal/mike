import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantModelSelectionDetails } from "../src/app/components/assistant/AssistantModelSelectionDetails";

test("assistant presentation shows chosen model and routing reason without opening details", () => {
  const output = renderToStaticMarkup(createElement(AssistantModelSelectionDetails, {
    selection: { mode: "auto", model: "gpt-6-sol", reason: "Research under balanced firm budget", policyVersion: "synthetic-policy-v1", task: "research", budgetPolicy: "balanced" },
    instructionVersion: 3,
  }));
  assert.match(output, /Auto: gpt-6-sol/);
  assert.ok(output.indexOf("Research under balanced firm budget") < output.indexOf("<details"));
  assert.match(output, /synthetic-policy-v1/);
  assert.match(output, /Project instructions V3/);
  assert.equal(renderToStaticMarkup(createElement(AssistantModelSelectionDetails, {})), "");
});
