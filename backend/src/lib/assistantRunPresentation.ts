import type { createServerSupabase } from "./supabase";
import { isRetryableChatStreamErrorCode } from "./chatErrors";
import { assistantModelSelectionFromRow, type AssistantModelSelection } from "./assistantModelPolicy";
import { isAssistantStreamRequestId, type AssistantRunDiagnosticStream } from "./assistantStreamLifecycle";

const STARTUP_ANNOTATION_KEY = "docket_assistant_startup";
const STARTUP_PLACEHOLDER_KEY = "docket_assistant_startup_request_id";
const STARTUP_FAILURE_MESSAGE =
  "Docket could not start this response. Review your request and continue.";

export type AssistantStartupFailureCode =
  "placeholder_create" | "run_create" | "startup_interrupted";

export type AssistantStartupFailureMetadata = {
  request_id: string;
  status: "failed";
  error_code: AssistantStartupFailureCode;
  message: string;
  retryable: true;
  trace_id: string;
  revision: string;
  git_sha: string | null;
};

type AssistantRunCreateIdentity = {
  streamRequestId: string;
  assistantMessageId: string;
  chatId: string;
  userId: string;
  traceId: string;
};

/** A timed-out insert may have committed. Only this exact row may proceed. */
export async function classifyAssistantRunCreateError(
  load: () => Promise<(AssistantRunCreateIdentity & { status: string }) | null>,
  expected: AssistantRunCreateIdentity,
): Promise<"committed" | "absent" | "unknown"> {
  try {
    const run = await load();
    // A timed-out insert can still commit after this read. A missing row is
    // therefore unconfirmed, not proof that retrying is safe.
    if (!run) return "unknown";
    if (run.streamRequestId !== expected.streamRequestId ||
        run.assistantMessageId !== expected.assistantMessageId ||
        run.chatId !== expected.chatId ||
        run.userId !== expected.userId ||
        run.traceId !== expected.traceId) return "absent";
    return run.status === "starting" ? "committed" : "unknown";
  } catch {
    return "unknown";
  }
}

function startupPromptAnnotations(
  diagnostic: AssistantRunDiagnosticStream,
  status: "starting" | "failed" = "starting",
  errorCode: AssistantStartupFailureCode = "startup_interrupted",
) {
  return {
    [STARTUP_ANNOTATION_KEY]: {
      request_id: diagnostic.streamRequestId,
      status,
      error_code: errorCode,
      trace_id: diagnostic.traceId,
      revision: diagnostic.revision,
      git_sha: diagnostic.gitSha,
      started_at: new Date(diagnostic.startedAt).toISOString(),
    },
  };
}

export function assistantStartupPlaceholderAnnotations(
  diagnostic: AssistantRunDiagnosticStream,
) {
  return { [STARTUP_PLACEHOLDER_KEY]: diagnostic.streamRequestId };
}

export function assistantStartupFailureResponse(
  diagnostic: AssistantRunDiagnosticStream,
  chatId: string,
  messageSaved: boolean,
  detail: string,
) {
  return {
    detail,
    message_saved: messageSaved,
    chat_id: chatId,
    request_id: diagnostic.streamRequestId,
  };
}

export type AssistantRunMessageMetadata = {
  model_selection?: AssistantModelSelection;
  project_instruction_version?: number;
  run_id: string;
  status: string;
  error_code: string | null;
  message: string | null;
  retryable: boolean;
  trace_id: string;
  revision: string;
  git_sha: string | null;
};

export async function persistAssistantUserMessage(
  db: ReturnType<typeof createServerSupabase>,
  chatId: string,
  message: { content: string | null; files?: unknown; workflow?: unknown; generation?: unknown },
  diagnostic?: AssistantRunDiagnosticStream,
): Promise<string | null> {
  const insert = db.from("chat_messages").insert({
    chat_id: chatId,
    role: "user",
    ...(message.generation ? { generation: message.generation } : {}),
    content: message.content,
    files: message.files ?? null,
    workflow: message.workflow ?? null,
    ...(diagnostic ? { annotations: startupPromptAnnotations(diagnostic) } : {}),
  });
  if (diagnostic) {
    const { data, error } = await insert.select("id").maybeSingle();
    const id = (data as { id?: unknown } | null)?.id;
    if (error || typeof id !== "string") {
      throw new Error("Failed to save submitted message");
    }
    return id;
  }
  const { error } = await insert;
  if (error) throw new Error("Failed to save submitted message");
  return null;
}

async function updateStartupAnnotations(
  db: ReturnType<typeof createServerSupabase>,
  chatId: string,
  messageId: string,
  annotations: unknown,
): Promise<void> {
  const { data, error } = await db.from("chat_messages")
    .update({ annotations })
    .eq("id", messageId)
    .eq("chat_id", chatId)
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error("Failed to update assistant startup marker");
}

export async function recordAssistantStartupFailure(
  db: ReturnType<typeof createServerSupabase>,
  chatId: string,
  userMessageId: string,
  diagnostic: AssistantRunDiagnosticStream,
  errorCode: Exclude<AssistantStartupFailureCode, "startup_interrupted">,
): Promise<void> {
  await updateStartupAnnotations(db, chatId, userMessageId,
    startupPromptAnnotations(diagnostic, "failed", errorCode));
}

export async function clearAssistantStartupAnnotations(
  db: ReturnType<typeof createServerSupabase>,
  chatId: string,
  userMessageId: string | null,
  assistantMessageId?: string,
): Promise<void> {
  if (userMessageId) await updateStartupAnnotations(db, chatId, userMessageId, null);
  if (assistantMessageId) await updateStartupAnnotations(db, chatId, assistantMessageId, null);
}

