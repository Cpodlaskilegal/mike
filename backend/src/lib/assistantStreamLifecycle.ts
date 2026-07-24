import { randomUUID } from "node:crypto";

export type AssistantStreamRoute = "chat" | "project_chat";
export type AssistantStreamAbortCause =
  | "explicit_user_cancel"
  | "client_disconnect"
  | "provider_abort";
export type AssistantStreamTerminalStatus =
  | "completed"
  | "background_pending"
  | "cancellation_pending"
  | "cancelled"
  | "error";

export const PRO_BACKGROUND_CUTOFF_MS = 225_000;

export function shouldContinueAssistantStreamAfterDisconnect(
  reasoningMode: string | null | undefined,
  reasoningEffort?: string | null,
): boolean {
  return reasoningMode === "pro" || reasoningEffort === "max";
}

export type ActiveAssistantStream = {
  streamRequestId: string;
  userId: string;
  chatId: string;
  projectId: string | null;
  route: AssistantStreamRoute;
  traceId: string;
  revision: string;
  startedAt: number;
  controller: AbortController;
  abortCause: AssistantStreamAbortCause | null;
  responseDetached: boolean;
  cancelCleanup: (() => void) | null;
};

const activeStreams = new Map<string, ActiveAssistantStream>();
const STREAM_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAssistantStreamRequestId(value: unknown): value is string {
  return typeof value === "string" && STREAM_REQUEST_ID_RE.test(value);
}

export function assistantRuntimeRevision(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.CONTAINER_APP_REVISION?.trim() ||
    env.AZURE_CONTAINER_APP_REVISION?.trim() ||
    env.GIT_COMMIT_SHA?.trim() ||
    "local"
  );
}

export function registerAssistantStream(input: {
  requestedStreamId?: string | null;
  userId: string;
  chatId: string;
  projectId?: string | null;
  route: AssistantStreamRoute;
  controller: AbortController;
  startedAt?: number;
}): ActiveAssistantStream {
  let streamRequestId = input.requestedStreamId || randomUUID();
  if (activeStreams.has(streamRequestId)) streamRequestId = randomUUID();

  const stream: ActiveAssistantStream = {
    streamRequestId,
    userId: input.userId,
    chatId: input.chatId,
    projectId: input.projectId ?? null,
    route: input.route,
    traceId: randomUUID(),
    revision: assistantRuntimeRevision(),
    startedAt: input.startedAt ?? Date.now(),
    controller: input.controller,
    abortCause: null,
    responseDetached: false,
    cancelCleanup: null,
  };
  activeStreams.set(streamRequestId, stream);
  return stream;
}

export function requestAssistantStreamCancellation(input: {
  streamRequestId: string;
  userId: string;
  route: AssistantStreamRoute;
  projectId?: string | null;
}): ActiveAssistantStream | null {
  const stream = activeStreams.get(input.streamRequestId);
  if (
    !stream ||
    stream.userId !== input.userId ||
    stream.route !== input.route ||
    (input.route === "project_chat" &&
      stream.projectId !== (input.projectId ?? null))
  ) {
    return null;
  }

  stream.abortCause = "explicit_user_cancel";
  stream.cancelCleanup?.();
  if (!stream.controller.signal.aborted) stream.controller.abort();
  return stream;
}

export function unregisterAssistantStream(stream: ActiveAssistantStream): void {
  stream.cancelCleanup = null;
  if (activeStreams.get(stream.streamRequestId) === stream) {
    activeStreams.delete(stream.streamRequestId);
  }
}

export function assistantStreamAbortCause(
  stream: ActiveAssistantStream,
): AssistantStreamAbortCause {
  return stream.abortCause ?? "provider_abort";
}

export function logAssistantStreamLifecycle(
  stream: ActiveAssistantStream,
  event: string,
  details: Record<string, unknown> = {},
): void {
  console.warn(`[${stream.route}/stream] lifecycle`, {
    event,
    cause: stream.abortCause,
    revision: stream.revision,
    trace_id: stream.traceId,
    stream_request_id: stream.streamRequestId,
    chat_id: stream.chatId,
    project_id: stream.projectId,
    elapsed_ms: Date.now() - stream.startedAt,
    ...details,
  });
}

export function assistantStreamTerminalEvent(
  stream: ActiveAssistantStream,
  status: AssistantStreamTerminalStatus,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "stream_terminal",
    status,
    runId: stream.streamRequestId,
    traceId: stream.traceId,
    revision: stream.revision,
    ...details,
  };
}
