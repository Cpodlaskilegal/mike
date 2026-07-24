import type { createServerSupabase } from "./supabase";
import type { ProviderRunProgress } from "./llm/types";

export const ASSISTANT_BACKGROUND_RUN_STATUSES = [
  "starting",
  "queued",
  "in_progress",
  "background_pending",
  "cancel_requested",
  "running_tools",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AssistantBackgroundRunStatus =
  (typeof ASSISTANT_BACKGROUND_RUN_STATUSES)[number];

export const ASSISTANT_BACKGROUND_RECOVERABLE_STATUSES = [
  "starting",
  "queued",
  "in_progress",
  "running_tools",
  "finalizing",
  "background_pending",
  "cancel_requested",
] satisfies AssistantBackgroundRunStatus[];

export const ASSISTANT_BACKGROUND_PROVIDER_STATUSES = [
  "queued",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "incomplete",
] as const;

export type AssistantBackgroundProviderStatus =
  (typeof ASSISTANT_BACKGROUND_PROVIDER_STATUSES)[number];

export type AssistantBackgroundRun = {
  streamRequestId: string;
  assistantMessageId: string;
  chatId: string;
  userId: string;
  projectId: string | null;
  providerResponseId: string | null;
  providerRequestId: string | null;
  iteration: number;
  status: AssistantBackgroundRunStatus;
  providerStatus: AssistantBackgroundProviderStatus | null;
  model: string;
  reasoningMode: string | null;
  reasoningEffort: string | null;
  traceId: string;
  revision: string;
  finalizationOwner: string | null;
  errorCode: string | null;
  safeErrorMessage: string | null;
  requestStartedAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type CreateAssistantBackgroundRunInput = {
  streamRequestId: string;
  assistantMessageId: string;
  chatId: string;
  userId: string;
  projectId?: string | null;
  providerResponseId?: string | null;
  providerRequestId?: string | null;
  iteration?: number;
  status?: AssistantBackgroundRunStatus;
  providerStatus?: AssistantBackgroundProviderStatus | null;
  model: string;
  reasoningMode?: string | null;
  reasoningEffort?: string | null;
  traceId: string;
  revision: string;
  requestStartedAt?: string | Date;
};

export type UpdateAssistantBackgroundRunInput = {
  providerResponseId?: string | null;
  providerRequestId?: string | null;
  iteration?: number;
  status?: AssistantBackgroundRunStatus;
  providerStatus?: AssistantBackgroundProviderStatus | null;
  model?: string;
  reasoningMode?: string | null;
  reasoningEffort?: string | null;
  traceId?: string;
  revision?: string;
  finalizationOwner?: string | null;
  errorCode?: string | null;
  safeErrorMessage?: string | null;
  completedAt?: string | Date | null;
  updatedAt?: string | Date;
};

type DbError = { message: string };
type DbResult<T> = { data: T | null; error: DbError | null };

type AssistantBackgroundRunQuery = {
  insert(row: Record<string, unknown>): AssistantBackgroundRunQuery;
  update(row: Record<string, unknown>): AssistantBackgroundRunQuery;
  select(columns?: string): AssistantBackgroundRunQuery;
  eq(column: string, value: unknown): AssistantBackgroundRunQuery;
  in(column: string, values: unknown[]): AssistantBackgroundRunQuery;
  order(
    column: string,
    options?: { ascending?: boolean },
  ): AssistantBackgroundRunQuery;
  limit(count: number): AssistantBackgroundRunQuery;
  single(): PromiseLike<DbResult<Record<string, unknown>>>;
  maybeSingle(): PromiseLike<DbResult<Record<string, unknown>>>;
};

/** Minimal surface shared by Docket's PostgreSQL adapter and focused tests. */
export type AssistantBackgroundRunsDb = {
  from(table: string): AssistantBackgroundRunQuery;
};

type Assert<T extends true> = T;
type _ServerDatabaseCompatibility = Assert<
  ReturnType<typeof createServerSupabase> extends AssistantBackgroundRunsDb
    ? true
    : false
>;

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function timestampFromRow(value: unknown, column: string): string;
function timestampFromRow(
  value: unknown,
  column: string,
  nullable: true,
): string | null;
function timestampFromRow(
  value: unknown,
  column: string,
  nullable?: boolean,
): string | null {
  if (value == null && nullable) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Invalid assistant_background_runs.${column}`);
}

function requiredString(value: unknown, column: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Invalid assistant_background_runs.${column}`);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseStatus(value: unknown): AssistantBackgroundRunStatus {
  if (
    typeof value === "string" &&
    (ASSISTANT_BACKGROUND_RUN_STATUSES as readonly string[]).includes(value)
  ) {
    return value as AssistantBackgroundRunStatus;
  }
  throw new Error("Invalid assistant_background_runs.status");
}

function parseProviderStatus(
  value: unknown,
): AssistantBackgroundProviderStatus | null {
  if (value == null) return null;
  if (
    typeof value === "string" &&
    (ASSISTANT_BACKGROUND_PROVIDER_STATUSES as readonly string[]).includes(
      value,
    )
  ) {
    return value as AssistantBackgroundProviderStatus;
  }
  throw new Error("Invalid assistant_background_runs.provider_status");
}

export function normalizeAssistantBackgroundProviderStatus(
  value: unknown,
): AssistantBackgroundProviderStatus | null {
  return parseProviderStatus(value);
}

export function assistantBackgroundProgressUpdate(
  progress: ProviderRunProgress,
  responseDetached: boolean,
): UpdateAssistantBackgroundRunInput {
  const providerStatus = normalizeAssistantBackgroundProviderStatus(
    progress.providerStatus,
  );
  const status: AssistantBackgroundRunStatus =
    progress.phase === "failed"
      ? "finalizing"
      : responseDetached
        ? "background_pending"
        : progress.phase === "completed"
          ? "running_tools"
          : providerStatus === "queued"
            ? "queued"
            : "in_progress";
  return {
    iteration: progress.iteration,
    status,
    providerStatus,
    providerResponseId: progress.providerResponseId,
    providerRequestId: progress.providerRequestId,
  };
}

const ACTIVE_ASSISTANT_BACKGROUND_RUN_STATUSES = [
  "starting",
  "queued",
  "in_progress",
  "background_pending",
  "running_tools",
] satisfies AssistantBackgroundRunStatus[];

function allowedSourceStatuses(
  target: AssistantBackgroundRunStatus | undefined,
): AssistantBackgroundRunStatus[] {
  if (target === "cancelled") return ["cancel_requested"];
  if (target === "completed") return ["finalizing"];
  if (target === "finalizing") {
    return [...ACTIVE_ASSISTANT_BACKGROUND_RUN_STATUSES, "finalizing"];
  }
  if (target === "failed" || target === "interrupted") {
    return [...ACTIVE_ASSISTANT_BACKGROUND_RUN_STATUSES, "finalizing"];
  }
  // All active/progress/failure/completion/interruption updates are compare-
  // and-set from an active state. This keeps terminal states terminal and
  // prevents a durable cancellation request from being overwritten.
  return ACTIVE_ASSISTANT_BACKGROUND_RUN_STATUSES;
}

function parseRun(row: Record<string, unknown>): AssistantBackgroundRun {
  const iteration = Number(row.iteration);
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error("Invalid assistant_background_runs.iteration");
  }
  return {
    streamRequestId: requiredString(row.stream_request_id, "stream_request_id"),
    assistantMessageId: requiredString(
      row.assistant_message_id,
      "assistant_message_id",
    ),
    chatId: requiredString(row.chat_id, "chat_id"),
    userId: requiredString(row.user_id, "user_id"),
    projectId: nullableString(row.project_id),
    providerResponseId: nullableString(row.provider_response_id),
    providerRequestId: nullableString(row.provider_request_id),
    iteration,
    status: parseStatus(row.status),
    providerStatus: parseProviderStatus(row.provider_status),
    model: requiredString(row.model, "model"),
    reasoningMode: nullableString(row.reasoning_mode),
    reasoningEffort: nullableString(row.reasoning_effort),
    traceId: requiredString(row.trace_id, "trace_id"),
    revision: requiredString(row.revision, "revision"),
    finalizationOwner: nullableString(row.finalization_owner),
    errorCode: nullableString(row.error_code),
    safeErrorMessage: nullableString(row.safe_error_message),
    requestStartedAt: timestampFromRow(
      row.request_started_at,
      "request_started_at",
    ),
    createdAt: timestampFromRow(row.created_at, "created_at"),
    updatedAt: timestampFromRow(row.updated_at, "updated_at"),
    completedAt: timestampFromRow(row.completed_at, "completed_at", true),
  };
}

function persistenceError(operation: string, error?: DbError | null): Error {
  return new Error(
    `Failed to ${operation} assistant background run: ${error?.message ?? "no row returned"}`,
  );
}

function assistantBackgroundRunUpdateRow(
  input: UpdateAssistantBackgroundRunInput,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    updated_at: timestamp(input.updatedAt ?? new Date()),
  };
  if (input.providerResponseId !== undefined) {
    row.provider_response_id = input.providerResponseId;
  }
  if (input.providerRequestId !== undefined) {
    row.provider_request_id = input.providerRequestId;
  }
  if (input.iteration !== undefined) row.iteration = input.iteration;
  if (input.status !== undefined) row.status = input.status;
  if (input.providerStatus !== undefined) {
    row.provider_status = input.providerStatus;
  }
  if (input.model !== undefined) row.model = input.model;
  if (input.reasoningMode !== undefined) {
    row.reasoning_mode = input.reasoningMode;
  }
  if (input.reasoningEffort !== undefined) {
    row.reasoning_effort = input.reasoningEffort;
  }
  if (input.traceId !== undefined) row.trace_id = input.traceId;
  if (input.revision !== undefined) row.revision = input.revision;
  if (input.finalizationOwner !== undefined) {
    row.finalization_owner = input.finalizationOwner;
  }
  if (input.errorCode !== undefined) row.error_code = input.errorCode;
  if (input.safeErrorMessage !== undefined) {
    row.safe_error_message = input.safeErrorMessage;
  }
  if (input.completedAt !== undefined) {
    row.completed_at =
      input.completedAt === null ? null : timestamp(input.completedAt);
  }
  return row;
}

