import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const backendRoot = new URL("..", import.meta.url).pathname;

function runHarness(root?: string) {
  return spawnSync(
    "./node_modules/.bin/tsx",
    ["scripts/assistant-runtime-check.ts", ...(root ? ["--root", root] : [])],
    {
      cwd: backendRoot,
      encoding: "utf8",
    },
  );
}

function writeFixtureFile(root: string, relativePath: string, source: string) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function writeRuntimeFixture(
  root: string,
  options: {
    frontendMainModels?: string[];
    geminiHonorsAbort?: boolean;
    includeCitationEvent?: boolean;
    includeClientErrorHandler?: boolean;
    preservePartialAbortEvents?: boolean;
    tabularCancellation?: boolean;
    tabularGenerationCleanup?: boolean;
    toolEventsBeforeAbortGuard?: boolean;
    openAiBulkAbortForwarding?: boolean;
    includeAskInputsServer?: boolean;
    includeAskInputsRouteResume?: boolean;
    includeAskInputsClientResume?: boolean;
    includeRichCitationContract?: boolean;
    includeTurnReadSuppression?: boolean;
  } = {},
) {
  const frontendMainModels = options.frontendMainModels ?? [
    "gpt-main",
    "claude-main",
    "gemini-main",
  ];
  const geminiAbortBody =
    options.geminiHonorsAbort === false
      ? "return result;"
      : 'if (params.abortSignal?.aborted) throw new Error("abort"); return result;';
  const citationEvent =
    options.includeCitationEvent === false
      ? ""
      : 'write(JSON.stringify({ type: "citations" }));';
  const clientErrorHandler =
    options.includeClientErrorHandler === false
      ? ""
      : 'if (data.type === "error") throw new Error("stream error");';
  const abortPersistence =
    options.preservePartialAbortEvents === false
      ? `
if (isAbortError(err)) {
  await db.from("chat_messages").update({
    content: [{ type: "content", text: "The assistant failed before it could finish." }],
  });
  return;
}
`
      : `
if (isAbortError(err)) {
  const partialEvents = appendCancellationMarker(
    err instanceof AssistantStreamAbortError ? err.events : [],
  );
  const assistantPayload = {
    content: partialEvents.length ? partialEvents : null,
  };
  await db.from("chat_messages").update(assistantPayload);
  return;
}
`;
  const askInputsPause =
    options.includeAskInputsServer === false
      ? ""
      : `
if (askInputsEvents.length > 0) {
  throw new AskInputsPauseError();
}
`;
  const toolEventCapture =
    options.toolEventsBeforeAbortGuard === false
      ? `
const { docsRead, askInputsEvents } = await runToolCalls(
  toolCalls,
  turnReadState,
);
throwIfAborted(signal);
for (const result of docsRead) events.push(result);
${askInputsPause}
return toolCalls.map((call) => call);
`
      : `
const { docsRead, askInputsEvents } = await runToolCalls(
  toolCalls,
  turnReadState,
);
for (const result of docsRead) events.push(result);
${askInputsPause}
throwIfAborted(signal);
return toolCalls.map((call) => call);
`;
  const tabularGenerateSetup =
    options.tabularCancellation === false
      ? ""
      : `
const streamAbort = new AbortController();
let streamFinished = false;
res.on("close", () => {
  if (!streamFinished) streamAbort.abort();
});
`;
  const tabularGenerateCall =
    options.tabularCancellation === false
      ? "await queryGeminiAllColumns({});"
      : "await queryGeminiAllColumns({ signal: streamAbort.signal });";
  const tabularChatSetup =
    options.tabularCancellation === false
      ? ""
      : `
const streamAbort = new AbortController();
let streamFinished = false;
res.on("close", () => {
  if (!streamFinished) streamAbort.abort();
});
`;
  const tabularChatCall =
    options.tabularCancellation === false
      ? "await runLLMStream({});"
      : "await runLLMStream({ signal: streamAbort.signal });";
  const tabularGenerationAbortCleanup =
    options.tabularGenerationCleanup === false
      ? `
if (isAbortError(err)) {
  write(chatStreamErrorLine(err));
  return;
}
`
      : `
if (isAbortError(err)) {
  await db
    .from("tabular_cells")
    .update({ status: "pending" })
    .eq("status", "generating");
  return;
}
`;
  const openAiBulkAbortSignal =
    options.openAiBulkAbortForwarding === false ? "" : "abortSignal: signal,";
  const askInputsToolDefinition =
    options.includeAskInputsServer === false
      ? ""
      : `
const ASK_INPUTS_TOOL = {
  type: "function",
  function: { name: "ask_inputs" },
};

class AskInputsPauseError extends Error {}
`;
  const askInputsDispatch =
    options.includeAskInputsServer === false
      ? ""
      : `
if (tc.function.name === "ask_inputs") {
  const event = normalizeAskInputsEvent(args);
  const persisted = await persistAskInputsRequest(db, { event });
  askInputsEvents.push(persisted.event);
  write(JSON.stringify(persisted.event));
  break;
}
`;
  const turnReadRuntime =
    options.includeTurnReadSuppression === false
      ? ""
      : `
export type TurnReadState = Map<string, { documentId?: string }>;
export async function getTurnReadIdentity() {
  return { key: "doc:version" };
}
export function duplicateReadDocumentResult(identity: unknown) {
  return JSON.stringify({ already_read: true, identity });
}
export function clearTurnReadsForDocument(
  turnReadState: TurnReadState | undefined,
  documentId: string,
) {
  turnReadState?.clear();
}
`;
  const turnReadToolBranches =
    options.includeTurnReadSuppression === false
      ? `
if (tc.function.name === "read_document") {
  await readDocumentContent();
} else if (tc.function.name === "find_in_document") {
  await findInDocumentContent();
} else if (tc.function.name === "fetch_documents") {
  await fetchDocumentContent();
} else if (tc.function.name === "list_workflows") {
  return [];
}
`
      : `
if (tc.function.name === "read_document") {
  const readIdentity = await getTurnReadIdentity();
  if (readIdentity && turnReadState?.has(readIdentity.key)) {
    return duplicateReadDocumentResult(readIdentity);
  }
  await readDocumentContent();
  turnReadState.set(readIdentity.key, readIdentity);
} else if (tc.function.name === "find_in_document") {
  await findInDocumentContent();
} else if (tc.function.name === "fetch_documents") {
  const readIdentity = await getTurnReadIdentity();
  if (readIdentity && turnReadState?.has(readIdentity.key)) {
    return duplicateReadDocumentResult(readIdentity);
  }
  await fetchDocumentContent();
  turnReadState.set(readIdentity.key, readIdentity);
} else if (tc.function.name === "list_workflows") {
  return [];
}
if (result.ok) {
  clearTurnReadsForDocument(
    turnReadState,
    indexed.document_id,
  );
}
`;
  const turnReadInitialization =
    options.includeTurnReadSuppression === false
      ? ""
      : "const turnReadState: TurnReadState = new Map();";
  const askInputsRuntime =
    options.includeAskInputsServer === false
      ? ""
      : `
const askInputsAvailable = Boolean(
  chatId && assistantMessageId && !tabularStore,
);
const activeTools = askInputsAvailable ? [ASK_INPUTS_TOOL] : [];
`;
  const richCitationRuntime =
    options.includeCitationEvent === false ||
    options.includeRichCitationContract === false
      ? ""
      : `
write(JSON.stringify({ type: "citations", status: "started", citations: [] }));
function streamPartialRichCitations() {
  write(JSON.stringify({ type: "citations", status: "partial", citations: [] }));
}
streamPartialRichCitations();
`;
  const askInputsRouteResume =
    options.includeAskInputsRouteResume === false
      ? ""
      : `
const parsedAskInputsResponse = parseAskInputsResponsePayload(
  body.ask_inputs_response,
);
if (parsedAskInputsResponse.response) {
  await consumeAskInputsResponse(db, {
    chatId,
    submittedByUserId: userId,
  });
}
`;
  const richCitationRouteSupport =
    options.includeRichCitationContract === false
      ? ""
      : `
const citationSse = createCitationSseBridge(write);
const citations = extractRichCitations(fullText);
citationSse.finish(citations);
`;
  const askInputsApiField =
    options.includeAskInputsClientResume === false
      ? ""
      : "ask_inputs_response?: DocketAskInputsResponse;";
  const askInputsClientRuntime =
    options.includeAskInputsClientResume === false
      ? ""
      : `
streamChat({ ask_inputs_response: opts?.askInputsResponse });
streamProjectChat({ ask_inputs_response: opts?.askInputsResponse });
if (data.type === "ask_inputs") {
  pushEvent({ type: "ask_inputs", request_id: data.request_id, items: data.items });
}
`;
  const richCitationClientRuntime =
    options.includeRichCitationContract === false
      ? ""
      : `
if (data.type === "case_citation") consumeCaseCitation(data);
if (data.status === "started" || data.status === "partial" || data.status === "final") {
  consumeCitationStatus(data.status);
}
`;
  const richCitationContracts =
    options.includeRichCitationContract === false
      ? 'export type CitationStreamStatus = "final";\n'
      : `
export type CitationStreamStatus = "started" | "partial" | "final";
export type DocumentCitationQuote = { sheet?: string; cell?: string };
export type ParsedCaseCitation = { kind: "case"; cluster_id: number };
export function citationSseEvent(status: CitationStreamStatus, citations: unknown[]) {
  return { type: "citations", status, citations };
}
export function createCitationSseBridge(write: (line: string) => void) {
  return {
    write(line: string, event: { status?: string }) {
      if (event.status === "started" || event.status === "partial") write(line);
    },
    finish(citations: unknown[]) {
      write(JSON.stringify(citationSseEvent("final", citations)));
    },
  };
}
`;
  const richCitationTypes =
    options.includeRichCitationContract === false
      ? "export type DocketCitation = { ref: number };\n"
      : `
export type DocketMessage = {
  citationStatus?: "started" | "partial" | "final";
};
export type DocketCitationAnnotation = {
  sheet?: string;
  cell?: string;
};
export type DocketCaseCitation = { kind: "case"; cluster_id: number };
`;

  writeFixtureFile(
    root,
    "backend/src/lib/llm/models.ts",
    `
export const CLAUDE_MAIN_MODELS = ["claude-main"] as const;
export const GEMINI_MAIN_MODELS = ["gemini-main"] as const;
export const OPENAI_MAIN_MODELS = ["gpt-main"] as const;
export const CLAUDE_MID_MODELS = ["claude-mid"] as const;
export const GEMINI_MID_MODELS = ["gemini-mid"] as const;
export const OPENAI_MID_MODELS = ["gpt-mid"] as const;
export const CLAUDE_LOW_MODELS = ["claude-low"] as const;
export const GEMINI_LOW_MODELS = ["gemini-low"] as const;
export const OPENAI_LOW_MODELS = ["gpt-low"] as const;
export const DEFAULT_MAIN_MODEL = "gpt-main";
export function providerForModel(model: string) {
  if (model.startsWith("claude")) return "claude";
  if (model.startsWith("gemini")) return "gemini";
  if (model.startsWith("gpt-")) return "openai";
}
`,
  );
  writeFixtureFile(
    root,
    "backend/src/lib/llm/types.ts",
    "export type StreamChatParams = { abortSignal?: AbortSignal };\n",
  );
  writeFixtureFile(
    root,
    "backend/src/lib/llm/index.ts",
    `
import { streamClaude } from "./claude";
import { streamGemini } from "./gemini";
import { streamOpenAI } from "./openai";
export async function streamChatWithTools(params: unknown) {
  if (provider === "claude") return streamClaude(params);
  if (provider === "openai") return streamOpenAI(params);
  return streamGemini(params);
}
export async function completeText(params: { abortSignal?: AbortSignal }) {
  return completeOpenAIText(params);
}
`,
  );
  writeFixtureFile(
    root,
    "backend/src/lib/llm/claude.ts",
    'export async function streamClaude(params: { abortSignal?: AbortSignal }) { params.abortSignal?.addEventListener("abort", () => undefined); }\n',
  );
  writeFixtureFile(
    root,
    "backend/src/lib/llm/openai.ts",
    `
export async function streamOpenAI(params: { abortSignal?: AbortSignal }) {
  return fetch("https://example.invalid", { signal: params.abortSignal });
}
export async function completeOpenAIText(params: { abortSignal?: AbortSignal }) {
  return createNonStreamingResponse({ abortSignal: params.abortSignal });
}
`,
  );
  writeFixtureFile(
    root,
    "backend/src/lib/llm/gemini.ts",
    `export async function streamGemini(params: { abortSignal?: AbortSignal }) { const result = {}; ${geminiAbortBody} }\n`,
  );
  writeFixtureFile(
    root,
    "backend/src/lib/chatTools.ts",
    `
${askInputsToolDefinition}
${turnReadRuntime}
export async function runToolCalls(toolCalls: unknown[], turnReadState: TurnReadState) {
  const askInputsEvents: unknown[] = [];
  for (const tc of toolCalls as any[]) {
    const args = {};
    ${askInputsDispatch}
    ${turnReadToolBranches}
  }
  return { docsRead: [], askInputsEvents };
}
export async function runLLMStream(params: { signal?: AbortSignal }) {
  write(JSON.stringify({ type: "content_delta" }));
  write(JSON.stringify({ type: "reasoning_delta" }));
  ${citationEvent}
  ${richCitationRuntime}
  write("data: [DONE]\\n\\n");
  const chatId = "chat-id";
  const assistantMessageId = "assistant-id";
  const tabularStore = null;
  ${askInputsRuntime}
  ${turnReadInitialization}
  runTools: async () => {
    ${toolEventCapture}
  };
  return streamChatWithTools({ abortSignal: params.signal }).catch((error) => {
    if (error instanceof AskInputsPauseError) {
      flushText();
      return;
    }
    throw error;
  });
}
`,
  );
  writeFixtureFile(
    root,
    "backend/src/routes/chat.ts",
    `
chatRouter.post("/", requireAuth, async (req, res) => {
const body = {};
const chatId = "chat-id";
const userId = "user-id";
const assistantMessageId = "assistant-id";
${askInputsRouteResume}
res.setHeader("Content-Type", "text/event-stream");
const streamAbort = new AbortController();
res.on("close", () => streamAbort.abort());
await runLLMStream({ assistantMessageId, signal: streamAbort.signal });
${richCitationRouteSupport}
catch (err) {
  ${abortPersistence}
  await db.from("chat_messages").update({
    content: [{ type: "content", text: "The assistant failed before it could finish." }],
  });
}
});
`,
  );
  writeFixtureFile(
    root,
    "backend/src/routes/projectChat.ts",
    `
projectChatRouter.post("/", requireAuth, async (req, res) => {
const body = {};
const chatId = "chat-id";
const userId = "user-id";
const assistantMessageId = "assistant-id";
${askInputsRouteResume}
res.setHeader("Content-Type", "text/event-stream");
const streamAbort = new AbortController();
res.on("close", () => streamAbort.abort());
await runLLMStream({ assistantMessageId, signal: streamAbort.signal });
${richCitationRouteSupport}
catch (err) {
  ${abortPersistence}
  await db.from("chat_messages").update({
    content: [{ type: "content", text: "The assistant failed before it could finish." }],
  });
}
});
`,
  );
  writeFixtureFile(
    root,
    "frontend/src/app/components/assistant/ModelToggle.tsx",
    `
export const MODELS = [
${frontendMainModels.map((id) => `  { id: "${id}" },`).join("\n")}
];
export const TABULAR_MODELS = [
  { id: "gpt-mid" },
  { id: "claude-mid" },
  { id: "gemini-mid" },
  { id: "claude-low" },
  { id: "gemini-low" },
  { id: "gpt-low" },
  { id: "gemini-main" },
];
export const DEFAULT_MODEL_ID = "gpt-main";
`,
  );
  writeFixtureFile(
    root,
    "backend/src/routes/tabular.ts",
    `
tabularRouter.post("/:reviewId/generate", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  ${tabularGenerateSetup}
  try {
    ${tabularGenerateCall}
  } catch (err) {
    ${tabularGenerationAbortCleanup}
  } finally {
    if (typeof streamFinished !== "undefined") streamFinished = true;
    res.end();
  }
});
tabularRouter.get("/:reviewId/chats", async () => {});
tabularRouter.post("/:reviewId/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  ${tabularChatSetup}
  try {
    ${tabularChatCall}
  } catch (err) {
    if (isAbortError(err)) {
      const partialEvents = appendCancellationMarker(
        err instanceof AssistantStreamAbortError ? err.events : [],
      );
      await db.from("tabular_review_chat_messages").insert({
        content: partialEvents.length ? partialEvents : null,
      });
      return;
    }
  } finally {
    if (typeof streamFinished !== "undefined") streamFinished = true;
    res.end();
  }
});
async function queryGeminiAllColumns(params: { signal?: AbortSignal }) {
  if (providerForModel(model) === "openai") {
    return completeText({
      maxTokens: 4096,
      ${openAiBulkAbortSignal}
    });
  }
  let contentBuffer = "";
  try {
    return await streamChatWithTools({ abortSignal: params.signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw err;
  }
}
`,
  );
  writeFixtureFile(
    root,
    "frontend/src/app/lib/docketApi.ts",
    `
type DocketAskInputsResponse = { request_id: string };
export async function streamChat(payload: {
  ${askInputsApiField}
  signal?: AbortSignal;
}) {
  const { signal } = payload;
  return fetch("/chat", { signal });
}
export async function streamProjectChat(payload: {
  ${askInputsApiField}
  signal?: AbortSignal;
}) {
  const { signal } = payload;
  return fetch("/projects/example/chat", { signal });
}
`,
  );
  writeFixtureFile(
    root,
    "frontend/src/app/hooks/useAssistantChat.ts",
    `
const controller = new AbortController();
streamChat({ signal: controller.signal });
if (data.type === "content_delta") consumeContent(data);
if (data.type === "reasoning_delta") consumeReasoning(data);
if (data.type === "citations") consumeCitations(data);
${clientErrorHandler}
${askInputsClientRuntime}
${richCitationClientRuntime}
if (dataStr === "[DONE]") completeStream();
`,
  );
  writeFixtureFile(
    root,
    "backend/src/lib/assistantContracts.ts",
    richCitationContracts,
  );
  writeFixtureFile(
    root,
    "frontend/src/app/components/shared/types.ts",
    richCitationTypes,
  );
  writeFixtureFile(
    root,
    "frontend/src/app/components/assistant/AssistantMessage.tsx",
    options.includeAskInputsClientResume === false
      ? "export function AssistantMessage() { return null; }\n"
      : `
export function AssistantMessage({ onAskInputsSubmit }: { onAskInputsSubmit?: unknown }) {
  if (event.type === "ask_inputs") {
    return <AskInputsPopup event={event} onSubmit={onAskInputsSubmit} />;
  }
  return null;
}
`,
  );
  writeFixtureFile(
    root,
    "frontend/src/app/components/assistant/AskInputsPopup.tsx",
    options.includeAskInputsClientResume === false
      ? "export function OtherPopup() { return null; }\n"
      : `
export function AskInputsPopup() {
  const response = { request_id: event.request_id };
  onSubmit(response);
  return null;
}
`,
  );
}

