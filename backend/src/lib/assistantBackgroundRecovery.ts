import { randomUUID } from "node:crypto";
import { NotFoundError } from "openai";
import type { Response } from "openai/resources/responses/responses";
import {
  ASSISTANT_BACKGROUND_RECOVERABLE_STATUSES,
  claimAssistantBackgroundRunRecoveryFinalization,
  getAssistantBackgroundRunById,
  listRecoverableAssistantBackgroundRuns,
  updateAssistantBackgroundRun,
  updateAssistantBackgroundRunAsFinalizer,
  type AssistantBackgroundRun,
} from "./assistantBackgroundRuns";
import {
  assistantRuntimeRevision,
  logAssistantRunSlowOnce,
  logAssistantRunTerminal,
  shouldContinueAssistantStreamAfterDisconnect,
} from "./assistantStreamLifecycle";
import {
  cancelOpenAIBackgroundResponse,
  extractCompletedOpenAIOutput,
  openAIResponseHasFunctionCalls,
  retrieveOpenAIBackgroundResponse,
} from "./llm/openai";
import { safeErrorLog } from "./safeError";
import { createServerSupabase } from "./supabase";
import { getUserModelSettings } from "./userSettings";
import { createLegalQualityState, finalizeLegalOutput, type LegalQualityEvent } from "./legalOutputGate";

type Db = ReturnType<typeof createServerSupabase>;

export const ASSISTANT_BACKGROUND_HEARTBEAT_MS = 10_000;
export const ASSISTANT_BACKGROUND_STALE_MS = 30_000;
export const ASSISTANT_BACKGROUND_RECOVERY_INTERVAL_MS = 10_000;
export const ASSISTANT_CANCELLATION_HANDLER_GRACE_MS = 5_000;

// Bounded per-process dedupe: another replica may emit the same slow run once,
// and a run still pending after a day can emit another signal for attention.
const recoverySlowSignals = new Map<string, number>();
const RECOVERY_SLOW_SIGNAL_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_RECOVERY_SLOW_SIGNALS = 10_000;

function reportRecoveredSlowRun(run: AssistantBackgroundRun, now: number): void {
  for (const [runId, reportedAt] of recoverySlowSignals) {
    if (now - reportedAt > RECOVERY_SLOW_SIGNAL_TTL_MS) {
      recoverySlowSignals.delete(runId);
    }
  }
  const state = { logged: recoverySlowSignals.has(run.streamRequestId) };
  const reported = logAssistantRunSlowOnce({
    streamRequestId: run.streamRequestId,
    traceId: run.traceId,
    revision: run.revision,
    gitSha: run.gitSha,
    route: run.projectId ? "project_chat" : "chat",
    startedAt: new Date(run.requestStartedAt).getTime(),
  }, state, run.status, now);
  if (reported) {
    recoverySlowSignals.set(run.streamRequestId, now);
    while (recoverySlowSignals.size > MAX_RECOVERY_SLOW_SIGNALS) {
      const oldest = recoverySlowSignals.keys().next().value;
      if (!oldest) break;
      recoverySlowSignals.delete(oldest);
    }
  }
}

type RetrieveResult = {
  response: Response;
  providerRequestId: string | null;
};

function logRecoveredTerminalRun(
  run: AssistantBackgroundRun,
  terminalSubtype: string,
  outputChars?: number | null,
  hasUsableResult?: boolean | null,
): void {
  if (
    run.status !== "completed" &&
    run.status !== "failed" &&
    run.status !== "cancelled" &&
    run.status !== "interrupted"
  ) {
    return;
  }
  const provider = run.model.startsWith("gpt-")
    ? "openai"
    : run.model.startsWith("claude")
      ? "claude"
      : run.model.startsWith("gemini")
        ? "gemini"
        : "unknown";
  logAssistantRunTerminal(
    {
      streamRequestId: run.streamRequestId,
      traceId: run.traceId,
      revision: run.revision,
      gitSha: run.gitSha,
      route: run.projectId ? "project_chat" : "chat",
      startedAt: new Date(run.requestStartedAt).getTime(),
    },
    {
      status: run.status,
      terminalSubtype,
      provider,
      model: run.model,
      errorCode: run.errorCode,
      providerRequestId: run.providerRequestId,
      providerResponseId: run.providerResponseId,
      providerStatus: run.providerStatus,
      outputChars,
      hasUsableResult,
    },
  );
}

