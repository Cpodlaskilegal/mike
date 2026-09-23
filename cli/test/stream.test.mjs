import test from "node:test";
import assert from "node:assert/strict";
import { ask, AssistantStreamError, chatHistoryMessages, consumeAssistantStream } from "../src/stream.mjs";

function streamResponse(parts) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

test("assistant SSE requires completed terminal status and DONE across chunk boundaries", async () => {
  const response = streamResponse([
    'data: {"type":"chat_id","chatId":"c1"}\r',
    '\n\r\ndata: {"type":"content_delta","text":"Hello"}\r\n\r\n',
    'data: {"type":"content","text":"Hello"}\n\n',
    'data: {"type":"stream_terminal","status":"completed","runId":"r1"}\n\n',
    'data: [DONE]\n\n',
  ]);
  assert.deepEqual(await consumeAssistantStream(response), {
    chatId: "c1", runId: "r1", status: "completed", text: "Hello",
  });
});

test("assistant SSE rejects background pending with its chat ID", async () => {
  const response = streamResponse([
    'data: {"type":"chat_id","chatId":"c2"}\n\n',
    'data: {"type":"background_pending","message":"Still running"}\n\n',
    'data: {"type":"stream_terminal","status":"background_pending"}\n\n',
    'data: [DONE]\n\n',
  ]);
  await assert.rejects(consumeAssistantStream(response), (error) =>
    error instanceof AssistantStreamError &&
    error.status === "background_pending" &&
    error.chatId === "c2" &&
    error.message === "Still running");
});

test("assistant SSE rejects a truncated successful stream", async () => {
  const response = streamResponse([
    'data: {"type":"stream_terminal","status":"completed"}\n\n',
  ]);
  await assert.rejects(consumeAssistantStream(response), /Assistant stream ended/);
});

test("assistant SSE rejects completion without a chat ID", async () => {
  const response = streamResponse([
    'data: {"type":"stream_terminal","status":"completed"}\n\n',
    'data: [DONE]\n\n',
  ]);
  await assert.rejects(consumeAssistantStream(response), /without a chat ID/);
});

test("assistant SSE reports required web input even when the stream completes", async () => {
  for (const pendingEvent of [
    { type: "ask_inputs", request_id: "q1", items: [] },
    { type: "mcp_tool_call", status: "approval_required" },
  ]) {
    const response = streamResponse([
      'data: {"type":"chat_id","chatId":"c3"}\n\n',
      `data: ${JSON.stringify(pendingEvent)}\n\n`,
      'data: {"type":"stream_terminal","status":"completed"}\n\n',
      'data: [DONE]\n\n',
    ]);
    await assert.rejects(consumeAssistantStream(response), (error) =>
      error instanceof AssistantStreamError &&
      error.status === "action_required" &&
      error.chatId === "c3" &&
      error.message.includes("Docket web app"));
  }
});

test("ask uses project route and reconstructs existing chat history", async () => {
  const requests = [];
  const config = { apiBaseUrl: "https://example.test" };
  const auth = { token: async () => "test-token" };
  const result = await ask(config, auth, { prompt: "Next question", chatId: "c1" }, async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) {
      return Response.json({
        chat: { id: "c1", project_id: "p1" },
        messages: [
          { role: "user", content: "First question" },
          { role: "assistant", content: [{ type: "content", text: "First answer" }] },
        ],
        active_run: null,
      });
    }
    return streamResponse([
      'data: {"type":"chat_id","chatId":"c1"}\n\n',
      'data: {"type":"content_delta","text":"Next answer"}\n\n',
      'data: {"type":"stream_terminal","status":"completed"}\n\n',
      'data: [DONE]\n\n',
    ]);
  });
  assert.equal(requests[1].url, "https://example.test/projects/p1/chat");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    messages: [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Next question" },
    ],
    chat_id: "c1",
  });
  assert.equal(result.text, "Next answer");
  assert.deepEqual(chatHistoryMessages({ messages: [] }), []);
});
