import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import {
  applyTrackedEdits,
  extractDocxBodyText,
} from "../src/lib/docxTrackedChanges";

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function makeDocx(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function readDocumentXml(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file("word/document.xml")!.async("string");
}

test("preserves numeric-looking DOCX text through an unrelated tracked edit", async () => {
  const bytes = await makeDocx(
    `<w:p>` +
      `<w:r><w:t>12.10</w:t></w:r>` +
      `<w:r><w:t> applies.</w:t></w:r>` +
      `</w:p>`,
  );
  const result = await applyTrackedEdits(bytes, [
    {
      find: "applies",
      replace: "governs",
      context_before: " ",
      context_after: ".",
    },
  ]);

  assert.deepEqual(result.errors, []);
  assert.match(await readDocumentXml(result.bytes), /<w:t>12\.10<\/w:t>/);
  assert.equal(await extractDocxBodyText(result.bytes), "12.10 governs.");
  assert.equal(await extractDocxBodyText(bytes), "12.10 applies.");
});
