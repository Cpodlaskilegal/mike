import { Router, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  buildProjectDocContext,
  buildMessages,
  buildWorkflowStore,
  enrichWithPriorEvents,
  extractAnnotations,
  runLLMStream,
  PROJECT_EXTRA_TOOLS,
  type ChatMessage,
  type DocIndex,
} from "../lib/chatTools";
import {
  appendConnectionInterruptionMarker,
  appendCancellationMarker,
  AssistantStreamAbortError,
  isAbortError,
  parseMainModelRequest,
  throwIfAborted,
  type ProviderRunProgress,
} from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { chatStreamErrorLine, toChatStreamError } from "../lib/chatErrors";
import { safeErrorLog } from "../lib/safeError";
import {
  consumeAskInputsResponse,
  createCitationSseBridge,
  extractRichCitations,
  parseAskInputsResponsePayload,
} from "../lib/assistantContracts";
import {
  assistantStreamAbortCause,
  assistantStreamTerminalEvent,
  isAssistantStreamRequestId,
  logAssistantStreamLifecycle,
  PRO_BACKGROUND_CUTOFF_MS,
  registerAssistantStream,
  requestAssistantStreamCancellation,
  shouldContinueAssistantStreamAfterDisconnect,
  unregisterAssistantStream,
} from "../lib/assistantStreamLifecycle";
import {
  assistantBackgroundProgressUpdate,
  claimAssistantBackgroundRunFinalization,
  createAssistantBackgroundRun,
  getAssistantBackgroundRunById,
  updateAssistantBackgroundRun,
  updateAssistantBackgroundRunAsFinalizer,
  type UpdateAssistantBackgroundRunInput,
} from "../lib/assistantBackgroundRuns";
import { cancelOpenAIBackgroundResponse } from "../lib/llm/openai";
import { reconcileMcpApprovalTerminalEventsForMessage } from "../lib/mcpConnectors";

const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

DRAFTING EXEMPLARS IN PROJECTS:
When the user asks for drafting inside a project, treat exemplar discovery as part of the drafting task. Use list_documents first to look for project documents whose filename or folder path suggests an example, template, standard form, prior filing, filed pleading, motion, brief, letter, or similar draft. If the project documents do not contain a good exemplar and MCP tools for PracticePanther, Box, or another file source are available, search those sources for a similar filed pleading from another matter and then for Box toolbox, Example Drafts, template, or standard-form files. Read any candidate exemplar before using it. If a suitable project document exists and the user wants its structure preserved, replicate it and edit the copy rather than generating a fresh document.

