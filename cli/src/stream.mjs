import { DocketApiError, fetchApi } from "./http.mjs";

export class AssistantStreamError extends Error {
  constructor(message, { status, chatId, runId } = {}) {
    super(message);
    this.name = "AssistantStreamError";
    this.status = status;
    this.chatId = chatId;
    this.runId = runId;
  }
}

export function chatHistoryMessages(chatDetail) {
  if (!Array.isArray(chatDetail?.messages)) {
    throw new DocketApiError("Chat detail has no messages array");
  }
  return chatDetail.messages.flatMap((row) => {
    if (row?.role === "user" && typeof row.content === "string") {
      return [{ role: "user", content: row.content }];
    }
    if (row?.role !== "assistant") return [];
    const text = Array.isArray(row.content)
      ? row.content.filter((event) => event?.type === "content" && typeof event.text === "string")
        .map((event) => event.text).join("")
      : typeof row.content === "string" ? row.content : "";
    return text ? [{ role: "assistant", content: text }] : [];
  });
}

function sseEvent(block) {
  const data = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  if (data === "[DONE]") return "done";
  try {
    return JSON.parse(data);
  } catch {
    throw new AssistantStreamError("Docket returned a malformed assistant stream event");
  }
}

export async function consumeAssistantStream(response) {
  if (!response.body) throw new AssistantStreamError("Docket returned an empty assistant stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let chatId = null;
  let runId = null;
  let status = null;
  let errorMessage = null;
  let requiredAction = null;
  let done = false;
  const deltas = [];
  const finalContent = [];

  function consume(block) {
    const event = sseEvent(block);
    if (!event) return;
    if (event === "done") {
      done = true;
      return;
    }
    if (event.type === "chat_id" && typeof event.chatId === "string") chatId = event.chatId;
    if (event.type === "stream_start" && typeof event.runId === "string") runId = event.runId;
    if (event.type === "content_delta" && typeof event.text === "string") deltas.push(event.text);
    if (event.type === "content" && typeof event.text === "string") finalContent.push(event.text);
    if (event.type === "error") {
      errorMessage = typeof event.message === "string" ? event.message
        : typeof event.detail === "string" ? event.detail : "Assistant response failed";
    }
    if (event.type === "background_pending") {
      errorMessage = typeof event.message === "string" ? event.message : "Assistant response is still running";
    }
    if (event.type === "ask_inputs") {
      requiredAction = "The assistant needs input in the Docket web app";
    }
    if (event.type === "mcp_tool_call" && event.status === "approval_required") {
      requiredAction = "A connector action needs approval in the Docket web app";
    }
    if (event.type === "stream_terminal" && typeof event.status === "string") {
      status = event.status;
      if (typeof event.runId === "string") runId = event.runId;
    }
  }

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      consume(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);

  if (status !== "completed" || !done) {
    const message = errorMessage || (status
      ? `Assistant stream ended with status ${status}`
      : "Assistant stream ended without a terminal status");
    throw new AssistantStreamError(message, { status, chatId, runId });
  }
  if (requiredAction) {
    throw new AssistantStreamError(requiredAction, { status: "action_required", chatId, runId });
  }
  if (!chatId) {
    throw new AssistantStreamError("Assistant stream completed without a chat ID", { status, runId });
  }
  return {
    chatId,
    runId,
    status,
    text: finalContent.length ? finalContent.join("") : deltas.join(""),
  };
}

export async function ask(config, auth, { prompt, chatId, projectId }, fetchImpl = fetch) {
  let messages = [];
  if (chatId) {
    const detail = await (await fetchApi(config, `/chat/${encodeURIComponent(chatId)}`, { auth, fetchImpl })).json();
    if (detail.active_run) {
      throw new AssistantStreamError("This chat has an active assistant run; wait for it to finish", { chatId });
    }
    const existingProjectId = detail.chat?.project_id || null;
    if (projectId && projectId !== existingProjectId) {
      throw new AssistantStreamError("--project does not match this chat", { chatId });
    }
    projectId = existingProjectId;
    messages = chatHistoryMessages(detail);
  }
  messages.push({ role: "user", content: prompt });
  const route = projectId
    ? `/projects/${encodeURIComponent(projectId)}/chat`
    : "/chat";
  const response = await fetchApi(config, route, {
    auth,
    fetchImpl,
    method: "POST",
    body: { messages, ...(chatId ? { chat_id: chatId } : {}) },
    accept: "text/event-stream",
  });
  return consumeAssistantStream(response);
}
