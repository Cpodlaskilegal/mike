import { Router, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  buildDocContext,
  buildMessages,
  enrichWithPriorEvents,
  buildWorkflowStore,
  extractAnnotations,
  runLLMStream,
  type ChatMessage,
  type DocIndex,
} from "../lib/chatTools";
import {
  appendConnectionInterruptionMarker,
  appendCancellationMarker,
  AssistantStreamAbortError,
  completeText,
  isAbortError,
  parseMainModelRequest,
  throwIfAborted,
  type ProviderRunProgress,
} from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { chatStreamErrorLine, toChatStreamError } from "../lib/chatErrors";
import { safeErrorLog } from "../lib/safeError";
import { isAdminUser } from "../lib/userRoles";
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

export const chatRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};
const PRO_BACKGROUND_MESSAGE =
  "This extended response is still running in the background. Docket will refresh this chat when it finishes.";
const HYDRATABLE_ASSISTANT_RUN_STATUSES = [
  "starting",
  "queued",
  "in_progress",
  "background_pending",
  "cancel_requested",
  "running_tools",
] as const;

type AccessibleChat = {
  id: string;
  title: string | null;
  user_id: string;
  project_id: string | null;
} & Record<string, unknown>;

function createSafeStreamWriter(res: Response) {
  return (line: string) => {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(line);
    } catch (err) {
      devLog("[chat/stream] client write skipped", err);
    }
  };
}

function parseOptionalProjectId(
  value: unknown,
):
  | { ok: true; provided: boolean; projectId: string | null }
  | { ok: false; detail: string } {
  if (value === undefined)
    return { ok: true, provided: false, projectId: null };
  if (value === null) return { ok: true, provided: true, projectId: null };
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      detail: "project_id must be a non-empty string or null",
    };
  }
  return { ok: true, provided: true, projectId: value.trim() };
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

async function validateAccessibleProjectId(
  projectId: string | null,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  if (!projectId) return { ok: true };
  const access = await checkProjectAccess(projectId, userId, userEmail, db, {
    allowAdmin: true,
  });
  if (!access.ok)
    return { ok: false, status: 404, detail: "Project not found" };
  return { ok: true };
}

async function getAccessibleChat(
  chatId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
  options: { allowAdmin?: boolean } = {},
): Promise<AccessibleChat | null> {
  const { data: chat, error } = await db
    .from("chats")
    .select("*")
    .eq("id", chatId)
    .maybeSingle();
  if (error || !chat) return null;

  const row = chat as AccessibleChat;
  if (row.user_id === userId) return row;
  if (options.allowAdmin && (await isAdminUser(db, userId))) return row;

  if (row.project_id) {
    const access = await checkProjectAccess(
      row.project_id,
      userId,
      userEmail,
      db,
    );
    if (access.ok) return row;
  }

  return null;
}

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  if (await isAdminUser(db, userId)) {
    const { data, error } = await db
      .from("chats")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) return void res.status(500).json({ detail: error.message });
    return void res.json(data ?? []);
  }

  const { data: ownProjects, error: projErr } = await db
    .from("projects")
    .select("id")
    .eq("user_id", userId);
  if (projErr) return void res.status(500).json({ detail: projErr.message });
  const ownProjectIds = ((ownProjects ?? []) as { id: string }[]).map(
    (p) => p.id,
  );

  const filter =
    ownProjectIds.length > 0
      ? `user_id.eq.${userId},project_id.in.(${ownProjectIds.join(",")})`
      : `user_id.eq.${userId}`;

  const { data, error } = await db
    .from("chats")
    .select("*")
    .or(filter)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data ?? []);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const parsedProjectId = parseOptionalProjectId(req.body?.project_id);
  if (!parsedProjectId.ok) {
    return void res.status(400).json({ detail: parsedProjectId.detail });
  }
  const projectId = parsedProjectId.projectId;
  const db = createServerSupabase();
  const projectAccess = await validateAccessibleProjectId(
    projectId,
    userId,
    userEmail,
    db,
  );
  if (!projectAccess.ok)
    return void res
      .status(projectAccess.status)
      .json({ detail: projectAccess.detail });

  const { data, error } = await db
    .from("chats")
    .insert({ user_id: userId, project_id: projectId ?? null })
    .select("id")
    .single();

  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ id: data.id });
});