export async function createAssistantBackgroundRun(
  db: AssistantBackgroundRunsDb,
  input: CreateAssistantBackgroundRunInput,
): Promise<AssistantBackgroundRun> {
  // Pin the initial lease timestamp to JavaScript millisecond precision. The
  // recovery fence compares this exact value; PostgreSQL's default now() can
  // otherwise retain microseconds that node-postgres cannot round-trip.
  const initialUpdatedAt = new Date().toISOString();
  const row: Record<string, unknown> = {
    stream_request_id: input.streamRequestId,
    assistant_message_id: input.assistantMessageId,
    chat_id: input.chatId,
    user_id: input.userId,
    project_id: input.projectId ?? null,
    provider_response_id: input.providerResponseId ?? null,
    provider_request_id: input.providerRequestId ?? null,
    iteration: input.iteration ?? 1,
    status: input.status ?? "starting",
    provider_status: input.providerStatus ?? null,
    model: input.model,
    reasoning_mode: input.reasoningMode ?? null,
    reasoning_effort: input.reasoningEffort ?? null,
    trace_id: input.traceId,
    revision: input.revision,
    updated_at: initialUpdatedAt,
    ...(input.requestStartedAt === undefined
      ? {}
      : { request_started_at: timestamp(input.requestStartedAt) }),
  };
  const { data, error } = await db
    .from("assistant_background_runs")
    .insert(row)
    .select("*")
    .single();
  if (error || !data) throw persistenceError("create", error);
  return parseRun(data);
}

