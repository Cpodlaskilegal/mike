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
  gitSha: string | null;
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
    env.DEPLOY_VERSION?.trim() ||
    "local"
  );
}

export function assistantRuntimeGitSha(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env.GIT_COMMIT_SHA?.trim() ?? "";
  return /^[0-9a-f]{7,40}$/i.test(value) ? value.toLowerCase() : null;
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
    gitSha: assistantRuntimeGitSha(),
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
    gitSha: stream.gitSha,
    ...details,
  };
}

export type AssistantRunTerminalDetails = {
  status: "completed" | "failed" | "cancelled" | "interrupted";
  terminalSubtype: string;
  provider: "openai" | "claude" | "gemini" | "unknown";
  model: string;
  errorCode?: string | null;
  providerRequestId?: string | null;
  providerResponseId?: string | null;
  providerStatus?: string | null;
  outputChars?: number | null;
  hasUsableResult?: boolean | null;
};

function diagnosticCode(value: string | null | undefined): string | null {
  if (value == null) return null;
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "unknown";
}

function diagnosticProviderId(value: string | null | undefined): string | null {
  if (value == null) return null;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
    ? value
    : null;
}

export type AssistantRunDiagnosticStream = Pick<
  ActiveAssistantStream,
  "streamRequestId" | "traceId" | "revision" | "gitSha" | "route" | "startedAt"
>;

export type AssistantRunStartFailureSubtype =
  | "prompt_persist"
  | "placeholder_create"
  | "run_create";

/** Identifier for a request that fails before it can acquire a durable run row. */
export function createAssistantRunStartDiagnostic(input: {
  requestedStreamId?: string | null;
  route: AssistantStreamRoute;
  startedAt: number;
}): AssistantRunDiagnosticStream {
  return {
    streamRequestId: isAssistantStreamRequestId(input.requestedStreamId)
      ? input.requestedStreamId
      : randomUUID(),
    traceId: randomUUID(),
    revision: assistantRuntimeRevision(),
    gitSha: assistantRuntimeGitSha(),
    route: input.route,
    startedAt: input.startedAt,
  };
}

export function assistantRunStartFailureRecord(
  stream: AssistantRunDiagnosticStream,
  terminalSubtype: AssistantRunStartFailureSubtype,
) {
  return {
    event: "assistant_run_start_failure" as const,
    run_id: stream.streamRequestId,
    trace_id: stream.traceId,
    revision: stream.revision,
    git_sha: stream.gitSha,
    route: stream.route,
    status: "failed" as const,
    terminal_subtype: terminalSubtype,
    elapsed_ms: Math.max(0, Date.now() - stream.startedAt),
  };
}

export function logAssistantRunStartFailure(
  stream: AssistantRunDiagnosticStream,
  terminalSubtype: AssistantRunStartFailureSubtype,
): void {
  console.log(JSON.stringify(assistantRunStartFailureRecord(stream, terminalSubtype)));
}

/** Insert acknowledgement and follow-up lookup both failed to confirm state. */
export function logAssistantRunStartUncertain(
  stream: AssistantRunDiagnosticStream,
  terminalSubtype: "run_create",
): void {
  console.log(JSON.stringify({
    event: "assistant_run_start_uncertain",
    run_id: stream.streamRequestId,
    trace_id: stream.traceId,
    revision: stream.revision,
    git_sha: stream.gitSha,
    route: stream.route,
    status: "unknown",
    terminal_subtype: terminalSubtype,
    elapsed_ms: Math.max(0, Date.now() - stream.startedAt),
  }));
}

/** A startup step is logged exactly once if it fails before a durable run exists. */
export async function runAssistantStartupStep<T>(
  stream: AssistantRunDiagnosticStream,
  terminalSubtype: AssistantRunStartFailureSubtype,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logAssistantRunStartFailure(stream, terminalSubtype);
    throw error;
  }
}

const SLOW_ASSISTANT_RUN_MS = 600_000;
const SLOW_RUN_ACTIVE_STATUSES = new Set([
  "starting", "queued", "in_progress", "background_pending", "running_tools", "finalizing",
  "cancel_requested",
]);

/** The owning route's monitor emits at most one slow signal for its live run. */
export function logAssistantRunSlowOnce(
  stream: AssistantRunDiagnosticStream,
  state: { logged: boolean },
  status: string,
  now = Date.now(),
): boolean {
  const elapsedMs = Math.max(0, now - stream.startedAt);
  if (state.logged || !Number.isFinite(elapsedMs) ||
      elapsedMs < SLOW_ASSISTANT_RUN_MS ||
      !SLOW_RUN_ACTIVE_STATUSES.has(status)) return false;
  state.logged = true;
  console.log(JSON.stringify({
    event: "assistant_run_slow",
    run_id: stream.streamRequestId,
    trace_id: stream.traceId,
    revision: stream.revision,
    git_sha: stream.gitSha,
    route: stream.route,
    status,
    elapsed_ms: elapsedMs,
  }));
  return true;
}

export function assistantRunTerminalRecord(
  stream: AssistantRunDiagnosticStream,
  details: AssistantRunTerminalDetails,
): {
  event: "assistant_run_terminal";
  run_id: string;
  trace_id: string;
  revision: string;
  git_sha: string | null;
  worker_revision: string;
  worker_git_sha: string | null;
  route: AssistantStreamRoute;
  status: AssistantRunTerminalDetails["status"];
  terminal_subtype: string;
  error_code: string | null;
  provider: AssistantRunTerminalDetails["provider"];
  model: string;
  provider_request_id: string | null;
  provider_response_id: string | null;
  provider_status: string | null;
  elapsed_ms: number;
  output_chars: number | null;
  usable_result: boolean | null;
} {
  return {
    event: "assistant_run_terminal",
    run_id: stream.streamRequestId,
    trace_id: stream.traceId,
    revision: stream.revision,
    git_sha: stream.gitSha,
    worker_revision: assistantRuntimeRevision(),
    worker_git_sha: assistantRuntimeGitSha(),
    route: stream.route,
    status: details.status,
    terminal_subtype: diagnosticCode(details.terminalSubtype) ?? "unknown",
    error_code: diagnosticCode(details.errorCode),
    provider: details.provider,
    model: /^[a-z0-9][a-z0-9._-]{0,79}$/.test(details.model)
      ? details.model
      : "unknown",
    provider_request_id: diagnosticProviderId(details.providerRequestId),
    provider_response_id: diagnosticProviderId(details.providerResponseId),
    provider_status: diagnosticCode(details.providerStatus),
    elapsed_ms: Math.max(0, Date.now() - stream.startedAt),
    output_chars:
      Number.isSafeInteger(details.outputChars) &&
      (details.outputChars as number) >= 0
        ? details.outputChars!
        : null,
    usable_result:
      typeof details.hasUsableResult === "boolean"
        ? details.hasUsableResult
        : null,
  };
}

/** One content-free JSON line for Azure console logs and run-ID lookup. */
export function logAssistantRunTerminal(
  stream: AssistantRunDiagnosticStream,
  details: AssistantRunTerminalDetails,
): void {
  console.log(JSON.stringify(assistantRunTerminalRecord(stream, details)));
}
