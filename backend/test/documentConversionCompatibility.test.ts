import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { normalizeDocxZipPaths } from "../src/lib/convert";

test("conversion input normalization preserves all DOCX entries while repairing Windows separators", async () => {
  const archive = new JSZip();
  const xml = "<w:document>Synthetic document 12.10</w:document>";
  archive.file("word\\document.xml", xml);
  archive.file("word\\media\\sample.png", Buffer.from([1, 2, 3]));
  archive.file("[Content_Types].xml", "<Types/>");
  const original = await archive.generateAsync({ type: "nodebuffer" });
  const normalized = await normalizeDocxZipPaths(original);
  const result = await JSZip.loadAsync(normalized);

  assert.equal(result.file("word\\document.xml"), null);
  assert.equal(await result.file("word/document.xml")?.async("string"), xml);
  assert.deepEqual(await result.file("word/media/sample.png")?.async("nodebuffer"), Buffer.from([1, 2, 3]));
  assert.equal(await result.file("[Content_Types].xml")?.async("string"), "<Types/>");
  assert.deepEqual(await normalizeDocxZipPaths(normalized), normalized);
});

test("non-ZIP conversion input is passed through to the converter unchanged", async () => {
  const original = Buffer.from("synthetic legacy DOC input");
  assert.equal(await normalizeDocxZipPaths(original), original);
});