export async function updateAssistantBackgroundRun(
  db: AssistantBackgroundRunsDb,
  streamRequestId: string,
  input: UpdateAssistantBackgroundRunInput,
): Promise<AssistantBackgroundRun | null> {
  const row = assistantBackgroundRunUpdateRow(input);

  let query = db
    .from("assistant_background_runs")
    .update(row)
    .eq("stream_request_id", streamRequestId);
  query = query.in("status", allowedSourceStatuses(input.status));
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw persistenceError("update", error);
  return data ? parseRun(data) : null;
}

/**
 * Atomically transfers an active run into finalization. A stale-run recovery
 * worker that already owns `finalizing` cannot be displaced by the original
 * request handler resuming on another replica.
 */
export async function claimAssistantBackgroundRunFinalization(
  db: AssistantBackgroundRunsDb,
  streamRequestId: string,
  ownerId: string,
  input: Omit<UpdateAssistantBackgroundRunInput, "status"> = {},
): Promise<AssistantBackgroundRun | null> {
  const row = assistantBackgroundRunUpdateRow({
    ...input,
    status: "finalizing",
    finalizationOwner: ownerId,
  });
  const { data, error } = await db
    .from("assistant_background_runs")
    .update(row)
    .eq("stream_request_id", streamRequestId)
    .in("status", ACTIVE_ASSISTANT_BACKGROUND_RUN_STATUSES)
    .select("*")
    .maybeSingle();
  if (error) throw persistenceError("claim finalization for", error);
  return data ? parseRun(data) : null;
}