REPLICATING A DOCUMENT:
When the user wants to use an existing project document as a starting point for a new file (e.g. "use this NDA as a template", "make me a copy of the SOW so I can edit it", "duplicate this and adapt it for company X"), call the replicate_document tool with the source doc_id. This creates a byte-for-byte copy as a new project document, returns a fresh doc_id slug, and shows a download/open card in the UI. Then call edit_document on the returned slug to make the user's requested changes — do NOT call generate_docx for cases where the user clearly wants the existing document's structure and formatting preserved.`;

export const projectChatRouter = Router({ mergeParams: true });

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};
const PRO_BACKGROUND_MESSAGE =
  "This extended response is still running in the background. Docket will refresh this chat when it finishes.";

function createSafeStreamWriter(res: Response) {
  return (line: string) => {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(line);
    } catch (err) {
      devLog("[project-chat/stream] client write skipped", err);
    }
  };
}

function parseChatMessages(
  value: unknown,
): { ok: true; messages: ChatMessage[] } | { ok: false; detail: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, detail: "messages must be a non-empty array" };
  }

  for (const message of value) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { ok: false, detail: "messages must contain objects" };
    }
    const row = message as Record<string, unknown>;
    if (row.role !== "user" && row.role !== "assistant") {
      return {
        ok: false,
        detail: "message.role must be either user or assistant",
      };
    }
    if (row.content !== null && typeof row.content !== "string") {
      return {
        ok: false,
        detail: "message.content must be a string or null",
      };
    }
  }

  return { ok: true, messages: value as ChatMessage[] };
}

function parseOptionalChatId(
  value: unknown,
): { ok: true; chatId: string | null } | { ok: false; detail: string } {
  if (value === undefined || value === null) return { ok: true, chatId: null };
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, detail: "chat_id must be a non-empty string" };
  }
  return { ok: true, chatId: value.trim() };
}

function replaceLatestUserMessage(
  messages: ChatMessage[],
  content: string,
): ChatMessage[] {
  const index = [...messages]
    .map((message, i) => (message.role === "user" ? i : -1))
    .reverse()
    .find((i) => i >= 0);
  if (index === undefined) {
    return [...messages, { role: "user", content }];
  }
  const next = messages.slice();
  next[index] = { ...next[index], content };
  return next;
}

type RequestDocumentRef = { filename: string; document_id: string };

function parseOptionalDocumentRef(
  value: unknown,
  fieldName: string,
):
  | { ok: true; value: RequestDocumentRef | undefined }
  | { ok: false; detail: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: `${fieldName} must be an object` };
  }
  const row = value as Record<string, unknown>;
  if (typeof row.filename !== "string" || !row.filename.trim()) {
    return {
      ok: false,
      detail: `${fieldName}.filename must be a non-empty string`,
    };
  }
  if (typeof row.document_id !== "string" || !row.document_id.trim()) {
    return {
      ok: false,
      detail: `${fieldName}.document_id must be a non-empty string`,
    };
  }
  return {
    ok: true,
    value: {
      filename: row.filename.trim(),
      document_id: row.document_id.trim(),
    },
  };
}

function parseOptionalDocumentRefs(
  value: unknown,
):
  | { ok: true; value: RequestDocumentRef[] | undefined }
  | { ok: false; detail: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      detail: "attached_documents must be an array",
    };
  }
  const docs: RequestDocumentRef[] = [];
  for (let i = 0; i < value.length; i++) {
    const parsed = parseOptionalDocumentRef(
      value[i],
      `attached_documents[${i}]`,
    );
    if (!parsed.ok) return parsed;
    if (parsed.value) docs.push(parsed.value);
  }
  return { ok: true, value: docs };
}

// POST /projects/:projectId/chat/cancel — explicit, authenticated cancellation.
projectChatRouter.post("/cancel", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const streamRequestId = req.body?.stream_request_id;
  if (!isAssistantStreamRequestId(streamRequestId)) {
    return void res
      .status(400)
      .json({ detail: "stream_request_id must be a UUID" });
  }
  const db = createServerSupabase();
  try {
    let persisted = await getAssistantBackgroundRunById(db, streamRequestId);
    if (
      persisted &&
      (persisted.userId !== userId || persisted.projectId !== projectId)
    ) {
      persisted = null;
    }
    if (
      persisted &&
      [
        "finalizing",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(persisted.status)
    ) {
      return void res.status(409).json({
        detail: "Assistant run is already finished",
        status: persisted.status,
      });
    }
    if (persisted && persisted.status !== "cancel_requested") {
      const updated = await updateAssistantBackgroundRun(db, streamRequestId, {
        status: "cancel_requested",
        errorCode: "explicit_user_cancel",
        safeErrorMessage: "Cancellation requested by user.",
      });
      if (updated) {
        persisted = updated;
      } else {
        const current = await getAssistantBackgroundRunById(
          db,
          streamRequestId,
        );
        if (
          !current ||
          current.userId !== userId ||
          current.projectId !== projectId
        ) {
          persisted = null;
        } else if (current.status === "cancel_requested") {
          persisted = current;
        } else if (
          [
            "finalizing",
            "completed",
            "failed",
            "cancelled",
            "interrupted",
          ].includes(current.status)
        ) {
          return void res.status(409).json({
            detail: "Assistant run is already finished",
            status: current.status,
          });
        } else {
          throw new Error("Assistant cancellation compare-and-set failed");
        }
      }
    }

    const stream = requestAssistantStreamCancellation({
      streamRequestId,
      userId,
      route: "project_chat",
      projectId,
    });
    if (!stream && !persisted) {
      return void res.status(404).json({ detail: "Active stream not found" });
    }
    if (stream) {
      logAssistantStreamLifecycle(stream, "explicit_user_cancel_requested");
    }
    if (
      persisted?.providerResponseId &&
      shouldContinueAssistantStreamAfterDisconnect(
        persisted.reasoningMode,
        persisted.reasoningEffort,
      )
    ) {
      void getUserModelSettings(userId, db)
        .then(({ api_keys }) =>
          cancelOpenAIBackgroundResponse({
            apiKey: api_keys.openai,
            responseId: persisted!.providerResponseId!,
          }),
        )
        .catch((error) => {
          console.error(
            "[project-chat/cancel] provider cancellation failed",
            safeErrorLog(error),
          );
        });
    }
    res.status(202).json({
      status: "cancelling",
      trace_id: stream?.traceId ?? persisted?.traceId,
      revision: stream?.revision ?? persisted?.revision,
    });
  } catch (error) {
    console.error(
      "[project-chat/cancel] cancellation failed",
      safeErrorLog(error),
    );
    res.status(500).json({
      detail: "Docket could not confirm the cancellation request",
    });
  }
});

// POST /projects/:projectId/chat — streaming
projectChatRouter.post("/", requireAuth, async (req, res) => {
  const requestStartedAt = Date.now();
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const parsedMessages = parseChatMessages(body.messages);
  if (!parsedMessages.ok) {
    return void res.status(400).json({ detail: parsedMessages.detail });
  }
  const parsedChatId = parseOptionalChatId(body.chat_id);
  if (!parsedChatId.ok) {
    return void res.status(400).json({ detail: parsedChatId.detail });
  }
  const requestedStreamId = body.stream_request_id;
  if (
    requestedStreamId !== undefined &&
    !isAssistantStreamRequestId(requestedStreamId)
  ) {
    return void res
      .status(400)
      .json({ detail: "stream_request_id must be a UUID" });
  }
  const parsedAskInputsResponse = parseAskInputsResponsePayload(
    body.ask_inputs_response,
  );
  if (!parsedAskInputsResponse.ok) {
    return void res
      .status(400)
      .json({ detail: parsedAskInputsResponse.detail });
  }
  if (parsedAskInputsResponse.response && !parsedChatId.chatId) {
    return void res.status(400).json({
      detail: "ask_inputs_response requires an existing chat_id",
    });
  }
  const parsedDisplayedDoc = parseOptionalDocumentRef(
    body.displayed_doc,
    "displayed_doc",
  );
  if (!parsedDisplayedDoc.ok) {
    return void res.status(400).json({ detail: parsedDisplayedDoc.detail });
  }
  const parsedAttachedDocuments = parseOptionalDocumentRefs(
    body.attached_documents,
  );
  if (!parsedAttachedDocuments.ok) {
    return void res
      .status(400)
      .json({ detail: parsedAttachedDocuments.detail });
  }
  const parsedMainModel = parseMainModelRequest(req.body);
  if (!parsedMainModel.ok) {
    return void res.status(400).json({ detail: parsedMainModel.detail });
  }
  const mainModelRequest = parsedMainModel.value;

  const messages = parsedMessages.messages;
  const chat_id = parsedChatId.chatId;
  const displayed_doc = parsedDisplayedDoc.value;
  const attached_documents = parsedAttachedDocuments.value;

  const db = createServerSupabase();

  // Verify the user has access to the project (owner or shared member).
  const projectAccess = await checkProjectAccess(
    projectId,
    userId,
    userEmail,
    db,
    {
      allowAdmin: true,
    },
  );
  if (!projectAccess.ok)
    return void res.status(404).json({ detail: "Project not found" });

  let chatId = chat_id ?? null;
  let chatTitle: string | null = null;

  if (chatId) {
    const { data: existing } = await db
      .from("chats")
      .select("id, title, project_id")
      .eq("id", chatId)
      .single();
    const canUse = !!existing && existing.project_id === projectId;
    if (!canUse) {
      if (parsedAskInputsResponse.response) {
        return void res.status(404).json({ detail: "Chat not found" });
      }
      chatId = null;
    } else chatTitle = existing!.title;
  }

  if (!chatId) {
    const { data: newChat, error } = await db
      .from("chats")
      .insert({ user_id: userId, project_id: projectId })
      .select("id, title")
      .single();
    if (error || !newChat)
      return void res.status(500).json({ detail: "Failed to create chat" });
    chatId = newChat.id as string;
    chatTitle = newChat.title;
  }

  let streamMessages = messages;
  let isAskInputsContinuation = false;
  if (parsedAskInputsResponse.response) {
    const consumed = await consumeAskInputsResponse(db, {
      chatId,
      submittedByUserId: userId,
      response: parsedAskInputsResponse.response,
    });
    if (!consumed.ok) {
      return void res.status(consumed.status).json({ detail: consumed.detail });
    }
    streamMessages = replaceLatestUserMessage(messages, consumed.content);
    isAskInputsContinuation = true;
  }

  const lastUser = [...streamMessages].reverse().find((m) => m.role === "user");
  if (lastUser) {
    await db.from("chat_messages").insert({
      chat_id: chatId,
      role: "user",
      content: lastUser.content,
      files: lastUser.files ?? null,
      workflow: lastUser.workflow ?? null,
    });
  }

  const { data: assistantPlaceholder } = await db
    .from("chat_messages")
    .insert({
      chat_id: chatId,
      role: "assistant",
      content: null,
      annotations: null,
      citations: null,
    })
    .select("id")
    .maybeSingle();
  const assistantMessageId =
    (assistantPlaceholder as { id?: string } | null)?.id ?? null;

  const streamAbort = new AbortController();
  const streamLifecycle = registerAssistantStream({
    requestedStreamId: requestedStreamId ?? null,
    userId,
    chatId,
    projectId,
    route: "project_chat",
    controller: streamAbort,
    startedAt: requestStartedAt,
  });
  const backgroundRunEnabled = shouldContinueAssistantStreamAfterDisconnect(
    mainModelRequest.reasoningMode,
    mainModelRequest.reasoningEffort,
  );
  // Every stream gets a durable row so cancellation works across replicas.
  // Only Pro/Max continues provider work after the browser disconnects.
  const runPersistenceEnabled = true;
  let backgroundRunUpdateQueue: Promise<void> = Promise.resolve();
  const updateBackgroundRun = (
    update: UpdateAssistantBackgroundRunInput,
  ): Promise<void> => {
    if (!runPersistenceEnabled) return Promise.resolve();
    const operation = backgroundRunUpdateQueue.then(async () => {
      const persisted = await updateAssistantBackgroundRun(
        db,
        streamLifecycle.streamRequestId,
        update,
      );
      if (!persisted) {
        throw new Error("Assistant background run no longer exists");
      }
    });
    backgroundRunUpdateQueue = operation.catch(() => undefined);
    return operation;
  };
  const claimBackgroundRunFinalization = (
    update: Omit<UpdateAssistantBackgroundRunInput, "status">,
  ): Promise<void> => {
    if (!runPersistenceEnabled) return Promise.resolve();
    const operation = backgroundRunUpdateQueue.then(async () => {
      const persisted = await claimAssistantBackgroundRunFinalization(
        db,
        streamLifecycle.streamRequestId,
        streamLifecycle.traceId,
        update,
      );
      if (!persisted) {
        throw new Error("Assistant background finalization is already owned");
      }
    });
    backgroundRunUpdateQueue = operation.catch(() => undefined);
    return operation;
  };
  const updateBackgroundRunAsFinalizer = (
    update: UpdateAssistantBackgroundRunInput,
  ): Promise<void> => {
    if (!runPersistenceEnabled) return Promise.resolve();
    const operation = backgroundRunUpdateQueue.then(async () => {
      const persisted = await updateAssistantBackgroundRunAsFinalizer(
        db,
        streamLifecycle.streamRequestId,
        streamLifecycle.traceId,
        update,
      );
      if (!persisted) {
        throw new Error("Assistant background finalization ownership was lost");
      }
    });
    backgroundRunUpdateQueue = operation.catch(() => undefined);
    return operation;
  };

  if (runPersistenceEnabled) {
    if (!assistantMessageId) {
      unregisterAssistantStream(streamLifecycle);
      return void res.status(500).json({
        detail: "Failed to create the assistant response placeholder",
      });
    }
    try {
      await createAssistantBackgroundRun(db, {
        streamRequestId: streamLifecycle.streamRequestId,
        assistantMessageId,
        chatId,
        userId,
        projectId,
        model: mainModelRequest.providerModel,
        reasoningMode: mainModelRequest.reasoningMode,
        reasoningEffort: mainModelRequest.reasoningEffort,
        traceId: streamLifecycle.traceId,
        revision: streamLifecycle.revision,
        requestStartedAt: new Date(requestStartedAt),
      });
    } catch (error) {
      unregisterAssistantStream(streamLifecycle);
      await db
        .from("chat_messages")
        .update({
          content: [
            {
              type: "content",
              text: "Docket could not start this extended response. Please retry.",
            },
          ],
        })
        .eq("id", assistantMessageId);
      console.error(
        "[project-chat/stream] failed to create background run",
        safeErrorLog(error),
      );
      return void res.status(500).json({
        detail: "Failed to start the extended assistant response",
      });
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Docket-Trace-Id", streamLifecycle.traceId);
  res.flushHeaders();

  const write = createSafeStreamWriter(res);
  const citationSse = createCitationSseBridge(write);
  let runFinished = false;
  let backgroundCompletionFinalizing = false;
  let streamDocIndex: DocIndex = {};
  let lastProviderProgressFingerprint: string | null = null;
  const persistProviderProgress = runPersistenceEnabled
    ? async (progress: ProviderRunProgress) => {
        const fingerprint = JSON.stringify([
          progress.iteration,
          progress.phase,
          progress.providerResponseId ?? null,
          progress.providerStatus ?? null,
          progress.recoveryAttempted ?? false,
        ]);
        if (fingerprint === lastProviderProgressFingerprint) return;
        lastProviderProgressFingerprint = fingerprint;
        const progressUpdate = assistantBackgroundProgressUpdate(
          progress,
          streamLifecycle.responseDetached,
        );
        if (progressUpdate.status === "finalizing") {
          await claimBackgroundRunFinalization(progressUpdate);
          backgroundCompletionFinalizing = true;
        } else {
          await updateBackgroundRun(progressUpdate);
        }
        if (
          streamLifecycle.responseDetached &&
          progress.phase !== "failed" &&
          progressUpdate.status !== "background_pending"
        ) {
          await updateBackgroundRun({ status: "background_pending" });
        }
      }
    : undefined;
  let proBackgroundTimer: NodeJS.Timeout | null = null;
  const clearProBackgroundTimer = () => {
    if (!proBackgroundTimer) return;
    clearTimeout(proBackgroundTimer);
    proBackgroundTimer = null;
  };
  let backgroundMonitorTimer: NodeJS.Timeout | null = null;
  let backgroundMonitorInFlight = false;
  let backgroundMonitorTicks = 0;
  let recoveryTakeoverDetected = false;
  const clearBackgroundMonitor = () => {
    if (!backgroundMonitorTimer) return;
    clearInterval(backgroundMonitorTimer);
    backgroundMonitorTimer = null;
  };
  const clearAllBackgroundTimers = () => {
    clearProBackgroundTimer();
    clearBackgroundMonitor();
  };
  streamLifecycle.cancelCleanup = clearAllBackgroundTimers;
  if (runPersistenceEnabled) {
    backgroundMonitorTimer = setInterval(() => {
      if (runFinished || backgroundMonitorInFlight) return;
      backgroundMonitorInFlight = true;
      void (async () => {
        const persisted = await getAssistantBackgroundRunById(
          db,
          streamLifecycle.streamRequestId,
        );
        if (!persisted) return;
        if (
          persisted.status === "cancel_requested" ||
          persisted.status === "cancelled"
        ) {
          streamLifecycle.abortCause = "explicit_user_cancel";
          clearAllBackgroundTimers();
          if (!streamAbort.signal.aborted) streamAbort.abort();
          return;
        }
        if (
          persisted.status === "completed" ||
          persisted.status === "failed" ||
          persisted.status === "interrupted"
        ) {
          if (
            persisted.finalizationOwner &&
            persisted.finalizationOwner !== streamLifecycle.traceId
          ) {
            recoveryTakeoverDetected = true;
            streamLifecycle.abortCause = "provider_abort";
            clearAllBackgroundTimers();
            if (!streamAbort.signal.aborted) streamAbort.abort();
          } else {
            clearBackgroundMonitor();
          }
          return;
        }
        if (
          persisted.status === "finalizing" &&
          persisted.finalizationOwner !== streamLifecycle.traceId
        ) {
          recoveryTakeoverDetected = true;
          streamLifecycle.abortCause = "provider_abort";
          clearAllBackgroundTimers();
          if (!streamAbort.signal.aborted) streamAbort.abort();
          return;
        }
        backgroundMonitorTicks += 1;
        if (backgroundMonitorTicks % 5 === 0) {
          if (persisted.status === "finalizing") {
            await updateBackgroundRunAsFinalizer({
              status: "finalizing",
              updatedAt: new Date(),
            });
          } else {
            await updateBackgroundRun({
              updatedAt: new Date(),
              ...(streamLifecycle.responseDetached
                ? { status: "background_pending" as const }
                : {}),
            });
          }
        }
      })()
        .catch((error) => {
          console.error(
            "[project-chat/stream] background monitor failed",
            safeErrorLog(error),
          );
        })
        .finally(() => {
          backgroundMonitorInFlight = false;
        });
    }, 2_000);
    backgroundMonitorTimer.unref();
  }
  res.on("close", () => {
    if (runFinished || streamLifecycle.responseDetached) return;
    streamLifecycle.responseDetached = true;
    if (!streamLifecycle.abortCause) {
      streamLifecycle.abortCause = "client_disconnect";
    }
    clearProBackgroundTimer();
    if (backgroundRunEnabled) {
      logAssistantStreamLifecycle(
        streamLifecycle,
        "client_disconnect_background_continues",
      );
      return;
    }
    logAssistantStreamLifecycle(
      streamLifecycle,
      "client_disconnect_provider_abort",
    );
    streamAbort.abort();
  });

  try {
    write(
      `data: ${JSON.stringify({
        type: "chat_id",
        chatId,
        traceId: streamLifecycle.traceId,
        streamRequestId: streamLifecycle.streamRequestId,
        revision: streamLifecycle.revision,
      })}\n\n`,
    );
    write(
      `data: ${JSON.stringify({
        type: "stream_start",
        runId: streamLifecycle.streamRequestId,
        traceId: streamLifecycle.traceId,
        revision: streamLifecycle.revision,
        continuingAfterDisconnect: backgroundRunEnabled,
      })}\n\n`,
    );
    if (backgroundRunEnabled) {
      const remaining = Math.max(
        0,
        PRO_BACKGROUND_CUTOFF_MS - (Date.now() - streamLifecycle.startedAt),
      );
      proBackgroundTimer = setTimeout(() => {
        proBackgroundTimer = null;
        if (runFinished || streamLifecycle.responseDetached) return;
        streamLifecycle.responseDetached = true;
        if (!backgroundCompletionFinalizing) {
          void updateBackgroundRun({
            status: "background_pending",
          }).catch((error) => {
            console.error(
              "[project-chat/stream] failed to persist background handoff",
              safeErrorLog(error),
            );
          });
        }
        write(
          `data: ${JSON.stringify({
            type: "background_pending",
            message: PRO_BACKGROUND_MESSAGE,
            retryable: true,
            continuing: true,
            runId: streamLifecycle.streamRequestId,
            traceId: streamLifecycle.traceId,
          })}\n\n`,
        );
        write(
          `data: ${JSON.stringify(
            assistantStreamTerminalEvent(
              streamLifecycle,
              "background_pending",
              { retryable: true, continuing: true },
            ),
          )}\n\n`,
        );
        write("data: [DONE]\n\n");
        logAssistantStreamLifecycle(
          streamLifecycle,
          "assistant_background_pending",
          { cutoff_ms: PRO_BACKGROUND_CUTOFF_MS },
        );
        res.end();
      }, remaining);
    }

    const { docIndex, docStore, folderPaths } = await buildProjectDocContext(
      projectId,
      userId,
      db,
    );
    streamDocIndex = docIndex;
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
      doc_id,
      filename: info.filename,
      folder_path: folderPaths.get(doc_id),
    }));

    const enrichedMessages = await enrichWithPriorEvents(
      streamMessages,
      chatId,
      db,
      docIndex,
    );
    const messagesForLLM: ChatMessage[] = displayed_doc
      ? enrichedMessages.map((m, i) => {
          if (i !== enrichedMessages.length - 1 || m.role !== "user") return m;
          return {
            ...m,
            content: `${m.content}\n\ndisplayed_doc: ${displayed_doc.filename}, displayed_doc_id: ${displayed_doc.document_id}`,
          };
        })
      : enrichedMessages;

    // The user-attached docs for this turn (dragged into / picked from
    // the chat input) come in as a request-level field. Surface them in
    // the system prompt with the current-turn doc_id slugs so the model
    // knows which docs the user is highlighting *now*, distinct from
    // the broader project doc list.
    let systemPromptExtra = PROJECT_SYSTEM_PROMPT_EXTRA;
    if (attached_documents?.length) {
      const slugByDocumentId = new Map<string, string>();
      for (const [slug, info] of Object.entries(docIndex)) {
        if (info.document_id) slugByDocumentId.set(info.document_id, slug);
      }
      const lines = attached_documents.map((d) => {
        const slug = slugByDocumentId.get(d.document_id);
        return slug ? `- ${slug}: ${d.filename}` : `- ${d.filename}`;
      });
      systemPromptExtra += `\n\nUSER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their latest message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join("\n")}`;
    }

    const { api_keys: apiKeys, legal_research_us: legalResearchUs } =
      await getUserModelSettings(userId, db);
    const apiMessages = buildMessages(
      messagesForLLM,
      docAvailability,
      systemPromptExtra,
      undefined,
      legalResearchUs,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    const { fullText, events } = await runLLMStream({
      apiMessages,
      docStore,
      docIndex,
      userId,
      userEmail,
      db,
      write: citationSse.write,
      extraTools: PROJECT_EXTRA_TOOLS,
      workflowStore,
      model: mainModelRequest.providerModel,
      reasoningEffort: mainModelRequest.reasoningEffort,
      reasoningMode: mainModelRequest.reasoningMode,
      modelResolution: {
        requestedModel: mainModelRequest.requestedModel,
        resolvedModel: mainModelRequest.providerModel,
        status: mainModelRequest.status,
      },
      apiKeys,
      includeResearchTools: legalResearchUs,
      chatId,
      assistantMessageId,
      assistantRunId: runPersistenceEnabled
        ? streamLifecycle.streamRequestId
        : null,
      onProviderRunProgress: persistProviderProgress,
      traceId: streamLifecycle.traceId,
      projectId,
      signal: streamAbort.signal,
    });
    throwIfAborted(streamAbort.signal);
    if (!events.length) {
      throw new Error("The provider returned an empty assistant response");
    }
    if (runPersistenceEnabled) {
      await claimBackgroundRunFinalization({
        providerStatus: "completed",
        errorCode: null,
        safeErrorMessage: null,
      });
      backgroundCompletionFinalizing = true;
    }
    const annotations = extractAnnotations(fullText, docIndex, events);
    const citations = extractRichCitations(fullText, docIndex, events);
    const assistantPayload = {
      content: events.length ? events : null,
      annotations: annotations.length ? annotations : null,
      citations: citations.length ? citations : null,
    };
    if (assistantMessageId) {
      const { data: savedMessage, error: saveError } = await db
        .from("chat_messages")
        .update(assistantPayload)
        .eq("id", assistantMessageId)
        .is("content", null)
        .select("id")
        .maybeSingle();
      if (saveError || !savedMessage) {
        throw new Error("Failed to save the assistant response");
      }
    } else {
      const { error: saveError } = await db.from("chat_messages").insert({
        chat_id: chatId,
        role: "assistant",
        ...assistantPayload,
      });
      if (saveError) {
        throw new Error("Failed to save the assistant response");
      }
    }
    if (assistantMessageId) {
      const approvalsReconciled =
        await reconcileMcpApprovalTerminalEventsForMessage({
          db,
          assistantMessageId,
          chatId,
        });
      if (!approvalsReconciled) {
        console.error(
          "[project-chat/stream] failed to reconcile MCP approval outcomes",
          { assistantMessageId, chatId },
        );
      }
    }

    if (!chatTitle && !isAskInputsContinuation && lastUser?.content) {
      await db
        .from("chats")
        .update({ title: lastUser.content.slice(0, 120) })
        .eq("id", chatId);
    }
    if (runPersistenceEnabled) {
      try {
        await updateBackgroundRunAsFinalizer({
          status: "completed",
          providerStatus: "completed",
          errorCode: null,
          safeErrorMessage: null,
          completedAt: new Date(),
        });
      } catch (error) {
        const current = await getAssistantBackgroundRunById(
          db,
          streamLifecycle.streamRequestId,
        );
        if (
          current?.status === "cancel_requested" ||
          current?.status === "cancelled"
        ) {
          streamLifecycle.abortCause = "explicit_user_cancel";
          const abortError = new Error("Stream aborted.");
          abortError.name = "AbortError";
          throw abortError;
        }
        console.error(
          "[project-chat/stream] failed to finalize background run",
          safeErrorLog(error),
        );
      }
    }
    if (!streamLifecycle.responseDetached) {
      citationSse.finish(
        citations,
        assistantStreamTerminalEvent(streamLifecycle, "completed"),
      );
    }
    clearProBackgroundTimer();
  } catch (err) {
    const handlerOwnedFinalization = backgroundCompletionFinalizing;
    clearProBackgroundTimer();
    let durableCancelRequested = false;
    if (runPersistenceEnabled) {
      try {
        const persisted = await getAssistantBackgroundRunById(
          db,
          streamLifecycle.streamRequestId,
        );
        durableCancelRequested =
          persisted?.status === "cancel_requested" ||
          persisted?.status === "cancelled";
        if (durableCancelRequested) {
          streamLifecycle.abortCause = "explicit_user_cancel";
        } else if (
          (persisted?.status === "finalizing" ||
            persisted?.status === "completed" ||
            persisted?.status === "failed" ||
            persisted?.status === "interrupted") &&
          persisted.finalizationOwner !== streamLifecycle.traceId
        ) {
          recoveryTakeoverDetected = true;
          streamLifecycle.abortCause = "provider_abort";
        }
      } catch (persistError) {
        console.error(
          "[project-chat/stream] failed to inspect durable cancellation",
          safeErrorLog(persistError),
        );
      }
    }
    if (recoveryTakeoverDetected) {
      logAssistantStreamLifecycle(
        streamLifecycle,
        "recovery_takeover_detected",
      );
      if (!streamLifecycle.responseDetached) {
        write(
          `data: ${JSON.stringify({
            type: "background_pending",
            message: "Another Docket worker is safely finishing this response.",
          })}\n\n`,
        );
        write(
          `data: ${JSON.stringify(
            assistantStreamTerminalEvent(
              streamLifecycle,
              "background_pending",
              { retryable: false, recoveryTakeover: true },
            ),
          )}\n\n`,
        );
        write("data: [DONE]\n\n");
      }
      return;
    }
    if (isAbortError(err) || durableCancelRequested) {
      let cause = assistantStreamAbortCause(streamLifecycle);
      let interruptionClaimed = false;
      if (runPersistenceEnabled && cause !== "explicit_user_cancel") {
        try {
          const interruptionUpdate = {
            providerStatus: null,
            errorCode: cause,
            safeErrorMessage:
              "The extended response was interrupted before it finished.",
          } satisfies Omit<UpdateAssistantBackgroundRunInput, "status">;
          if (handlerOwnedFinalization) {
            await updateBackgroundRunAsFinalizer({
              status: "finalizing",
              ...interruptionUpdate,
            });
          } else {
            await claimBackgroundRunFinalization(interruptionUpdate);
            backgroundCompletionFinalizing = true;
          }
          interruptionClaimed = true;
        } catch (persistError) {
          const current = await getAssistantBackgroundRunById(
            db,
            streamLifecycle.streamRequestId,
          );
          if (
            current?.status === "cancel_requested" ||
            current?.status === "cancelled"
          ) {
            cause = "explicit_user_cancel";
            streamLifecycle.abortCause = cause;
          } else {
            console.error(
              "[project-chat/stream] failed to claim interrupted run",
              safeErrorLog(persistError),
            );
          }
        }
      }
      logAssistantStreamLifecycle(streamLifecycle, "provider_aborted", {
        resolved_cause: cause,
      });
      const bufferedEvents =
        err instanceof AssistantStreamAbortError ? err.events : [];
      const partialEvents =
        cause === "explicit_user_cancel"
          ? appendCancellationMarker(bufferedEvents)
          : appendConnectionInterruptionMarker(bufferedEvents);
      const annotations =
        err instanceof AssistantStreamAbortError
          ? extractAnnotations(err.fullText, streamDocIndex, partialEvents)
          : [];
      const citations =
        err instanceof AssistantStreamAbortError
          ? extractRichCitations(err.fullText, streamDocIndex, partialEvents)
          : [];
      const assistantPayload = {
        content: partialEvents.length ? partialEvents : null,
        annotations: annotations.length ? annotations : null,
        citations: citations.length ? citations : null,
      };
      let interruptionMessagePersisted = false;
      if (
        assistantMessageId &&
        cause !== "explicit_user_cancel" &&
        interruptionClaimed
      ) {
        const { data: savedMessage, error: saveError } = await db
          .from("chat_messages")
          .update(assistantPayload)
          .eq("id", assistantMessageId)
          .is("content", null)
          .select("id")
          .maybeSingle();
        if (saveError || !savedMessage)
          console.error(
            "[project-chat/stream] failed to save cancelled assistant message",
            safeErrorLog(saveError),
          );
        else interruptionMessagePersisted = true;
      } else if (!assistantMessageId && interruptionClaimed) {
        const { error: saveError } = await db.from("chat_messages").insert({
          chat_id: chatId,
          role: "assistant",
          ...assistantPayload,
        });
        if (saveError)
          console.error(
            "[project-chat/stream] failed to save cancelled assistant message",
            safeErrorLog(saveError),
          );
        else interruptionMessagePersisted = true;
      }
      if (interruptionClaimed && interruptionMessagePersisted) {
        try {
          await updateBackgroundRunAsFinalizer({
            status: "interrupted",
            providerStatus: null,
            errorCode: cause,
            safeErrorMessage:
              "The extended response was interrupted before it finished.",
            completedAt: new Date(),
          });
        } catch (persistError) {
          console.error(
            "[project-chat/stream] failed to finalize interrupted run",
            safeErrorLog(persistError),
          );
        }
      }
      if (!streamLifecycle.responseDetached) {
        if (cause === "explicit_user_cancel") {
          write(
            `data: ${JSON.stringify({
              type: "cancellation_pending",
              message:
                "Cancellation requested. Docket is confirming provider shutdown.",
            })}\n\n`,
          );
        } else {
          write(
            `data: ${JSON.stringify({
              type: "error",
              code: "connection_interrupted",
              retryable: true,
              message:
                "The assistant stream was interrupted before it finished.",
            })}\n\n`,
          );
        }
        write(
          `data: ${JSON.stringify(
            assistantStreamTerminalEvent(
              streamLifecycle,
              cause === "explicit_user_cancel"
                ? "cancellation_pending"
                : "error",
              {
                retryable: cause !== "explicit_user_cancel",
                cancelling: cause === "explicit_user_cancel",
              },
            ),
          )}\n\n`,
        );
        write("data: [DONE]\n\n");
      }
      return;
    }
    console.error("[project-chat/stream] error:", safeErrorLog(err));
    const streamError = toChatStreamError(err);
    let failureClaimed = false;
    let cancellationWonFailureRace = false;
    if (runPersistenceEnabled) {
      try {
        const failureUpdate = {
          providerStatus: "failed",
          errorCode: streamError.code,
          safeErrorMessage: streamError.message,
        } satisfies Omit<UpdateAssistantBackgroundRunInput, "status">;
        if (handlerOwnedFinalization) {
          await updateBackgroundRunAsFinalizer({
            status: "finalizing",
            ...failureUpdate,
          });
        } else {
          await claimBackgroundRunFinalization(failureUpdate);
          backgroundCompletionFinalizing = true;
        }
        failureClaimed = true;
      } catch (persistError) {
        try {
          const current = await getAssistantBackgroundRunById(
            db,
            streamLifecycle.streamRequestId,
          );
          cancellationWonFailureRace =
            current?.status === "cancel_requested" ||
            current?.status === "cancelled";
          if (cancellationWonFailureRace) {
            streamLifecycle.abortCause = "explicit_user_cancel";
          }
        } catch (inspectError) {
          console.error(
            "[project-chat/stream] failed to inspect background failure race",
            safeErrorLog(inspectError),
          );
        }
        if (!cancellationWonFailureRace) {
          console.error(
            "[project-chat/stream] failed to claim background failure",
            safeErrorLog(persistError),
          );
        }
      }
    }
    let failureMessagePersisted = false;
    if (assistantMessageId && failureClaimed) {
      const { data: savedMessage, error: saveError } = await db
        .from("chat_messages")
        .update({
          content: [
            {
              type: "content",
              text: "The assistant failed before it could finish.",
            },
          ],
          annotations: null,
          citations: null,
        })
        .eq("id", assistantMessageId)
        .is("content", null)
        .select("id")
        .maybeSingle();
      if (saveError || !savedMessage) {
        console.error(
          "[project-chat/stream] failed to save background failure",
          safeErrorLog(saveError),
        );
      } else {
        failureMessagePersisted = true;
      }
    }
    if (failureClaimed && failureMessagePersisted) {
      try {
        await updateBackgroundRunAsFinalizer({
          status: "failed",
          providerStatus: "failed",
          errorCode: streamError.code,
          safeErrorMessage: streamError.message,
          completedAt: new Date(),
        });
      } catch (persistError) {
        console.error(
          "[project-chat/stream] failed to finalize background failure",
          safeErrorLog(persistError),
        );
      }
    }
    if (!streamLifecycle.responseDetached) {
      try {
        if (cancellationWonFailureRace) {
          write(
            `data: ${JSON.stringify({
              type: "cancellation_pending",
              message:
                "Cancellation requested. Docket is confirming provider shutdown.",
            })}\n\n`,
          );
        } else {
          write(chatStreamErrorLine(err));
        }
        write(
          `data: ${JSON.stringify(
            assistantStreamTerminalEvent(
              streamLifecycle,
              cancellationWonFailureRace ? "cancellation_pending" : "error",
              {
                retryable: !cancellationWonFailureRace,
                cancelling: cancellationWonFailureRace,
              },
            ),
          )}\n\n`,
        );
        write("data: [DONE]\n\n");
      } catch {
        /* ignore */
      }
    }
  } finally {
    clearAllBackgroundTimers();
    runFinished = true;
    unregisterAssistantStream(streamLifecycle);
    if (!res.writableEnded) res.end();
  }
});
