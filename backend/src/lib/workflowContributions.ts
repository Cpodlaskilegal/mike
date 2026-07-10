export const WORKFLOW_CONTRIBUTION_CONFIRMATION = "SUBMIT DOCKET WORKFLOW";

export type WorkflowContributionAttribution = "named" | "docket-community";
export type WorkflowContributionStatus =
  | "pending_review"
  | "accepted"
  | "declined"
  | "withdrawn";

export type WorkflowContributionWorkflow = {
  id: string;
  title: string;
  type: "assistant" | "tabular";
  prompt_md: string | null;
  columns_config: unknown;
  language?: string | null;
  practice?: string | null;
  jurisdictions?: string[] | null;
};

export type WorkflowContributionRequest = {
  attribution: WorkflowContributionAttribution;
  publicName: string | null;
};

function nonEmptyText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : null;
}

export function parseWorkflowContributionRequest(
  value: unknown,
): { ok: true; request: WorkflowContributionRequest } | { ok: false; detail: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: "A contribution request body is required." };
  }
  const body = value as Record<string, unknown>;
  if (body.confirmation !== WORKFLOW_CONTRIBUTION_CONFIRMATION) {
    return {
      ok: false,
      detail: `confirmation must equal ${WORKFLOW_CONTRIBUTION_CONFIRMATION}`,
    };
  }
  const attribution: WorkflowContributionAttribution =
    body.attribution === "named" ? "named" : "docket-community";
  const publicName = nonEmptyText(body.public_name, 120);
  if (body.public_name != null && !publicName) {
    return {
      ok: false,
      detail: "public_name must be between 1 and 120 characters when provided.",
    };
  }
  if (attribution === "named" && !publicName) {
    return {
      ok: false,
      detail: "A public_name is required when named attribution is selected.",
    };
  }
  return {
    ok: true,
    request: {
      attribution,
      // A community-attributed submission deliberately does not retain an
      // optional public alias in the public-facing metadata or queue row.
      publicName: attribution === "named" ? publicName : null,
    },
  };
}

export function validateWorkflowForContribution(
  workflow: WorkflowContributionWorkflow,
): string | null {
  if (!nonEmptyText(workflow.title, 160)) {
    return "Workflow title must be between 1 and 160 characters.";
  }
  if (workflow.type === "assistant") {
    return nonEmptyText(workflow.prompt_md, 100_000)
      ? null
      : "Assistant workflows need instructions before they can be submitted.";
  }
  if (!Array.isArray(workflow.columns_config) || workflow.columns_config.length === 0) {
    return "Tabular workflows need at least one column before they can be submitted.";
  }
  if (workflow.columns_config.length > 100) {
    return "Tabular workflows may contain at most 100 columns.";
  }
  const validColumns = workflow.columns_config.every((column) => {
    if (!column || typeof column !== "object" || Array.isArray(column)) return false;
    const record = column as Record<string, unknown>;
    return !!nonEmptyText(record.name, 160) && !!nonEmptyText(record.prompt, 10_000);
  });
  return validColumns
    ? null
    : "Every tabular column needs a name and a prompt within the allowed length.";
}

/**
 * Builds the portable review artifact. Deliberately excludes the Docket user
 * id, Entra email, share list, connector state, and any document/chat data.
 */
export function buildWorkflowContributionSnapshot(
  workflow: WorkflowContributionWorkflow,
  request: WorkflowContributionRequest,
) {
  return {
    format: "docket-workflow-contribution/v1",
    metadata: {
      title: workflow.title.trim(),
      type: workflow.type,
      language: nonEmptyText(workflow.language, 80) ?? "English",
      practice: nonEmptyText(workflow.practice, 120) ?? "General Transactions",
      jurisdictions: Array.isArray(workflow.jurisdictions)
        ? Array.from(
            new Set(
              workflow.jurisdictions
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean)
                .slice(0, 20),
            ),
          )
        : ["General"],
      attribution:
        request.attribution === "named"
          ? { mode: "named", name: request.publicName }
          : { mode: "docket-community", name: null },
    },
    skill_md: workflow.prompt_md ?? null,
    columns_config: workflow.columns_config ?? null,
  };
}

export function isWorkflowContributionReviewStatus(
  value: unknown,
): value is "accepted" | "declined" {
  return value === "accepted" || value === "declined";
}
