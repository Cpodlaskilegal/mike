import type {
  AssistantEvent,
  DocketAssistantRunStatus,
  DocketAssistantRun,
  DocketCitation,
  DocketCitationAnnotation,
  DocketMessage,
  DocketModelSelection,
} from "../components/shared/types";

export interface ServerChatMessage {
  generation?: DocketMessage["generation"] | null;
  id: string;
  role: "user" | "assistant";
  content: string | AssistantEvent[] | null;
  files?: { filename: string; document_id?: string }[] | null;
  workflow?: { id: string; title: string } | null;
  annotations?: DocketCitationAnnotation[] | null;
  citations?: DocketCitation[] | null;
  assistant_run?: ServerAssistantRun | null;
  assistant_start_failure?: ServerAssistantStartFailure | null;
}

export interface ServerAssistantStartFailure {
  request_id: string;
  status: "failed";
  error_code: "placeholder_create" | "run_create" | "startup_interrupted";
  message: string;
  retryable: true;
  trace_id: string;
  revision: string;
  git_sha: string | null;
}

export interface ServerActiveAssistantRun {
  stream_request_id: string;
  assistant_message_id: string;
  project_id: string | null;
  status: DocketAssistantRunStatus;
}

export interface ServerAssistantRun {
  model_selection?: DocketModelSelection;
  project_instruction_version?: number;
  run_id: string;
  status: string;
  error_code: string | null;
  message: string | null;
  retryable: boolean;
  trace_id: string;
  revision: string;
}

const RUN_STATUSES = new Set<DocketAssistantRunStatus>([
  "starting", "queued", "in_progress", "background_pending",
  "cancel_requested", "running_tools", "finalizing", "completed",
  "failed", "cancelled", "interrupted",
]);

/** Convert only safe, user-owned metadata returned by the chat API. */
export function hydrateAssistantRun(
  run: ServerAssistantRun | null | undefined,
): DocketAssistantRun | undefined {
  if (!run || !run.run_id || !RUN_STATUSES.has(run.status as DocketAssistantRunStatus)) {
    return undefined;
  }
  return {
    streamRequestId: run.run_id,
    status: run.status as DocketAssistantRunStatus,
    errorCode: run.error_code,
    safeMessage: run.message,
    retryable: run.retryable,
    traceId: run.trace_id,
    revision: run.revision,
    ...(parseDocketModelSelection(run.model_selection) ? { modelSelection: parseDocketModelSelection(run.model_selection) } : {}),
    ...(Number.isInteger(run.project_instruction_version) ? { projectInstructionVersion: run.project_instruction_version } : {}),
  };
}

export function parseDocketModelSelection(value: unknown): DocketModelSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if ((row.mode !== "auto" && row.mode !== "manual") || typeof row.model !== "string" ||
    typeof row.reason !== "string" || typeof row.policyVersion !== "string" ||
    (row.task !== "drafting" && row.task !== "research" && row.task !== "summary") ||
    (row.budgetPolicy !== "economy" && row.budgetPolicy !== "balanced" && row.budgetPolicy !== "quality")) return undefined;
  return { mode: row.mode, model: row.model, reason: row.reason, policyVersion: row.policyVersion,
    task: row.task, budgetPolicy: row.budgetPolicy };
}

export function terminalAssistantRunError(
  run: DocketAssistantRun | undefined,
): string | undefined {
  if (run?.status !== "failed" && run?.status !== "interrupted") {
    return undefined;
  }
  return run.safeMessage?.trim() ||
    "The assistant stopped before it could finish. Review the partial result and continue in a new message.";
}

const TERMINAL_RUN_STATUSES = new Set<DocketAssistantRunStatus>([
  "completed", "failed", "cancelled", "interrupted",
]);