type StartupMessage = Record<string, unknown> & {
  assistant_start_failure?: AssistantStartupFailureMetadata;
};

function markerFromUser(message: Record<string, unknown>) {
  if (message.role !== "user" || !message.annotations ||
      typeof message.annotations !== "object" || Array.isArray(message.annotations)) return null;
  const raw = (message.annotations as Record<string, unknown>)[STARTUP_ANNOTATION_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (!isAssistantStreamRequestId(marker.request_id) ||
      (marker.status !== "starting" && marker.status !== "failed")) return null;
  return marker;
}

/** Caller authorizes chat access first; only that chat's messages and run IDs are used. */
export async function loadAccessibleAssistantStartupFailures(
  db: ReturnType<typeof createServerSupabase>,
  chatId: string,
  messages: Record<string, unknown>[],
): Promise<StartupMessage[]> {
  const markers = messages.map(markerFromUser);
  const requestIds = [...new Set(markers.filter(Boolean).map((marker) =>
    marker!.request_id as string))];
  const sanitized: StartupMessage[] = messages.map((message) => {
    const annotation = message.annotations;
    const isStartupPlaceholder = message.role === "assistant" && annotation &&
      typeof annotation === "object" && !Array.isArray(annotation) &&
      isAssistantStreamRequestId((annotation as Record<string, unknown>)[STARTUP_PLACEHOLDER_KEY]);
    return markerFromUser(message) || isStartupPlaceholder
      ? { ...message, annotations: null }
      : { ...message };
  });
  if (!requestIds.length) return sanitized;

  const { data: runs, error } = await db.from("assistant_background_runs")
    .select("stream_request_id, assistant_message_id")
    .eq("chat_id", chatId)
    .in("stream_request_id", requestIds);
  if (error) throw new Error("Failed to load assistant startup status");
  const runAssistantByRequest = new Map<string, string>();
  for (const run of runs ?? []) {
    if (typeof run.stream_request_id === "string" &&
        typeof run.assistant_message_id === "string") {
      runAssistantByRequest.set(run.stream_request_id, run.assistant_message_id);
    }
  }
  const assistantByRequest = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.annotations ||
        typeof message.annotations !== "object" || Array.isArray(message.annotations)) continue;
    const requestId = (message.annotations as Record<string, unknown>)[STARTUP_PLACEHOLDER_KEY];
    if (isAssistantStreamRequestId(requestId)) assistantByRequest.set(requestId, index);
  }
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    if (!marker) continue;
    const requestId = marker.request_id as string;
    const assistantIndex = assistantByRequest.get(requestId);
    if (assistantIndex !== undefined &&
        runAssistantByRequest.get(requestId) === messages[assistantIndex].id) continue;
    // A slow or blocked startup may still be alive. Only an explicit failed
    // write authorizes the client to offer a new continuation.
    if (marker.status !== "failed") continue;
    const errorCode =
      (marker.error_code === "placeholder_create" || marker.error_code === "run_create")
        ? marker.error_code
        : "startup_interrupted";
    const targetIndex = assistantIndex ?? index;
    sanitized[targetIndex].assistant_start_failure = {
      request_id: requestId,
      status: "failed",
      error_code: errorCode,
      message: STARTUP_FAILURE_MESSAGE,
      retryable: true,
      trace_id: typeof marker.trace_id === "string" ? marker.trace_id : "",
      revision: typeof marker.revision === "string" ? marker.revision : "unknown",
      git_sha: typeof marker.git_sha === "string" ? marker.git_sha : null,
    };
  }
  return sanitized;
}

/** Caller must first authorize chat access; only returned message IDs are hydrated. */
export async function loadAccessibleAssistantRunMetadata(
  db: ReturnType<typeof createServerSupabase>,
  chatId: string,
  assistantMessageIds: readonly string[],
): Promise<Map<string, AssistantRunMessageMetadata>> {
  const messageIds = [...new Set(assistantMessageIds.filter(Boolean))];
  if (!messageIds.length) return new Map();
  const { data, error } = await db
    .from("assistant_background_runs")
    .select("stream_request_id, assistant_message_id, status, error_code, safe_error_message, trace_id, revision, git_sha, created_at, model, model_selection_mode, model_selection_reason, model_policy_version, model_task, model_budget_policy, project_instruction_version")
    .eq("chat_id", chatId)
    .in("assistant_message_id", messageIds)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Failed to load assistant run metadata");

  const byAssistantMessageId = new Map<string, AssistantRunMessageMetadata>();
  const allowedMessageIds = new Set(messageIds);
  for (const row of data ?? []) {
    const messageId = String(row.assistant_message_id ?? "");
    if (!allowedMessageIds.has(messageId) || byAssistantMessageId.has(messageId)) continue;
    const status = String(row.status ?? "");
    const errorCode = typeof row.error_code === "string" ? row.error_code : null;
    byAssistantMessageId.set(messageId, {
      ...(assistantModelSelectionFromRow(row) ? { model_selection: assistantModelSelectionFromRow(row) } : {}),
      ...(Number.isInteger(row.project_instruction_version) ? { project_instruction_version: row.project_instruction_version as number } : {}),
      run_id: String(row.stream_request_id),
      status,
      error_code: errorCode,
      message: typeof row.safe_error_message === "string" ? row.safe_error_message : null,
      retryable:
        (status === "failed" || status === "interrupted") &&
        isRetryableChatStreamErrorCode(errorCode),
      trace_id: String(row.trace_id),
      revision: String(row.revision),
      git_sha: typeof row.git_sha === "string" ? row.git_sha : null,
    });
  }
  return byAssistantMessageId;
}
