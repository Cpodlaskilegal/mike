import type { DocketMessage, DocketWorkflow } from "../components/shared/types";

/** Keep the selected workflow attached when the catalog opens a new chat. */
export function buildWorkflowLaunchMessage(
    workflow: Pick<DocketWorkflow, "id" | "title">,
    instructions: string,
    files: DocketMessage["files"] = [],
): DocketMessage {
    return {
        role: "user",
        content:
            instructions.trim() ||
            `Apply the ${workflow.title} workflow. Ask me for any information or documents needed to begin.`,
        files: files.length > 0 ? files : undefined,
        // The server resolves the authorized workflow's prompt from this ID.
        workflow: { id: workflow.id, title: workflow.title },
    };
}
