import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import {
  buildWorkflowZip,
  workflowExportFilename,
  workflowExportManifest,
} from "../src/lib/workflowExport";

const workflow = {
  id: "workflow-1",
  title: "Asset Purchase / Due Diligence",
  type: "tabular",
  prompt_md: "Review the agreement carefully.",
  columns_config: [{ index: 0, name: "Parties", prompt: "List the parties." }],
  language: "English",
  practice: "M&A",
  jurisdictions: ["Indiana"],
  is_system: false,
  created_at: "2026-07-09T00:00:00.000Z",
};

test("workflow ZIP export has a portable manifest and no sensitive runtime data", async () => {
  const output = await buildWorkflowZip(workflow);
  const zip = await JSZip.loadAsync(output);
  assert.deepEqual(Object.keys(zip.files).sort(), [
    "README.md",
    "SKILL.md",
    "table-config.json",
    "workflow.json",
  ]);
  const manifest = JSON.parse(await zip.file("workflow.json")!.async("string"));
  assert.equal(manifest.format, "docket-workflow/v1");
  assert.equal(manifest.workflow.title, workflow.title);
  assert.equal(manifest.contents.table_config, true);
  assert.match(await zip.file("README.md")!.async("string"), /no user credentials/i);
});

test("workflow archive filenames are safe and bounded", () => {
  assert.equal(
    workflowExportFilename({ id: "w", title: "../../Client: Matter?" }),
    "docket-workflow-client-matter.zip",
  );
  assert.equal(workflowExportManifest({ id: "w", type: "unknown" }).workflow.type, "assistant");
});
