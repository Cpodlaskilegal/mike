import assert from "node:assert/strict";
import test from "node:test";
import { Models } from "@google/genai";

import { streamGemini } from "../src/lib/llm/gemini";
import type { OpenAIToolSchema } from "../src/lib/llm/types";

const models = ["gemini-3.1-pro-preview", "gemini-3-flash-preview"];

const readDocumentTool: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "read_document",
    description: "Read an attached document",
    parameters: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
};

function chunks(...values: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    yield* values;
  })();
}

function contentChunk(...parts: Record<string, unknown>[]): unknown {
  return { candidates: [{ content: { role: "model", parts } }] };
}

test("main Gemini models offer search, URL context, code execution, and Docket tools", async (t) => {
  const requests: Array<Record<string, any>> = [];
  t.mock.method(Models.prototype, "generateContentStreamInternal", async (request: any) => {
    requests.push(request);
    return chunks(contentChunk({ text: "Done." }));
  });

  for (const model of models) {
    const answer = await streamGemini({
      model,
      systemPrompt: "Be precise.",
      messages: [{ role: "user", content: "Research this." }],
      tools: [readDocumentTool],
      apiKeys: { gemini: "test-only" },
    });
    assert.equal(answer.fullText, "Done.");
  }

  assert.equal(requests.length, models.length);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.model, models[index]);
    assert.deepEqual(request.config.tools, [
      { googleSearch: {} },
      { urlContext: {} },
      { codeExecution: {} },
      {
        functionDeclarations: [{
          name: "read_document",
          description: "Read an attached document",
          parameters: readDocumentTool.function.parameters,
        }],
      },
    ]);
    assert.deepEqual(request.config.toolConfig, {
      includeServerSideToolInvocations: true,
    });
  }
});

test("Gemini receives original image, audio, video, and PDF bytes on the user turn", async (t) => {
  let request: Record<string, any> | undefined;
  t.mock.method(Models.prototype, "generateContentStreamInternal", async (input: any) => {
    request = input;
    return chunks(contentChunk({ text: "I can inspect all four." }));
  });

  await streamGemini({
    model: "gemini-3-flash-preview",
    systemPrompt: "Inspect media.",
    messages: [{
      role: "user",
      content: "Describe the attachments.",
      media: [
        { filename: "image.png", mimeType: "image/png", base64Data: "aW1hZ2U=" },
        { filename: "audio.mp3", mimeType: "audio/mpeg", base64Data: "YXVkaW8=" },
        { filename: "video.mp4", mimeType: "video/mp4", base64Data: "dmlkZW8=" },
        { filename: "brief.pdf", mimeType: "application/pdf", base64Data: "cGRm" },
      ],
    }],
    apiKeys: { gemini: "test-only" },
  });

  assert.deepEqual(request?.contents, [{
    role: "user",
    parts: [
      { text: "Describe the attachments." },
      { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
      { inlineData: { mimeType: "audio/mpeg", data: "YXVkaW8=" } },
      { inlineData: { mimeType: "video/mp4", data: "dmlkZW8=" } },
      { inlineData: { mimeType: "application/pdf", data: "cGRm" } },
    ],
  }]);
});

test("Gemini appends usable search and URL-context source links once", async (t) => {
  t.mock.method(Models.prototype, "generateContentStreamInternal", async () => chunks({
    candidates: [{
      content: { role: "model", parts: [{ text: "The answer." }] },
      groundingMetadata: { groundingChunks: [
        { web: { uri: "https://example.com/a", title: "Example A" } },
        { web: { uri: "https://example.com/a", title: "Duplicate" } },
        { retrievedContext: { uri: "javascript:alert(1)", title: "Unsafe" } },
      ] },
      urlContextMetadata: { urlMetadata: [
        { retrievedUrl: "https://example.org/brief.pdf", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" },
        { retrievedUrl: "https://example.net/fail", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR" },
      ] },
    }],
  }));
  const deltas: string[] = [];
  const result = await streamGemini({
    model: "gemini-3.1-pro-preview",
    systemPrompt: "Cite sources.",
    messages: [{ role: "user", content: "Search and read this PDF URL." }],
    callbacks: { onContentDelta: (text) => deltas.push(text) },
    apiKeys: { gemini: "test-only" },
  });

  assert.equal(result.fullText, [
    "The answer.",
    "",
    "Sources:",
    "1. [Duplicate](https://example.com/a)",
    "2. [example.org](https://example.org/brief.pdf)",
  ].join("\n"));
  assert.equal(deltas.join(""), result.fullText);
});

test("Gemini preserves built-in activity and thought signatures in a Docket function continuation", async (t) => {
  const requests: Array<Record<string, any>> = [];
  const modelParts = [
    { text: "I will inspect the source.", thoughtSignature: "sig_text" },
    { toolCall: { toolName: "googleSearch", args: { query: "court rules" } }, thoughtSignature: "sig_search" },
    { toolResponse: { toolName: "googleSearch", response: { snippet: "Result" } } },
    { executableCode: { language: "PYTHON", code: "print(1 + 1)" }, thoughtSignature: "sig_code" },
    { codeExecutionResult: { outcome: "OUTCOME_OK", output: "2" } },
    { functionCall: { id: "call_123", name: "read_document", args: { document_id: "doc_1" } }, thoughtSignature: "sig_function" },
  ];
  t.mock.method(Models.prototype, "generateContentStreamInternal", async (request: any) => {
    requests.push(request);
    return requests.length === 1
      ? chunks(contentChunk(...modelParts))
      : chunks(contentChunk({ text: "The document says two." }));
  });
  const toolCalls: unknown[] = [];
  const result = await streamGemini({
    model: "gemini-3.1-pro-preview",
    systemPrompt: "Answer with evidence.",
    messages: [{ role: "user", content: "Review doc_1." }],
    tools: [readDocumentTool],
    maxIterations: 2,
    runTools: async (calls) => {
      toolCalls.push(...calls);
      return [{ tool_use_id: "call_123", content: "Document text: two." }];
    },
    apiKeys: { gemini: "test-only" },
  });

  assert.deepEqual(toolCalls, [{
    id: "call_123", name: "read_document", input: { document_id: "doc_1" },
  }]);
  assert.equal(result.fullText, "I will inspect the source.The document says two.");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.contents, [
    { role: "user", parts: [{ text: "Review doc_1." }] },
    { role: "model", parts: modelParts },
    { role: "user", parts: [{ functionResponse: {
      id: "call_123", name: "read_document", response: { output: "Document text: two." },
    } }] },
  ]);
});

test("Gemini disables tools after the allowed function round and requires a final answer", async (t) => {
  const requests: Array<Record<string, any>> = [];
  t.mock.method(Models.prototype, "generateContentStreamInternal", async (request: any) => {
    requests.push(request);
    return requests.length === 1
      ? chunks(contentChunk({ functionCall: { name: "read_document", args: { document_id: "doc_1" } } }))
      : chunks(contentChunk({ text: "Final answer." }));
  });

  const result = await streamGemini({
    model: "gemini-3-flash-preview",
    systemPrompt: "Cite the record.",
    messages: [{ role: "user", content: "Read the record." }],
    tools: [readDocumentTool],
    maxIterations: 1,
    runTools: async () => [{ tool_use_id: "read_document-0", content: "Record text." }],
    apiKeys: { gemini: "test-only" },
  });

  assert.equal(result.fullText, "Final answer.");
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.config.tools, undefined);
  assert.equal(requests[1]?.config.toolConfig, undefined);
  assert.match(requests[1]?.config.systemInstruction, /FINAL RESPONSE REQUIRED/);
});
