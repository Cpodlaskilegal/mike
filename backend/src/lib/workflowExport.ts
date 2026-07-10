import JSZip from "jszip";

export type WorkflowExportSource = {
  id: string;
  title?: unknown;
  type?: unknown;
  prompt_md?: unknown;
  columns_config?: unknown;
  language?: unknown;
  practice?: unknown;
  jurisdictions?: unknown;
  is_system?: unknown;
  created_at?: unknown;
};

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() || fallback : fallback;
}

function workflowType(value: unknown): "assistant" | "tabular" {
  return value === "tabular" ? "tabular" : "assistant";
}

function asColumns(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function workflowExportFilename(workflow: WorkflowExportSource) {
  const stem = text(workflow.title, "workflow")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "workflow";
  return `docket-workflow-${stem}.zip`;
}

export function workflowExportManifest(workflow: WorkflowExportSource) {
  const type = workflowType(workflow.type);
  return {
    format: "docket-workflow/v1",
    exported_at: new Date().toISOString(),
    workflow: {
      id: workflow.id,
      title: text(workflow.title, "Untitled workflow"),
      type,
      language: text(workflow.language, "English"),
      practice: text(workflow.practice, "General Transactions"),
      jurisdictions: Array.isArray(workflow.jurisdictions)
        ? workflow.jurisdictions.filter((value): value is string => typeof value === "string")
        : ["General"],
      is_system: Boolean(workflow.is_system),
      created_at: typeof workflow.created_at === "string" ? workflow.created_at : null,
    },
    contents: {
      skill_md: Boolean(text(workflow.prompt_md)),
      table_config: type === "tabular" && asColumns(workflow.columns_config).length > 0,
    },
  };
}

export async function buildWorkflowZip(workflow: WorkflowExportSource) {
  const zip = new JSZip();
  const manifest = workflowExportManifest(workflow);
  zip.file("workflow.json", JSON.stringify(manifest, null, 2));
  zip.file(
    "README.md",
    [
      `# ${manifest.workflow.title}`,
      "",
      "This is a Docket workflow export.",
      "",
      "- `workflow.json` contains portable metadata.",
      "- `SKILL.md` contains the assistant instructions when the workflow has them.",
      "- `table-config.json` contains tabular columns when applicable.",
      "",
      "This archive contains no user credentials, documents, chat history, or connector tokens.",
    ].join("\n"),
  );
  const prompt = text(workflow.prompt_md);
  if (prompt) zip.file("SKILL.md", prompt.endsWith("\n") ? prompt : `${prompt}\n`);
  if (manifest.contents.table_config) {
    zip.file("table-config.json", JSON.stringify(asColumns(workflow.columns_config), null, 2));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