/** A stale recovery worker may fence a prior finalizer after the lease expires. */
export async function claimAssistantBackgroundRunRecoveryFinalization(
  db: AssistantBackgroundRunsDb,
  expectedRun: AssistantBackgroundRun,
  ownerId: string,
  input: Omit<UpdateAssistantBackgroundRunInput, "status"> = {},
): Promise<AssistantBackgroundRun | null> {
  const row = assistantBackgroundRunUpdateRow({
    ...input,
    status: "finalizing",
    finalizationOwner: ownerId,
  });
  const { data, error } = await db
    .from("assistant_background_runs")
    .update(row)
    .eq("stream_request_id", expectedRun.streamRequestId)
    .eq("status", expectedRun.status)
    .eq("updated_at", expectedRun.updatedAt)
    .select("*")
    .maybeSingle();
  if (error) throw persistenceError("claim recovery finalization for", error);
  return data ? parseRun(data) : null;
}

/** Renews or closes finalization only while the caller still owns its fence. */
export async function updateAssistantBackgroundRunAsFinalizer(
  db: AssistantBackgroundRunsDb,
  streamRequestId: string,
  ownerId: string,
  input: UpdateAssistantBackgroundRunInput,
): Promise<AssistantBackgroundRun | null> {
  const row = assistantBackgroundRunUpdateRow(input);
  const { data, error } = await db
    .from("assistant_background_runs")
    .update(row)
    .eq("stream_request_id", streamRequestId)
    .eq("finalization_owner", ownerId)
    .in("status", ["finalizing"])
    .select("*")
    .maybeSingle();
  if (error) throw persistenceError("update owned finalization for", error);
  return data ? parseRun(data) : null;
}

export async function getAssistantBackgroundRunById(
  db: AssistantBackgroundRunsDb,
  streamRequestId: string,
): Promise<AssistantBackgroundRun | null> {
  const { data, error } = await db
    .from("assistant_background_runs")
    .select("*")
    .eq("stream_request_id", streamRequestId)
    .maybeSingle();
  if (error) throw persistenceError("load", error);
  return data ? parseRun(data) : null;
}

export async function listRecoverableAssistantBackgroundRuns(
  db: AssistantBackgroundRunsDb,
  limit = 100,
): Promise<AssistantBackgroundRun[]> {
  const { data, error } = (await db
    .from("assistant_background_runs")
    .select("*")
    .in("status", ASSISTANT_BACKGROUND_RECOVERABLE_STATUSES)
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Math.min(500, Math.floor(limit))))) as unknown as {
    data: Record<string, unknown>[] | null;
    error: DbError | null;
  };
  if (error) throw persistenceError("list", error);
  return (data ?? []).map(parseRun);
}