test("assistant-runtime-check validates this checkout without contacting services", () => {
  const result = runHarness();
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /assistant-runtime-contract: pass/);
  assert.match(output, /main model picker matches backend canonical models/);
  assert.match(output, /provider adapters honor AbortSignal/);
  assert.match(output, /SSE routes cancel provider work on disconnect/);
});

test("tabular picker exposes the backend-supported Gemini 3.1 Pro model", () => {
  const source = readFileSync(
    join(
      backendRoot,
      "../frontend/src/app/components/assistant/ModelToggle.tsx",
    ),
    "utf8",
  );

  const tabularModels = source.match(
    /export\s+const\s+TABULAR_MODELS\b[\s\S]*?=\s*\[([\s\S]*?)\];/,
  )?.[1];

  assert.ok(tabularModels, "TABULAR_MODELS should be defined");
  assert.match(
    tabularModels,
    /id:\s*"gemini-3\.1-pro-preview"[\s\S]*?label:\s*"Gemini 3\.1 Pro"[\s\S]*?group:\s*"Google"/,
  );
});

test("assistant-runtime-check reports a frontend model that has no backend runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, {
      frontendMainModels: [
        "gpt-main",
        "claude-main",
        "gemini-main",
        "gpt-not-configured",
      ],
    });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /main model picker matches backend canonical models: FAIL/,
    );
    assert.match(output, /gpt-not-configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects an adapter that declares but does not use AbortSignal", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { geminiHonorsAbort: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /provider adapters honor AbortSignal: FAIL/);
    assert.match(output, /gemini adapter/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects a server stream that omits citations", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { includeCitationEvent: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /SSE event protocol is complete: FAIL/);
    assert.match(output, /citations/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects a browser stream client that ignores error events", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { includeClientErrorHandler: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /SSE event protocol is complete: FAIL/);
    assert.match(output, /error/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects an abort path that overwrites partial events", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { preservePartialAbortEvents: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /cancelled stream persistence is safe: FAIL/);
    assert.match(output, /partial events/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects Tabular Review routes without close cancellation", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { tabularCancellation: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /Tabular Review SSE cancellation is complete: FAIL/);
    assert.match(output, /generate route/);
    assert.match(output, /chat route/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects Tabular Review generation that overwrites partial progress", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { tabularGenerationCleanup: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /Tabular Review generation abort cleanup is safe: FAIL/,
    );
    assert.match(output, /pending/);
    assert.match(output, /generating/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects an OpenAI bulk path that drops AbortSignal", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { openAiBulkAbortForwarding: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /Tabular Review provider cancellation paths are complete: FAIL/,
    );
    assert.match(output, /OpenAI bulk path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects a guard that drops completed tool events", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { toolEventsBeforeAbortGuard: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /completed tool events survive cancellation: FAIL/);
    assert.match(output, /before recording completed tool events/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime fixture satisfies the full expanded assistant contract", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root);
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.match(
      output,
      /Ask Inputs server pause and persistence contract is complete: PASS/,
    );
    assert.match(
      output,
      /Ask Inputs authenticated route and client resume contract is complete: PASS/,
    );
    assert.match(
      output,
      /rich citation streaming and locator contract is complete: PASS/,
    );
    assert.match(output, /turn-scoped document read suppression is safe: PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects an Ask Inputs tool that is not persisted and paused", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { includeAskInputsServer: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /Ask Inputs server pause and persistence contract is complete: FAIL/,
    );
    assert.match(output, /ask_inputs|Ask Inputs/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects an Ask Inputs route without authenticated resume", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { includeAskInputsRouteResume: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /Ask Inputs authenticated route and client resume contract is complete: FAIL/,
    );
    assert.match(output, /does not validate ask_inputs_response/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects a client that cannot display and submit Ask Inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { includeAskInputsClientResume: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /Ask Inputs authenticated route and client resume contract is complete: FAIL/,
    );
    assert.match(output, /does not accept an Ask Inputs continuation payload/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects citation streams without incremental locator and case support", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { includeRichCitationContract: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(
      output,
      /rich citation streaming and locator contract is complete: FAIL/,
    );
    assert.match(output, /citation/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-runtime-check rejects duplicate-read suppression without edit invalidation", () => {
  const root = mkdtempSync(join(tmpdir(), "docket-runtime-contract-"));
  try {
    writeRuntimeFixture(root, { includeTurnReadSuppression: false });
    const result = runHarness(root);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(output, /turn-scoped document read suppression is safe: FAIL/);
    assert.match(output, /read|edit/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
