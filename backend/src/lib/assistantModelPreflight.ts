import type { ChatMessage } from "./chatTools";
import type { createServerSupabase } from "./supabase";
import type { UserApiKeys } from "./llm/types";
import { resolveAssistantModelSelection } from "./assistantModelPolicy";

/** Resolve media from authorized database rows, never client filenames or MIME claims. */
export async function preflightAssistantModel(input: {
  body: Record<string, unknown>;
  messages: readonly ChatMessage[];
  attachedDocumentIds?: readonly string[];
  projectId: string | null;
  userId: string;
  db: ReturnType<typeof createServerSupabase>;
  apiKeys: UserApiKeys;
  workflowStore: Map<string, { title: string; prompt_md: string }>;
}) {
  const latestUser = [...input.messages].reverse().find((message) => message.role === "user");
  const ids = [...new Set([
    ...(latestUser?.files ?? []).map((file) => file.document_id).filter((id): id is string => typeof id === "string"),
    ...(input.attachedDocumentIds ?? []),
  ])];
  const fileTypes: string[] = [];
  if (ids.length) {
    const { data, error } = await input.db.from("documents")
      .select("id, user_id, project_id, file_type, status").in("id", ids);
    if (error) throw new Error("Unable to verify attachments for model selection");
    for (const id of ids) {
      const doc = (data ?? []).find((row) => row.id === id);
      const allowed = input.projectId
        ? doc?.project_id === input.projectId
        : doc?.user_id === input.userId;
      if (!doc || !allowed || doc.status !== "ready") {
        return { ok: false as const, detail: "An attached document is unavailable or outside this chat's scope. Reattach a ready document you can access." };
      }
      if (typeof doc.file_type === "string") fileTypes.push(doc.file_type);
    }
  }
  const workflow = latestUser?.workflow;
  const workflowTitle = workflow ? input.workflowStore.get(workflow.id)?.title : undefined;
  if (workflow && !workflowTitle) {
    return { ok: false as const, detail: "The selected workflow is unavailable. Select a workflow you can access." };
  }
  return resolveAssistantModelSelection({
    body: input.body, apiKeys: input.apiKeys, fileTypes, workflowTitle,
  });
}