export function hydrateChatMessages(input: {
  messages: ServerChatMessage[];
  active_run?: ServerActiveAssistantRun | null;
}): DocketMessage[] {
  return input.messages.flatMap((message): DocketMessage[] => {
    if (message.role === "user") {
      const userMessage: DocketMessage = {
        role: "user",
        content: typeof message.content === "string" ? message.content : "",
        files: message.files ?? undefined,
        workflow: message.workflow ?? undefined,
        ...(message.generation ? { generation: message.generation } : {}),
      };
      const failure = message.assistant_start_failure;
      if (failure?.status !== "failed" || !failure.request_id) return [userMessage];
      return [userMessage, {
        role: "assistant",
        content: "",
        error: failure.message?.trim() || "The assistant response could not start.",
        pending: false,
        startFailureRequestId: failure.request_id,
        startFailureErrorCode: failure.error_code,
      }];
    }

    const events = Array.isArray(message.content)
      ? message.content as AssistantEvent[]
      : undefined;
    const startFailure = message.assistant_start_failure;
    if (!message.assistant_run && startFailure?.status === "failed" && startFailure.request_id) {
      return [{
        role: "assistant",
        content: events
          ? events.filter((event) => event.type === "content").map((event) => event.text).join("")
          : typeof message.content === "string" ? message.content : "",
        annotations: message.annotations ?? undefined,
        citations: message.citations ?? undefined,
        events,
        pending: false,
        error: startFailure.message?.trim() || "The assistant response could not start.",
        startFailureRequestId: startFailure.request_id,
        startFailureErrorCode: startFailure.error_code,
      }];
    }
    const durableRun = hydrateAssistantRun(message.assistant_run);
    const activeRun = input.active_run?.assistant_message_id === message.id
      ? input.active_run
      : null;
    // Terminal diagnostics are safe to share. For a pending run, only the
    // owner-filtered active_run grants an actionable run ID and Stop control.
    const assistantRun = durableRun && TERMINAL_RUN_STATUSES.has(durableRun.status)
      ? durableRun
      : activeRun
        ? durableRun?.streamRequestId === activeRun.stream_request_id
          ? {
              ...durableRun,
              status: activeRun.status,
              projectId: activeRun.project_id ?? undefined,
            }
          : {
              streamRequestId: activeRun.stream_request_id,
              projectId: activeRun.project_id ?? undefined,
              status: activeRun.status,
            }
        : undefined;
    const pending = message.content == null &&
      !Boolean(assistantRun && TERMINAL_RUN_STATUSES.has(assistantRun.status));
    const terminalError = terminalAssistantRunError(assistantRun);
    const completedWithoutResult =
      message.content == null && assistantRun?.status === "completed";
    const cancelledWithoutContent =
      message.content == null && assistantRun?.status === "cancelled";

    return [{
      role: "assistant",
      content: events
        ? events.filter((event) => event.type === "content")
            .map((event) => event.text).join("")
        : typeof message.content === "string"
          ? message.content
          : cancelledWithoutContent ? "Cancelled by user" : "",
      annotations: message.annotations ?? undefined,
      citations: message.citations ?? undefined,
      events: events ?? (pending ? [{ type: "thinking" as const, isStreaming: true }] : undefined),
      pending,
      assistantRun,
      ...(durableRun?.modelSelection ? { modelSelection: durableRun.modelSelection } : {}),
      ...(durableRun?.projectInstructionVersion === undefined ? {} : { projectInstructionVersion: durableRun.projectInstructionVersion }),
      error: terminalError ??
        (completedWithoutResult
          ? "The assistant finished without a saved result. Please contact support with the run ID."
          : assistantRun?.status === "cancel_requested"
            ? ASSISTANT_CANCELLATION_PENDING_MESSAGE
            : undefined),
    }];
  });
}

export const ASSISTANT_CANCELLATION_PENDING_MESSAGE =
  "Cancellation requested. Docket is confirming provider shutdown.";

/** Find the newest pending assistant message carrying a durable run ID. */
export function findHydratedAssistantRun(
  messages: DocketMessage[],
): DocketAssistantRun | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === "assistant" &&
      message.pending &&
      message.assistantRun
    ) {
      return message.assistantRun;
    }
  }
  return null;
}

/** Show durable cancellation acknowledgement while provider shutdown finishes. */
export function markAssistantCancellationPending(
  messages: DocketMessage[],
  streamRequestId: string,
): DocketMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === "assistant" &&
      message.pending &&
      message.assistantRun?.streamRequestId === streamRequestId
    ) {
      const updated = [...messages];
      updated[index] = {
        ...message,
        error: ASSISTANT_CANCELLATION_PENDING_MESSAGE,
      };
      return updated;
    }
  }
  return messages;
}