// GET /chat/runs/:streamRequestId — safe reconnect status for a durable
// assistant run. Provider identifiers stay server-side.
chatRouter.get("/runs/:streamRequestId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { streamRequestId } = req.params;
  if (!isAssistantStreamRequestId(streamRequestId)) {
    return void res
      .status(400)
      .json({ detail: "streamRequestId must be a UUID" });
  }
  const db = createServerSupabase();
  try {
    const run = await getAssistantBackgroundRunById(db, streamRequestId);
    if (!run) {
      return void res.status(404).json({ detail: "Run not found" });
    }
    const chat = await getAccessibleChat(run.chatId, userId, userEmail, db, {
      allowAdmin: true,
    });
    if (!chat) {
      return void res.status(404).json({ detail: "Run not found" });
    }
    res.json({
      run_id: run.streamRequestId,
      chat_id: run.chatId,
      assistant_message_id: run.assistantMessageId,
      project_id: run.projectId,
      status: run.status,
      provider_status: run.providerStatus,
      model: run.model,
      reasoning_mode: run.reasoningMode,
      reasoning_effort: run.reasoningEffort,
      trace_id: run.traceId,
      revision: run.revision,
      error_code: run.errorCode,
      message: run.safeErrorMessage,
      started_at: run.requestStartedAt,
      updated_at: run.updatedAt,
      completed_at: run.completedAt,
    });
  } catch (error) {
    console.error("[chat/run] failed to load run", safeErrorLog(error));
    res.status(500).json({ detail: "Failed to load assistant run" });
  }
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { chatId } = req.params;
  const db = createServerSupabase();

  const chat = await getAccessibleChat(chatId, userId, userEmail, db, {
    allowAdmin: true,
  });
  if (!chat) return void res.status(404).json({ detail: "Chat not found" });

  const { data: messages } = await db
    .from("chat_messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  // A page reload loses the browser's in-memory stream ID. Return only the
  // signed-in user's newest cancellable run for this chat so the frontend
  // can restore Stop without exposing another collaborator's run metadata.
  const { data: activeRun, error: activeRunError } = await db
    .from("assistant_background_runs")
    .select("stream_request_id, assistant_message_id, project_id, status")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .in("status", [...HYDRATABLE_ASSISTANT_RUN_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeRunError) {
    console.error(
      "[chat] failed to hydrate active assistant run",
      safeErrorLog(activeRunError),
    );
    return void res
      .status(500)
      .json({ detail: "Failed to load active assistant run" });
  }

  const activeAssistantMessageId = (
    activeRun as { assistant_message_id?: string } | null
  )?.assistant_message_id;
  const hasMatchingPlaceholder = (messages ?? []).some(
    (message) =>
      message.id === activeAssistantMessageId &&
      message.role === "assistant" &&
      message.content == null,
  );

  const hydrated = await hydrateEditStatuses(messages ?? [], db);
  res.json({
    chat,
    messages: hydrated,
    active_run: hasMatchingPlaceholder ? activeRun : null,
  });
});

// Stored message annotations/events capture the `status` at the time the
// assistant produced the edit (always "pending"). If the user later accepts
// or rejects, `document_edits.status` is updated but the stored message
// annotation is not. On chat load we merge the current DB status in so
// EditCards render with the real state.
async function hydrateEditStatuses(
  messages: Record<string, unknown>[],
  db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, unknown>[]> {
  const editIds = new Set<string>();
  const versionIds = new Set<string>();
  const collectFromAnnList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const a of list as Record<string, unknown>[]) {
      if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
      if (typeof a?.version_id === "string") versionIds.add(a.version_id);
    }
  };
  for (const m of messages) {
    collectFromAnnList(m.annotations);
    const content = m.content;
    if (Array.isArray(content)) {
      for (const ev of content as Record<string, unknown>[]) {
        if (ev?.type === "doc_edited") {
          collectFromAnnList(ev.annotations);
          if (typeof ev.version_id === "string") versionIds.add(ev.version_id);
        }
      }
    }
  }
  if (editIds.size === 0 && versionIds.size === 0) return messages;

  // Edit status patch.
  const statusById = new Map<string, "pending" | "accepted" | "rejected">();
  if (editIds.size > 0) {
    const { data: rows } = await db
      .from("document_edits")
      .select("id, status")
      .in("id", Array.from(editIds));
    for (const r of (rows ?? []) as { id: string; status: string }[]) {
      if (
        r.status === "pending" ||
        r.status === "accepted" ||
        r.status === "rejected"
      ) {
        statusById.set(r.id, r.status);
      }
    }
  }

  // Version-number patch — old stored events don't carry `version_number`
  // because they predate the schema change. Look it up from
  // document_versions so the UI can render "V3" chips + download filenames.
  const versionNumberById = new Map<string, number | null>();
  if (versionIds.size > 0) {
    const { data: vrows } = await db
      .from("document_versions")
      .select("id, version_number")
      .in("id", Array.from(versionIds));
    for (const r of (vrows ?? []) as {
      id: string;
      version_number: number | null;
    }[]) {
      versionNumberById.set(r.id, r.version_number ?? null);
    }
  }

  const patchAnnList = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list;
    return (list as Record<string, unknown>[]).map((a) => {
      let next = a;
      if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
        next = { ...next, status: statusById.get(a.edit_id) };
      }
      if (
        typeof a?.version_id === "string" &&
        versionNumberById.has(a.version_id)
      ) {
        next = {
          ...next,
          version_number: versionNumberById.get(a.version_id) ?? null,
        };
      }
      return next;
    });
  };
  return messages.map((m) => {
    const next: Record<string, unknown> = { ...m };
    next.annotations = patchAnnList(m.annotations);
    if (Array.isArray(m.content)) {
      next.content = (m.content as Record<string, unknown>[]).map((ev) => {
        if (ev?.type !== "doc_edited") return ev;
        let patched: Record<string, unknown> = {
          ...ev,
          annotations: patchAnnList(ev.annotations),
        };
        if (
          typeof ev.version_id === "string" &&
          versionNumberById.has(ev.version_id)
        ) {
          patched = {
            ...patched,
            version_number: versionNumberById.get(ev.version_id) ?? null,
          };
        }
        return patched;
      });
    }
    return next;
  });
}

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { chatId } = req.params;
  const title = (req.body.title ?? "").trim();
  if (!title) return void res.status(400).json({ detail: "title is required" });

  const db = createServerSupabase();
  const { data, error } = await db
    .from("chats")
    .update({ title })
    .eq("id", chatId)
    .eq("user_id", userId)
    .select("id, title")
    .single();

  if (error || !data)
    return void res.status(404).json({ detail: "Chat not found" });
  res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { chatId } = req.params;
  const db = createServerSupabase();
  const { error } = await db
    .from("chats")
    .delete()
    .eq("id", chatId)
    .eq("user_id", userId);

  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { chatId } = req.params;
  const message =
    typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message)
    return void res.status(400).json({ detail: "message is required" });

  const db = createServerSupabase();
  const chat = await getAccessibleChat(chatId, userId, userEmail, db);
  if (!chat) return void res.status(404).json({ detail: "Chat not found" });

  try {
    const { title_model, api_keys } = await getUserModelSettings(userId, db);
    const titleText = await completeText({
      model: title_model,
      user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. Return only the title, no quotes or punctuation.\n\nMessage: ${message.slice(0, 500)}`,
      maxTokens: 64,
      apiKeys: api_keys,
      reasoningEffort: "none",
      textVerbosity: "low",
      aiObservability: {
        distinctId: userId,
        sessionId: chatId,
        spanName: "Generate chat title",
        route: "chat_title",
        chatId,
      },
    });
    const title = titleText.trim() || message.slice(0, 60);

    await db.from("chats").update({ title }).eq("id", chatId);

    res.json({ title });
  } catch (err) {
    console.error("[generate-title]", safeErrorLog(err));
    res.status(500).json({ detail: "Failed to generate title" });
  }
});

// POST /chat/cancel — explicit, authenticated user cancellation.
chatRouter.post("/cancel", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const streamRequestId = req.body?.stream_request_id;
  if (!isAssistantStreamRequestId(streamRequestId)) {
    return void res
      .status(400)
      .json({ detail: "stream_request_id must be a UUID" });
  }
  const db = createServerSupabase();
  try {
    let persisted = await getAssistantBackgroundRunById(db, streamRequestId);
    if (persisted && persisted.userId !== userId) persisted = null;
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
        if (!current || current.userId !== userId) persisted = null;
        else if (current.status === "cancel_requested") {
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
      route: "chat",
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
            "[chat/cancel] provider cancellation failed",
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
    console.error("[chat/cancel] cancellation failed", safeErrorLog(error));
    res.status(500).json({
      detail: "Docket could not confirm the cancellation request",
    });
  }
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
  const requestStartedAt = Date.now();
  const userId = res.locals.userId as string;
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
  const parsedProjectId = parseOptionalProjectId(body.project_id);
  if (!parsedProjectId.ok) {
    return void res.status(400).json({ detail: parsedProjectId.detail });
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
  const parsedMainModel = parseMainModelRequest(req.body);
  if (!parsedMainModel.ok) {
    return void res.status(400).json({ detail: parsedMainModel.detail });
  }
  const mainModelRequest = parsedMainModel.value;

  const messages = parsedMessages.messages;
  const chat_id = parsedChatId.chatId;
  const project_id = parsedProjectId.projectId;

  devLog("[chat/stream] incoming request", {
    userId,
    chat_id,
    project_id,
    requestedModel: mainModelRequest.requestedModel,
    resolvedModel: mainModelRequest.providerModel,
    modelResolutionStatus: mainModelRequest.status,
    messageCount: messages?.length,
  });

  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  let chatId = chat_id ?? null;
  let chatTitle: string | null = null;
  let resolvedProjectId: string | null = parsedProjectId.projectId;

  if (chatId) {
    const existing = await getAccessibleChat(chatId, userId, userEmail, db, {
      allowAdmin: true,
    });
    if (!existing)
      return void res.status(404).json({ detail: "Chat not found" });

    const existingProjectId = existing.project_id ?? null;
    if (
      parsedProjectId.provided &&
      parsedProjectId.projectId !== existingProjectId
    ) {
      return void res
        .status(400)
        .json({ detail: "project_id does not match chat" });
    }
    resolvedProjectId = existingProjectId;
    chatTitle = existing.title;
  }

  if (!chatId) {
    // If creating a chat tied to a project, the user must have access
    // to the project (own or shared).
    const projectAccess = await validateAccessibleProjectId(
      resolvedProjectId,
      userId,
      userEmail,
      db,
    );
    if (!projectAccess.ok)
      return void res
        .status(projectAccess.status)
        .json({ detail: projectAccess.detail });

    const { data: newChat, error } = await db
      .from("chats")
      .insert({ user_id: userId, project_id: resolvedProjectId })
      .select("id, title")
      .single();
    if (error || !newChat) {
      console.error("[chat/stream] failed to create chat", safeErrorLog(error));
      return void res.status(500).json({ detail: "Failed to create chat" });
    }
    chatId = newChat.id as string;
    chatTitle = newChat.title;
  }

  devLog("[chat/stream] resolved chatId", chatId);

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
    projectId: resolvedProjectId,
    route: "chat",
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
        projectId: resolvedProjectId,
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
        "[chat/stream] failed to create background run",
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
            "[chat/stream] background monitor failed",
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
              "[chat/stream] failed to persist background handoff",
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

    const { docIndex, docStore } = await buildDocContext(
      streamMessages,
      userId,
      db,
      chatId,
    );
    streamDocIndex = docIndex;
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
      doc_id,
      filename: info.filename,
    }));
    const enrichedMessages = await enrichWithPriorEvents(
      streamMessages,
      chatId,
      db,
      docIndex,
    );
    const { api_keys: apiKeys, legal_research_us: legalResearchUs } =
      await getUserModelSettings(userId, db);
    const apiMessages = buildMessages(
      enrichedMessages,
      docAvailability,
      undefined,
      undefined,
      legalResearchUs,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    devLog("[chat/stream] starting LLM stream", {
      apiMessageCount: apiMessages.length,
      docCount: Object.keys(docIndex).length,
      workflowCount: Object.keys(workflowStore).length,
    });

    const { fullText, events } = await runLLMStream({
      apiMessages,
      docStore,
      docIndex,
      userId,
      userEmail,
      db,
      write: citationSse.write,
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
      projectId: resolvedProjectId,
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
    devLog("[chat/stream] LLM stream finished", {
      fullTextLen: fullText?.length ?? 0,
      eventCount: events?.length ?? 0,
    });

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
          "[chat/stream] failed to reconcile MCP approval outcomes",
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
          "[chat/stream] failed to finalize background run",
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
          "[chat/stream] failed to inspect durable cancellation",
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
              "[chat/stream] failed to claim interrupted run",
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
            "[chat/stream] failed to save cancelled assistant message",
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
            "[chat/stream] failed to save cancelled assistant message",
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
            "[chat/stream] failed to finalize interrupted run",
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
    console.error("[chat/stream] error:", safeErrorLog(err));
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
            "[chat/stream] failed to inspect background failure race",
            safeErrorLog(inspectError),
          );
        }
        if (!cancellationWonFailureRace) {
          console.error(
            "[chat/stream] failed to claim background failure",
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
          "[chat/stream] failed to save background failure",
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
          "[chat/stream] failed to finalize background failure",
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
