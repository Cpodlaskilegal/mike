import assert from "node:assert/strict";
import test from "node:test";
import { mergeAttributes } from "@tiptap/react";

test("workflow editor dependencies prevent JSON-origin attributes from replacing the object prototype", () => {
  const imported = JSON.parse('{"__proto__":{"src":"invalid://canary","onerror":"canary"},"class":"document"}');
  const merged = mergeAttributes({ class: "workflow-editor" }, imported);

  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(merged.src, undefined);
  assert.equal(merged.onerror, undefined);
  assert.equal(merged.class, "workflow-editor document");
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "onerror"), false);
});
