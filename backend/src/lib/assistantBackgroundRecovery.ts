import { randomUUID } from "node:crypto";
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

type Db = ReturnType<typeof createServerSupabase>;

export const ASSISTANT_BACKGROUND_HEARTBEAT_MS = 10_000;
export const ASSISTANT_BACKGROUND_STALE_MS = 30_000;
export const ASSISTANT_BACKGROUND_RECOVERY_INTERVAL_MS = 10_000;
export const ASSISTANT_CANCELLATION_HANDLER_GRACE_MS = 5_000;

type RetrieveResult = {
  response: Response;
  providerRequestId: string | null;
};

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
): Promise<boolean> {
  const { data, error } = await db
    .from("chat_messages")
    .update({
      content: [{ type: "content", text }],
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
      revision: assistantRuntimeRevision(),
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
      revision: assistantRuntimeRevision(),
    },
  );
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
      revision: assistantRuntimeRevision(),
    },
  );
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
      {
        revision: assistantRuntimeRevision(),
      },
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
        revision: assistantRuntimeRevision(),
      },
    );
    return Boolean(finalized);
  }

  const apiKey = await deps.loadOpenAIKey(run.userId);

  if (run.status === "cancel_requested") {
    if (run.providerResponseId) {
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
        revision: assistantRuntimeRevision(),
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
      revision: assistantRuntimeRevision(),
    },
  );
  if (!claimed) return false;
  if (!(await persistRecoveryMessage(deps.db, claimed, text))) {
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
        revision: assistantRuntimeRevision(),
      },
    );
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
      revision: assistantRuntimeRevision(),
    },
  );
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
