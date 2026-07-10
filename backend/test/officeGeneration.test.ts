import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import * as XLSX from "xlsx";

import {
  buildPptxPresentation,
  buildXlsxWorkbook,
  generatedOfficeFilename,
} from "../src/lib/officeGeneration";
import { extractPresentationText } from "../src/lib/officeText";

test("generates a readable XLSX workbook with literal model-provided cell text", () => {
  const bytes = buildXlsxWorkbook("Matter Checklist", [
    {
      name: "Checklist",
      columns: ["Item", "Status"],
      rows: [
        ["Conflicts check", "Open"],
        ["=SUM(1,1)", "Must remain a literal string"],
      ],
    },
    {
      name: "Checklist",
      columns: ["Owner"],
      rows: [["Litigation team"]],
    },
  ]);

  const workbook = XLSX.read(bytes, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["Checklist", "Checklist (2)"]);
  const firstSheet = workbook.Sheets.Checklist;
  assert.equal(firstSheet?.A1?.v, "Item");
  assert.equal(firstSheet?.B2?.v, "Open");
  assert.equal(firstSheet?.A3?.v, "=SUM(1,1)");
  assert.equal(
    firstSheet?.A3?.t,
    "s",
    "model output beginning with '=' must not become an Excel formula",
  );
  assert.ok(firstSheet?.["!autofilter"]);
});

test("generates a readable PPTX package whose slide text can be read by Docket", async () => {
  const bytes = await buildPptxPresentation("Matter Update", [
    {
      title: "Procedural posture",
      bullets: ["Answer due July 15", "Discovery has not opened"],
    },
    {
      title: "Next steps",
      bullets: ["Draft discovery plan"],
    },
  ]);

  const archive = await JSZip.loadAsync(bytes);
  for (const requiredPart of [
    "[Content_Types].xml",
    "ppt/presentation.xml",
    "ppt/slides/slide1.xml",
    "ppt/slides/slide2.xml",
    "ppt/slideMasters/slideMaster1.xml",
  ]) {
    assert.ok(archive.file(requiredPart), `missing ${requiredPart}`);
  }

  const extracted = await extractPresentationText(bytes);
  assert.match(extracted, /Procedural posture/);
  assert.match(extracted, /Answer due July 15/);
  assert.match(extracted, /Next steps/);
  assert.match(extracted, /Draft discovery plan/);
});

test("uses server-controlled Office extensions and safe generated filenames", () => {
  assert.equal(
    generatedOfficeFilename('Status / "update"', "xlsx"),
    "Status  update.xlsx",
  );
  assert.equal(generatedOfficeFilename("", "pptx"), "presentation.pptx");
});

test("registers Docket generation tools and routes users to the right output type", async () => {
  process.env.DATABASE_URL ??= "postgresql://docket:test@127.0.0.1:5432/docket";
  const { SYSTEM_PROMPT, TOOLS } = await import("../src/lib/chatTools");
  const names = (TOOLS as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  );

  assert.ok(names.includes("generate_excel"));
  assert.ok(names.includes("generate_ppt"));
  assert.match(SYSTEM_PROMPT, /spreadsheet.*generate_excel/i);
  assert.match(SYSTEM_PROMPT, /presentation.*generate_ppt/i);
  assert.match(SYSTEM_PROMPT, /After calling any generation tool/i);
});