export type AssistantBackgroundRecoveryDependencies = {
  db: Db;
  now?: () => number;
  staleMs?: number;
  listRuns?: () => Promise<AssistantBackgroundRun[]>;
  loadOpenAIKey?: (userId: string) => Promise<string | null>;
  retrieve?: (input: {
    apiKey?: string | null;
    responseId: string;
  }) => Promise<RetrieveResult>;
  cancel?: (input: {
    apiKey?: string | null;
    responseId: string;
  }) => Promise<void>;
};

function visibleRecoveredText(text: string): string {
  const citationStart = text.indexOf("<CITATIONS>");
  return (citationStart >= 0 ? text.slice(0, citationStart) : text).trim();
}

async function persistRecoveryMessage(
  db: Db,
  run: AssistantBackgroundRun,
  text: string,
  rawRecoveredOutput?: string,
): Promise<boolean> {
  const quality = rawRecoveredOutput === undefined ? null : finalizeLegalOutput(rawRecoveredOutput, createLegalQualityState());
  const qualityEvent: LegalQualityEvent | null = quality ? { type: "legal_quality", target: "Recovered assistant response", report: quality.report } : null;
  if (qualityEvent) {
    qualityEvent.report.checks.push({ claimId: "output", field: "recovered_source_coverage", status: "unchecked", detail: "This provider response was recovered after the active handler ended. Turn source evidence was not restored; source-dependent checks require attorney review." });
    qualityEvent.report.coverage.unchecked += 1;
  }
  const { data, error } = await db
    .from("chat_messages")
    .update({
      content: [...(qualityEvent ? [qualityEvent] : []), { type: "content", text }],
      annotations: null,
      citations: null,
    })
    .eq("id", run.assistantMessageId)
    .is("content", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error("Failed to persist recovered assistant message");
  return Boolean(data);
}

async function recoveryMessageAlreadyPersisted(
  db: Db,
  run: AssistantBackgroundRun,
): Promise<boolean> {
  const { data, error } = await db
    .from("chat_messages")
    .select("content")
    .eq("id", run.assistantMessageId)
    .maybeSingle();
  if (error) throw new Error("Failed to inspect recovered assistant message");
  return Boolean(data && data.content != null);
}

async function finalizeInterrupted(
  db: Db,
  run: AssistantBackgroundRun,
  ownerId: string,
  errorCode: string,
  message: string,
): Promise<boolean> {
  const claimed = await claimAssistantBackgroundRunRecoveryFinalization(
    db,
    run,
    ownerId,
    {
      errorCode,
      safeErrorMessage: message,
    },
  );
  if (!claimed) return false;
  if (!(await persistRecoveryMessage(db, claimed, message))) return false;
  const finalized = await updateAssistantBackgroundRunAsFinalizer(
    db,
    claimed.streamRequestId,
    ownerId,
    {
      status: "interrupted",
      errorCode,
      safeErrorMessage: message,
      completedAt: new Date(),
    },
  );
  if (finalized) logRecoveredTerminalRun(finalized, errorCode, 0);
  return Boolean(finalized);
}

async function finalizeCancelled(
  db: Db,
  run: AssistantBackgroundRun,
): Promise<boolean> {
  const message = "Cancelled by user.";
  await persistRecoveryMessage(db, run, message);
  const finalized = await updateAssistantBackgroundRun(
    db,
    run.streamRequestId,
    {
      status: "cancelled",
      providerStatus: "cancelled",
      errorCode: "explicit_user_cancel",
      safeErrorMessage: message,
      completedAt: new Date(),
    },
  );
  if (finalized) logRecoveredTerminalRun(finalized, "explicit_user_cancel", 0);
  return Boolean(finalized);
}

async function recoverRun(
  run: AssistantBackgroundRun,
  recoveryOwnerId: string,
  deps: Required<
    Pick<
      AssistantBackgroundRecoveryDependencies,
      "db" | "loadOpenAIKey" | "retrieve" | "cancel"
    >
  >,
): Promise<boolean> {
  if (
    run.status === "finalizing" &&
    (await recoveryMessageAlreadyPersisted(deps.db, run))
  ) {
    const terminalStatus =
      run.providerStatus === "failed"
        ? "failed"
        : run.errorCode || run.safeErrorMessage
          ? "interrupted"
          : "completed";
    const claimed = await claimAssistantBackgroundRunRecoveryFinalization(
      deps.db,
      run,
      recoveryOwnerId,
      {},
    );
    if (!claimed) return false;
    const finalized = await updateAssistantBackgroundRunAsFinalizer(
      deps.db,
      run.streamRequestId,
      recoveryOwnerId,
      {
        status: terminalStatus,
        ...(terminalStatus === "completed"
          ? { providerStatus: "completed" as const }
          : {}),
        completedAt: new Date(),
      },
    );
    if (finalized) {
      logRecoveredTerminalRun(
        finalized,
        terminalStatus === "completed"
          ? "recovered_finalization"
          : finalized.errorCode ?? "recovered_finalization",
      );
    }
    return Boolean(finalized);
  }

  const apiKey = await deps.loadOpenAIKey(run.userId);

  if (run.status === "cancel_requested") {
    if (run.providerResponseId) {
      try {
        const { response } = await deps.retrieve({
          apiKey,
          responseId: run.providerResponseId,
        });
        if (response.status === "queued" || response.status === "in_progress") {
          if (
            !shouldContinueAssistantStreamAfterDisconnect(
              run.reasoningMode,
              run.reasoningEffort,
            )
          ) {
            // Standard Responses cannot use the background cancellation API.
            // Keep the durable request pending until its aborted transport is
            // reflected as a terminal provider status.
            return false;
          }
          await deps.cancel({ apiKey, responseId: run.providerResponseId });
        }
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    return finalizeCancelled(deps.db, run);
  }

  if (!run.providerResponseId) {
    return finalizeInterrupted(
      deps.db,
      run,
      recoveryOwnerId,
      "background_response_not_started",
      "This extended response was interrupted before the provider assigned a response. Please retry.",
    );
  }

  const { response, providerRequestId } = await deps.retrieve({
    apiKey,
    responseId: run.providerResponseId,
  });
  if (response.status === "queued" || response.status === "in_progress") {
    if (run.status === "finalizing") {
      return finalizeInterrupted(
        deps.db,
        run,
        recoveryOwnerId,
        "background_finalization_interrupted",
        "This response was interrupted while Docket was finalizing it. Please retry.",
      );
    }
    const updated = await updateAssistantBackgroundRun(
      deps.db,
      run.streamRequestId,
      {
        status: "background_pending",
        providerStatus: response.status,
        providerResponseId: response.id,
        providerRequestId,
      },
    );
    return Boolean(updated);
  }

  if (response.status === "cancelled") {
    return finalizeInterrupted(
      deps.db,
      run,
      recoveryOwnerId,
      "provider_cancelled",
      "The provider cancelled this response before it finished. Please retry.",
    );
  }

  if (response.status !== "completed") {
    return finalizeInterrupted(
      deps.db,
      run,
      recoveryOwnerId,
      `provider_${response.status ?? "unknown"}`,
      "The provider could not finish this extended response. Please retry.",
    );
  }

  if (openAIResponseHasFunctionCalls(response)) {
    return finalizeInterrupted(
      deps.db,
      run,
      recoveryOwnerId,
      "background_tool_continuation_interrupted",
      "This extended response was interrupted while it was using tools. Please retry so Docket can safely continue without repeating a tool action.",
    );
  }

  const output = extractCompletedOpenAIOutput(response);
  const text = visibleRecoveredText(output.text);
  if (!text) {
    return finalizeInterrupted(
      deps.db,
      run,
      recoveryOwnerId,
      "background_response_empty",
      "The provider finished without a recoverable response. Please retry.",
    );
  }

  const claimed = await claimAssistantBackgroundRunRecoveryFinalization(
    deps.db,
    run,
    recoveryOwnerId,
    {
      providerStatus: "completed",
      providerResponseId: response.id,
      providerRequestId,
      errorCode: null,
      safeErrorMessage: null,
    },
  );
  if (!claimed) return false;
  if (!(await persistRecoveryMessage(deps.db, claimed, text, output.text))) {
    // A live finalizer saved the rich payload after our earlier read. Preserve
    // it and only close the durable lifecycle row.
    const finalized = await updateAssistantBackgroundRunAsFinalizer(
      deps.db,
      claimed.streamRequestId,
      recoveryOwnerId,
      {
        status: "completed",
        providerStatus: "completed",
        providerResponseId: response.id,
        providerRequestId,
        errorCode: null,
        safeErrorMessage: null,
        completedAt: new Date(),
      },
    );
    if (finalized) logRecoveredTerminalRun(finalized, "recovered_answer");
    return Boolean(finalized);
  }
  const finalized = await updateAssistantBackgroundRunAsFinalizer(
    deps.db,
    claimed.streamRequestId,
    recoveryOwnerId,
    {
      status: "completed",
      providerStatus: "completed",
      providerResponseId: response.id,
      providerRequestId,
      errorCode: null,
      safeErrorMessage: null,
      completedAt: new Date(),
    },
  );
  if (finalized) {
    logRecoveredTerminalRun(finalized, "recovered_answer", text.length, true);
  }
  return Boolean(finalized);
}

export async function reconcileStaleAssistantBackgroundRuns(
  dependencies: AssistantBackgroundRecoveryDependencies,
): Promise<{ inspected: number; recovered: number; failed: number }> {
  const now = dependencies.now ?? Date.now;
  const staleMs = dependencies.staleMs ?? ASSISTANT_BACKGROUND_STALE_MS;
  const listRuns =
    dependencies.listRuns ??
    (() => listRecoverableAssistantBackgroundRuns(dependencies.db));
  const loadOpenAIKey =
    dependencies.loadOpenAIKey ??
    (async (userId: string) => {
      const settings = await getUserModelSettings(userId, dependencies.db);
      return settings.api_keys.openai ?? null;
    });
  const retrieve =
    dependencies.retrieve ??
    ((input) => retrieveOpenAIBackgroundResponse(input));
  const cancel =
    dependencies.cancel ?? ((input) => cancelOpenAIBackgroundResponse(input));
  const runs = await listRuns();
  const staleRuns = runs.filter(
    (run) =>
      run.status === "cancel_requested" ||
      now() - new Date(run.updatedAt).getTime() >= staleMs,
  );
  let recovered = 0;
  let failed = 0;

  for (const run of staleRuns) {
    try {
      // Re-read immediately before recovery so a live handler heartbeat or a
      // newly requested cancellation wins over the earlier list snapshot.
      const current = await getAssistantBackgroundRunById(
        dependencies.db,
        run.streamRequestId,
      );
      if (!current) continue;
      if (
        !ASSISTANT_BACKGROUND_RECOVERABLE_STATUSES.includes(
          current.status as (typeof ASSISTANT_BACKGROUND_RECOVERABLE_STATUSES)[number],
        )
      ) {
        continue;
      }
      if (
        current.status === "cancel_requested" &&
        now() - new Date(current.updatedAt).getTime() <
          Math.min(staleMs, ASSISTANT_CANCELLATION_HANDLER_GRACE_MS)
      ) {
        // Let the owning route's 2s monitor abort provider/tool execution
        // before another replica confirms the durable cancellation.
        continue;
      }
      if (
        current.status !== "cancel_requested" &&
        now() - new Date(current.updatedAt).getTime() < staleMs
      ) {
        continue;
      }
      if (
        current.status === "cancel_requested" &&
        !current.providerResponseId &&
        now() - new Date(current.updatedAt).getTime() < staleMs
      ) {
        // Without a provider ID there is no cancellation endpoint to confirm.
        // Give the owning handler/replica time to observe the durable request
        // and abort its transport before finalizing the user-visible state.
        continue;
      }
      reportRecoveredSlowRun(current, now());
      const didRecover = await recoverRun(current, randomUUID(), {
        db: dependencies.db,
        loadOpenAIKey,
        retrieve,
        cancel,
      });
      if (!didRecover) continue;
      recovered += 1;
      console.warn("[assistant-background/recovery] reconciled", {
        run_id: current.streamRequestId,
        prior_status: current.status,
        revision: assistantRuntimeRevision(),
      });
    } catch (error) {
      failed += 1;
      console.error("[assistant-background/recovery] failed", {
        run_id: run.streamRequestId,
        error: safeErrorLog(error),
        revision: assistantRuntimeRevision(),
      });
    }
  }

  return { inspected: staleRuns.length, recovered, failed };
}

let recoveryRunning = false;

export function startAssistantBackgroundRecovery(): () => void {
  const db = createServerSupabase();
  const run = async () => {
    if (recoveryRunning) return;
    recoveryRunning = true;
    try {
      await reconcileStaleAssistantBackgroundRuns({ db });
    } catch (error) {
      console.error("[assistant-background/recovery] scan failed", {
        error: safeErrorLog(error),
        revision: assistantRuntimeRevision(),
      });
    } finally {
      recoveryRunning = false;
    }
  };
  const initial = setTimeout(() => void run(), 5_000);
  const interval = setInterval(
    () => void run(),
    ASSISTANT_BACKGROUND_RECOVERY_INTERVAL_MS,
  );
  initial.unref();
  interval.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
