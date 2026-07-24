import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
};

type StringArrayRead = {
  values: string[];
  error?: string;
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptDirectory, "../..");
const expectedOpenAiMainModels = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;
const expectedDefaultMainModel = "gpt-5.6-sol";

function readSource(
  root: string,
  relativePath: string,
): {
  source: string;
  error?: string;
} {
  try {
    return { source: readFileSync(resolve(root, relativePath), "utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      source: "",
      error: `${relativePath} could not be read (${message})`,
    };
  }
}

function readConstStringArray(source: string, name: string): StringArrayRead {
  const match = source.match(
    new RegExp(
      `export\\s+const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`,
      "m",
    ),
  );
  if (!match) {
    return { values: [], error: `${name} was not found` };
  }
  return {
    values: Array.from(
      match[1].matchAll(/["']([^"']+)["']/g),
      (entry) => entry[1],
    ),
  };
}

function readModelOptions(source: string, name: string): StringArrayRead {
  const match = source.match(
    new RegExp(
      `export\\s+const\\s+${name}\\b[\\s\\S]*?=\\s*\\[([\\s\\S]*?)\\];`,
      "m",
    ),
  );
  if (!match) {
    return { values: [], error: `${name} was not found` };
  }
  return {
    values: Array.from(
      match[1].matchAll(/\bid\s*:\s*["']([^"']+)["']/g),
      (entry) => entry[1],
    ),
  };
}

function readStringConstant(source: string, name: string): string | null {
  const match = source.match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*["']([^"']+)["']`),
  );
  return match?.[1] ?? null;
}

function setDifference(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => !rightSet.has(value)))].sort();
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicateValues = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    seen.add(value);
  }
  return [...duplicateValues].sort();
}

function describeSetMismatch(
  expected: readonly string[],
  actual: readonly string[],
): string | undefined {
  const missing = setDifference(expected, actual);
  const unexpected = setDifference(actual, expected);
  const repeated = duplicates(actual);
  const details = [
    missing.length ? `missing: ${missing.join(", ")}` : "",
    unexpected.length ? `unexpected: ${unexpected.join(", ")}` : "",
    repeated.length ? `duplicates: ${repeated.join(", ")}` : "",
  ].filter(Boolean);
  return details.length ? details.join("; ") : undefined;
}

function hasAbortSignalUse(source: string): boolean {
  const capturesSignal =
    /\bparams\.abortSignal\b/.test(source) ||
    /\{[^}]*\babortSignal\b[^}]*\}\s*=\s*params/.test(source) ||
    /function\s+\w+\s*\(\s*\{[^}]*\babortSignal\b/.test(source);
  const connectsSignal =
    /\bsignal\s*:\s*(?:params\.)?abortSignal\b/.test(source) ||
    /\babortSignal\s*\?\.\s*addEventListener\s*\(\s*["']abort["']/.test(
      source,
    ) ||
    /\b(?:params\.)?abortSignal\s*\?\.\s*aborted\b/.test(source) ||
    /throwIfAborted\s*\(\s*(?:params\.)?abortSignal\s*\)/.test(source);
  return capturesSignal && connectsSignal;
}

function routeCancelsProviderWork(source: string): boolean {
  if (!/text\/event-stream/.test(source)) return false;
  const controller = source.match(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+AbortController\s*\(\s*\)/,
  )?.[1];
  if (!controller) return false;
  const escapedController = controller.replace(/[$]/g, "\\$");
  const closeHandler = new RegExp(
    `res\\.on\\(\\s*["']close["'][\\s\\S]*?${escapedController}\\.abort\\s*\\(`,
  );
  const forwardsSignal = new RegExp(
    `runLLMStream\\s*\\(\\s*\\{[\\s\\S]*?\\bsignal\\s*:\\s*${escapedController}\\.signal\\b`,
  );
  return closeHandler.test(source) && forwardsSignal.test(source);
}

function cancelledStreamPersistenceProblems(source: string): string[] {
  const abortCondition = source.indexOf("isAbortError(err)");
  const abortBranchStart =
    abortCondition >= 0 ? source.lastIndexOf("if (", abortCondition) : -1;
  if (abortBranchStart < 0) {
    return ["does not recognize isAbortError(err)"];
  }
  const abortBranchEnd = source.indexOf("return;", abortBranchStart);
  if (abortBranchEnd < 0) {
    return ["does not return after persisting the cancelled turn"];
  }
  const abortBranch = source.slice(
    abortBranchStart,
    abortBranchEnd + "return;".length,
  );
  const problems: string[] = [];
  if (!abortBranch.includes("AssistantStreamAbortError")) {
    problems.push("does not recognize AssistantStreamAbortError");
  }
  if (!abortBranch.includes("appendCancellationMarker")) {
    problems.push("does not add a cancellation marker");
  }
  if (
    !/err\s+instanceof\s+AssistantStreamAbortError\s*\?\s*err\.events\s*:\s*\[\]/.test(
      abortBranch,
    )
  ) {
    problems.push("does not retain AssistantStreamAbortError partial events");
  }
  if (
    !/content\s*:\s*partialEvents\.length\s*\?\s*partialEvents\s*:\s*null/.test(
      abortBranch,
    )
  ) {
    problems.push("does not persist the partial events payload");
  }
  if (abortBranch.includes("The assistant failed before it could finish.")) {
    problems.push("overwrites the partial events with generic failure content");
  }
  return problems;
}

function sourceSection(
  source: string,
  startMarker: string,
  endMarkers: string[],
): string {
  const start = source.indexOf(startMarker);
  if (start < 0) return "";
  const end = endMarkers
    .map((marker) => source.indexOf(marker, start + startMarker.length))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  return source.slice(start, end === undefined ? undefined : end);
}

function sseRouteCancellationProblems(
  source: string,
  operation: "runLLMStream" | "queryGeminiAllColumns",
): string[] {
  if (!source) return ["route was not found"];
  const problems: string[] = [];
  if (!/text\/event-stream/.test(source)) {
    problems.push("does not set the SSE content type");
  }
  const controller = source.match(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+AbortController\s*\(\s*\)/,
  )?.[1];
  if (!controller) {
    problems.push("does not create an AbortController");
    return problems;
  }
  const escapedController = controller.replace(/[$]/g, "\\$");
  const closeHandler = new RegExp(
    `res\\.on\\(\\s*["']close["'][\\s\\S]*?${escapedController}\\.abort\\s*\\(`,
  );
  if (!closeHandler.test(source)) {
    problems.push("does not abort on res.close");
  }
  const operationStart = source.indexOf(`${operation}(`);
  if (operationStart < 0) {
    problems.push(`does not call ${operation}`);
  } else {
    const operationSource = source.slice(operationStart);
    const passesSignal =
      operation === "runLLMStream"
        ? new RegExp(`\\bsignal\\s*:\\s*${escapedController}\\.signal\\b`).test(
            operationSource,
          )
        : new RegExp(`${escapedController}\\.signal\\b`).test(operationSource);
    if (!passesSignal) {
      problems.push(`does not forward ${controller}.signal to ${operation}`);
    }
  }
  return problems;
}

function tabularChatPartialPersistenceProblems(source: string): string[] {
  const problems = cancelledStreamPersistenceProblems(source);
  const abortBranchStart = source.indexOf("if (isAbortError(err))");
  const abortBranchEnd = source.indexOf("return;", abortBranchStart);
  const abortBranch =
    abortBranchStart >= 0 && abortBranchEnd >= 0
      ? source.slice(abortBranchStart, abortBranchEnd + "return;".length)
      : "";
  if (
    !/from\(\s*["']tabular_review_chat_messages["']\s*\)\s*\.insert/.test(
      abortBranch,
    )
  ) {
    problems.push(
      "does not persist partial events to tabular_review_chat_messages",
    );
  }
  return problems;
}

function tabularGenerationAbortCleanupProblems(
  routeSource: string,
  querySource: string,
): string[] {
  const problems: string[] = [];
  const abortCondition = routeSource.lastIndexOf("isAbortError(err)");
  const abortBranchStart =
    abortCondition >= 0 ? routeSource.lastIndexOf("if (", abortCondition) : -1;
  const abortBranchEnd = routeSource.indexOf("return;", abortBranchStart);
  const abortBranch =
    abortBranchStart >= 0 && abortBranchEnd >= 0
      ? routeSource.slice(abortBranchStart, abortBranchEnd + "return;".length)
      : "";
  if (!abortBranch) {
    problems.push("generate route does not handle an abort separately");
  } else {
    const cleanupSource = abortBranch.includes("resetCancelledCells")
      ? routeSource
      : abortBranch;
    if (!/from\(\s*["']tabular_cells["']\s*\)/.test(cleanupSource)) {
      problems.push("generate route does not reset incomplete tabular cells");
    }
    if (!/status\s*:\s*["']pending["']/.test(cleanupSource)) {
      problems.push(
        "generate route does not reset incomplete cells to pending",
      );
    }
    if (
      !/eq\(\s*["']status["']\s*,\s*["']generating["']\s*\)/.test(cleanupSource)
    ) {
      problems.push(
        "generate route does not preserve completed cells by filtering generating cells",
      );
    }
    if (abortBranch.includes("chatStreamErrorLine")) {
      problems.push("generate route emits a generic error SSE for an abort");
    }
  }
  if (!/\bsignal\s*\??\s*:\s*AbortSignal\b/.test(querySource)) {
    problems.push("queryGeminiAllColumns does not accept an AbortSignal");
  }
  if (!/\babortSignal\s*:\s*(?:params\.)?signal\b/.test(querySource)) {
    problems.push(
      "queryGeminiAllColumns does not forward the AbortSignal to the provider",
    );
  }
  if (
    !/if\s*\(\s*(?:signal\?\.aborted\s*\|\|\s*)?isAbortError\(err\)\s*\)\s*throw\s+err/.test(
      querySource,
    )
  ) {
    problems.push("queryGeminiAllColumns does not rethrow provider aborts");
  }
  return problems;
}

function completedToolEventCancellationProblems(source: string): string[] {
  const toolCallStart = source.indexOf("await runToolCalls(");
  if (toolCallStart < 0) return ["runLLMStream does not call runToolCalls"];
  const toolCallEnd = source.indexOf(");", toolCallStart);
  if (toolCallEnd < 0) return ["runToolCalls completion was not found"];
  const toolResultReturn = source.indexOf("return toolCalls.map", toolCallEnd);
  if (toolResultReturn < 0) {
    return ["runTools does not return tool results after recording events"];
  }
  const firstCompletedEvent = source.indexOf("events.push", toolCallEnd);
  const lastCompletedEvent = source.lastIndexOf(
    "events.push",
    toolResultReturn,
  );
  if (
    firstCompletedEvent < 0 ||
    firstCompletedEvent > toolResultReturn ||
    lastCompletedEvent < toolCallEnd
  ) {
    return ["runTools does not record completed tool events"];
  }
  const abortGuard = source.indexOf("throwIfAborted(signal)", toolCallEnd);
  if (abortGuard >= 0 && abortGuard < lastCompletedEvent) {
    return ["runTools throws before recording completed tool events"];
  }
  return [];
}

function tabularProviderCancellationProblems(
  querySource: string,
  llmIndexSource: string,
  openAiSource: string,
): string[] {
  const problems: string[] = [];
  const openAiBulkSource = sourceSection(
    querySource,
    'if (providerForModel(model) === "openai")',
    ["let contentBuffer"],
  );
  if (!openAiBulkSource.includes("completeText")) {
    problems.push("OpenAI bulk path does not use completeText");
  }
  if (!/\bmaxTokens\s*:\s*4096\b/.test(openAiBulkSource)) {
    problems.push("OpenAI bulk path does not preserve maxTokens: 4096");
  }
  if (!/\babortSignal\s*:\s*(?:params\.)?signal\b/.test(openAiBulkSource)) {
    problems.push(
      "OpenAI bulk path does not forward AbortSignal to completeText",
    );
  }
  if (
    !/streamChatWithTools\s*\([\s\S]*?\babortSignal\s*:\s*(?:params\.)?signal\b/.test(
      querySource,
    )
  ) {
    problems.push(
      "streaming bulk path does not forward AbortSignal to streamChatWithTools",
    );
  }
  if (
    !/export\s+async\s+function\s+completeText\s*\(\s*params\s*:\s*\{[\s\S]*?\babortSignal\?\s*:\s*AbortSignal\b/.test(
      llmIndexSource,
    )
  ) {
    problems.push("completeText does not accept AbortSignal");
  }
  const completeOpenAiSource = functionSource(
    openAiSource,
    "completeOpenAIText",
  );
  if (!/\babortSignal\?\s*:\s*AbortSignal\b/.test(completeOpenAiSource)) {
    problems.push("completeOpenAIText does not accept AbortSignal");
  }
  if (!/\babortSignal\s*:\s*params\.abortSignal\b/.test(completeOpenAiSource)) {
    problems.push(
      "completeOpenAIText does not forward AbortSignal to the non-streaming request",
    );
  }
  return problems;
}

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  if (start < 0) return "";
  const next = source.indexOf("export async function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function mainAssistantRouteResolutionProblems(
  source: string,
  routeName: string,
): string[] {
  const problems: string[] = [];
  const parseMatch = source.match(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*parseMainModelRequest\(\s*req\.body\s*\)/,
  );
  if (!parseMatch || parseMatch.index === undefined) {
    return [`${routeName} route does not parse the raw request body`];
  }

  const parsedName = parseMatch[1];
  const escapedParsedName = parsedName.replace(/[$]/g, "\\$");
  const parseIndex = parseMatch.index;
  const handlerStart = Math.max(
    source.lastIndexOf('.post("/", requireAuth', parseIndex),
    source.lastIndexOf(".post('/', requireAuth", parseIndex),
    0,
  );
  const placeholderMatch = source
    .slice(handlerStart)
    .match(
      /from\(\s*["']chat_messages["']\s*\)[\s\S]*?\.insert\(\s*\{[\s\S]*?role\s*:\s*["']assistant["']/,
    );
  const placeholderIndex =
    placeholderMatch?.index === undefined
      ? -1
      : handlerStart + placeholderMatch.index;
  const sseHeaderIndex = source.indexOf("res.setHeader", handlerStart);
  const flushIndex = source.indexOf("res.flushHeaders()", handlerStart);

  if (placeholderIndex < 0) {
    problems.push(
      `${routeName} route does not persist an assistant placeholder`,
    );
  } else if (parseIndex > placeholderIndex) {
    problems.push(`${routeName} route parses after the assistant placeholder`);
  }
  if (sseHeaderIndex < 0 || flushIndex < 0) {
    problems.push(
      `${routeName} route does not configure and flush SSE headers`,
    );
  } else if (parseIndex > sseHeaderIndex || parseIndex > flushIndex) {
    problems.push(`${routeName} route parses after SSE begins`);
  }

  const validationEndCandidates = [placeholderIndex, sseHeaderIndex, flushIndex]
    .filter((index) => index > parseIndex)
    .sort((left, right) => left - right);
  const validationSource = source.slice(
    parseIndex,
    validationEndCandidates[0] ?? undefined,
  );
  const rejectsInvalidRequest = new RegExp(
    `if\\s*\\(\\s*!${escapedParsedName}\\.ok\\s*\\)[\\s\\S]*?status\\(\\s*400\\s*\\)[\\s\\S]*?json\\(\\s*\\{\\s*detail\\s*:\\s*${escapedParsedName}\\.detail\\s*\\}\\s*\\)`,
  );
  if (!rejectsInvalidRequest.test(validationSource)) {
    problems.push(
      `${routeName} route does not return safe HTTP 400 JSON for an invalid main request`,
    );
  }

  const resolvedMatch = validationSource.match(
    new RegExp(
      `const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapedParsedName}\\.value`,
    ),
  );
  const runCallStart = source.indexOf("runLLMStream({", parseIndex);
  const runCallEnd =
    runCallStart < 0 ? -1 : source.indexOf("});", runCallStart);
  if (!resolvedMatch || runCallStart < 0 || runCallEnd < 0) {
    problems.push(
      `${routeName} route does not pass the resolved request into runLLMStream`,
    );
    return problems;
  }

  const resolvedName = resolvedMatch[1];
  const escapedResolvedName = resolvedName.replace(/[$]/g, "\\$");
  const runCall = source.slice(runCallStart, runCallEnd + 3);
  const requiredFields = [
    ["provider model", `model\\s*:\\s*${escapedResolvedName}\\.providerModel`],
    [
      "reasoning effort",
      `reasoningEffort\\s*:\\s*${escapedResolvedName}\\.reasoningEffort`,
    ],
    [
      "reasoning mode",
      `reasoningMode\\s*:\\s*${escapedResolvedName}\\.reasoningMode`,
    ],
    [
      "resolution metadata",
      `modelResolution\\s*:\\s*\\{[\\s\\S]*?requestedModel\\s*:\\s*${escapedResolvedName}\\.requestedModel[\\s\\S]*?resolvedModel\\s*:\\s*${escapedResolvedName}\\.providerModel[\\s\\S]*?status\\s*:\\s*${escapedResolvedName}\\.status[\\s\\S]*?\\}`,
    ],
  ] as const;
  for (const [label, pattern] of requiredFields) {
    if (!new RegExp(pattern).test(runCall)) {
      problems.push(`${routeName} route omits ${label}`);
    }
  }
  return problems;
}

function explicitAssistantRuntimeModelProblems(source: string): string[] {
  const problems: string[] = [];
  const runLlmStreamSource = functionSource(source, "runLLMStream");
  if (!runLlmStreamSource) return ["runLLMStream was not found"];

  if (
    !/export\s+async\s+function\s+runLLMStream\s*\(\s*params\s*:\s*\{[\s\S]*?\n\s*model\s*:\s*string\s*;/.test(
      runLlmStreamSource,
    ) ||
    /\n\s*model\s*\?\s*:\s*string\s*;/.test(runLlmStreamSource)
  ) {
    problems.push("runLLMStream does not require an explicit model");
  }
  if (/\bresolveModel\s*\(/.test(runLlmStreamSource)) {
    problems.push("runLLMStream still calls resolveModel");
  }
  if (/\bDEFAULT_MAIN_MODEL\b/.test(runLlmStreamSource)) {
    problems.push("runLLMStream still falls back to DEFAULT_MAIN_MODEL");
  }
  if (
    !/streamChatWithTools\s*\(\s*\{[\s\S]*?\bmodel\s*(?:,|:\s*params\.model\b)/.test(
      runLlmStreamSource,
    )
  ) {
    problems.push("runLLMStream does not forward the exact required model");
  }
  for (const setting of ["reasoningEffort", "reasoningMode"] as const) {
    const acceptsSetting = new RegExp(
      `\\n\\s*${setting}\\?\\s*:\\s*(?:ReasoningEffort|ReasoningMode)\\s*;`,
    ).test(runLlmStreamSource);
    const forwardsSetting = new RegExp(
      `streamChatWithTools\\s*\\(\\s*\\{[\\s\\S]*?\\b${setting}\\s*(?:,|:\\s*params\\.${setting}\\b)`,
    ).test(runLlmStreamSource);
    if (!acceptsSetting || !forwardsSetting) {
      problems.push(
        `runLLMStream does not forward ${setting} generation settings`,
      );
    }
  }
  if (!/\n\s*modelResolution\?\s*:\s*\{/.test(runLlmStreamSource)) {
    problems.push("runLLMStream does not accept model resolution metadata");
  }
  for (const metadataKey of [
    "requested_model",
    "resolved_model",
    "model_resolution_status",
    "reasoning_effort",
    "reasoning_mode",
  ]) {
    if (!new RegExp(`\\b${metadataKey}\\s*:`).test(runLlmStreamSource)) {
      problems.push(`runLLMStream metadata omits ${metadataKey}`);
    }
  }
  return problems;
}

function tabularModelContainmentProblems(
  tabularRouteSource: string,
  userSettingsSource: string,
  userRouteSource: string,
): string[] {
  const problems: string[] = [];
  const tabularChatSource = sourceSection(
    tabularRouteSource,
    'tabularRouter.post("/:reviewId/chat"',
    ["function parseCellContent", "async function queryGeminiAllColumns"],
  );
  if (
    !/const\s*\{\s*tabular_model\s*:\s*tabularModel\s*,\s*api_keys\s*:\s*apiKeys\s*,?\s*\}\s*=\s*await\s+getUserModelSettings\(\s*userId\s*,\s*db\s*,?\s*\)/.test(
      tabularChatSource,
    )
  ) {
    problems.push(
      "tabular chat does not load tabular_model and api_keys together",
    );
  }
  if (/\bgetUserApiKeys\s*\(/.test(tabularChatSource)) {
    problems.push(
      "tabular chat still loads API keys without its tabular model",
    );
  }
  const runCall = sourceSection(tabularChatSource, "runLLMStream({", [
    "const annotations =",
    "catch (err)",
  ]);
  if (!/\bmodel\s*:\s*tabularModel\b/.test(runCall)) {
    problems.push("tabular chat does not pass tabularModel to runLLMStream");
  }
  if (/\breasoningEffort\b|\breasoningMode\b/.test(runCall)) {
    problems.push("tabular chat attaches main-assistant generation settings");
  }
  if (
    !/tabular_model\s*:\s*resolveTabularModel\(\s*data\?\.tabular_model\s*\)/.test(
      userSettingsSource,
    )
  ) {
    problems.push(
      "stored tabular settings are not resolved as tabular-only models",
    );
  }
  if (
    !/resolveTabularModel\(\s*row\.tabular_model\s*\)/.test(userRouteSource)
  ) {
    problems.push("profile reads do not safely resolve stale tabular models");
  }
  if (!/!isTabularModelId\(\s*raw\.tabularModel\s*\)/.test(userRouteSource)) {
    problems.push(
      "profile updates do not reject main-only tabularModel values",
    );
  }
  if (!/detail\s*:\s*["']Unsupported tabularModel["']/.test(userRouteSource)) {
    problems.push(
      "profile updates do not preserve the tabularModel error detail",
    );
  }
  if (!/update\.tabular_model\s*=\s*raw\.tabularModel/.test(userRouteSource)) {
    problems.push("profile updates do not store the validated tabular model");
  }
  return problems;
}

function clientFunctionForwardsAbortSignal(
  source: string,
  name: string,
): boolean {
  const fn = functionSource(source, name);
  return (
    /\bsignal\?\s*:\s*AbortSignal\b/.test(fn) &&
    /\{[^}]*\bsignal\b[^}]*\}\s*=\s*payload/.test(fn) &&
    /fetch\s*\([\s\S]*?\{[\s\S]*?\bsignal\s*[,}]/.test(fn)
  );
}

function emitsSseEvent(source: string, eventType: string): boolean {
  return new RegExp(`type\\s*:\\s*["']${eventType}["']`).test(source);
}

function clientConsumesSseEvent(source: string, eventType: string): boolean {
  return new RegExp(`data\\.type\\s*===\\s*["']${eventType}["']`).test(source);
}

function askInputsServerProblems(source: string): string[] {
  const problems: string[] = [];
  const runToolsSource = functionSource(source, "runToolCalls");
  const runLlmStreamSource = functionSource(source, "runLLMStream");

  if (
    !/const\s+ASK_INPUTS_TOOL[\s\S]*?name\s*:\s*["']ask_inputs["']/.test(source)
  ) {
    problems.push("does not define the ask_inputs tool");
  }
  if (
    !/askInputsAvailable\s*=\s*Boolean\s*\(\s*chatId\s*&&\s*assistantMessageId\s*&&\s*!tabularStore\s*,?\s*\)/.test(
      source,
    )
  ) {
    problems.push(
      "does not restrict Ask Inputs to a persisted assistant chat outside Tabular Review",
    );
  }
  if (
    !/askInputsAvailable\s*\?\s*\[ASK_INPUTS_TOOL\]\s*:\s*\[\]/.test(source)
  ) {
    problems.push("does not expose ask_inputs in the active assistant tools");
  }
  if (!runToolsSource) {
    problems.push("runToolCalls was not found");
  } else {
    const askInputsSection = sourceSection(
      runToolsSource,
      'tc.function.name === "ask_inputs"',
      ['tc.function.name === "read_document"'],
    );
    if (!askInputsSection) {
      problems.push("runToolCalls does not dispatch ask_inputs");
    } else {
      if (!/normalizeAskInputsEvent\s*\(/.test(askInputsSection)) {
        problems.push("ask_inputs arguments are not normalized before use");
      }
      if (!/await\s+persistAskInputsRequest\s*\(/.test(askInputsSection)) {
        problems.push("ask_inputs is not persisted before the stream pauses");
      }
      if (
        !/askInputsEvents\.push\(\s*persisted\.event\s*\)/.test(
          askInputsSection,
        )
      ) {
        problems.push(
          "the persisted Ask Inputs event is not retained for replay",
        );
      }
      if (!/write\s*\([\s\S]*?persisted\.event/.test(askInputsSection)) {
        problems.push("the persisted Ask Inputs event is not sent over SSE");
      }
      if (!/\bbreak\s*;/.test(askInputsSection)) {
        problems.push(
          "ask_inputs does not stop later tool calls in the provider batch",
        );
      }
    }
  }
  if (!/class\s+AskInputsPauseError\b/.test(source)) {
    problems.push("does not define a dedicated Ask Inputs pause signal");
  }
  if (!runLlmStreamSource) {
    problems.push("runLLMStream was not found");
  } else {
    if (
      !/if\s*\([\s\S]{0,500}?askInputsEvents\.length(?:\s*>\s*0)?[\s\S]{0,500}?\)\s*\{[\s\S]*?throw\s+new\s+AskInputsPauseError\s*\(/.test(
        runLlmStreamSource,
      )
    ) {
      problems.push(
        "runLLMStream does not stop provider iteration after Ask Inputs",
      );
    }
    if (
      !/if\s*\(\s*error\s+instanceof\s+AskInputsPauseError\s*\)\s*\{[\s\S]*?\breturn\s*;/.test(
        runLlmStreamSource,
      )
    ) {
      problems.push(
        "runLLMStream does not treat Ask Inputs as a normal paused response",
      );
    }
  }
  return problems;
}

function askInputsRouteProblems(source: string, routeName: string): string[] {
  const problems: string[] = [];
  if (!/\.post\(\s*["']\/["']\s*,\s*requireAuth\s*,/.test(source)) {
    problems.push(
      `${routeName} continuation route is not protected by requireAuth`,
    );
  }
  if (
    !/parseAskInputsResponsePayload\s*\(\s*body\.ask_inputs_response\s*,?\s*\)/.test(
      source,
    )
  ) {
    problems.push(`${routeName} route does not validate ask_inputs_response`);
  }
  if (
    !/consumeAskInputsResponse\s*\(\s*db\s*,\s*\{[\s\S]*?chatId[\s\S]*?submittedByUserId\s*:\s*userId/.test(
      source,
    )
  ) {
    problems.push(
      `${routeName} route does not consume Ask Inputs under the authenticated user`,
    );
  }
  if (!/assistantMessageId/.test(source)) {
    problems.push(
      `${routeName} route does not allocate an assistant placeholder`,
    );
  }
  const runLlmCall = sourceSection(source, "runLLMStream(", [
    "const annotations =",
    "catch (err)",
  ]);
  if (!runLlmCall || !/assistantMessageId/.test(runLlmCall)) {
    problems.push(
      `${routeName} route does not pass the placeholder ID into runLLMStream`,
    );
  }
  return problems;
}

function askInputsClientProblems(
  apiSource: string,
  hookSource: string,
  messageSource: string,
  popupSource: string,
): string[] {
  const problems: string[] = [];
  for (const functionName of ["streamChat", "streamProjectChat"]) {
    const fn = functionSource(apiSource, functionName);
    if (!/ask_inputs_response\?\s*:\s*DocketAskInputsResponse/.test(fn)) {
      problems.push(
        `${functionName} does not accept an Ask Inputs continuation payload`,
      );
    }
  }
  if (!/ask_inputs_response\s*:\s*opts\?\.askInputsResponse/.test(hookSource)) {
    problems.push(
      "useAssistantChat does not send Ask Inputs responses to the stream route",
    );
  }
  if (
    !/if\s*\(\s*data\.type\s*===\s*["']ask_inputs["']\s*\)/.test(hookSource) ||
    !/type\s*:\s*["']ask_inputs["']/.test(hookSource)
  ) {
    problems.push("useAssistantChat does not consume Ask Inputs SSE events");
  }
  if (
    !/event\.type\s*===\s*["']ask_inputs["']/.test(messageSource) ||
    !/<AskInputsPopup\b/.test(messageSource) ||
    !/onAskInputsSubmit/.test(messageSource)
  ) {
    problems.push("AssistantMessage does not render the Ask Inputs popup");
  }
  if (
    !/export\s+function\s+AskInputsPopup\b/.test(popupSource) ||
    !/request_id\s*:\s*event\.request_id/.test(popupSource) ||
    !/onSubmit\s*\(\s*response/.test(popupSource)
  ) {
    problems.push("AskInputsPopup does not submit the persisted request ID");
  }
  return problems;
}

function richCitationProblems(
  contractsSource: string,
  chatToolsSource: string,
  chatRouteSource: string,
  projectChatRouteSource: string,
  sharedTypesSource: string,
  hookSource: string,
): string[] {
  const problems: string[] = [];
  if (
    !/CitationStreamStatus\s*=\s*["']started["']\s*\|\s*["']partial["']\s*\|\s*["']final["']/.test(
      contractsSource,
    )
  ) {
    problems.push(
      "assistant contracts do not define started, partial, and final citation states",
    );
  }
  if (
    !/event\.status\s*===\s*["']started["']\s*\|\|\s*event\.status\s*===\s*["']partial["']/.test(
      contractsSource,
    ) ||
    !/citationSseEvent\s*\(\s*["']final["']\s*,\s*citations\s*\)/.test(
      contractsSource,
    )
  ) {
    problems.push(
      "citation SSE bridge does not preserve partial snapshots and emit one final snapshot",
    );
  }
  if (
    !/status\s*:\s*["']started["']/.test(chatToolsSource) ||
    !/status\s*:\s*["']partial["']/.test(chatToolsSource) ||
    !/streamPartialRichCitations/.test(chatToolsSource)
  ) {
    problems.push(
      "runLLMStream does not emit incremental rich citation states",
    );
  }
  for (const [routeName, routeSource] of [
    ["chat", chatRouteSource],
    ["project chat", projectChatRouteSource],
  ] as const) {
    if (
      !/createCitationSseBridge\s*\(\s*write\s*\)/.test(routeSource) ||
      !/extractRichCitations\s*\(/.test(routeSource) ||
      !/citationSse\.finish\s*\(\s*citations\s*(?:,|\))/.test(routeSource)
    ) {
      problems.push(
        `${routeName} route does not bridge and persist final rich citations`,
      );
    }
  }
  if (
    !/sheet\?\s*:\s*string/.test(contractsSource) ||
    !/cell\?\s*:\s*string/.test(contractsSource)
  ) {
    problems.push(
      "assistant contracts do not retain spreadsheet sheet and cell citation locators",
    );
  }
  if (!/kind\s*:\s*["']case["']/.test(contractsSource)) {
    problems.push("assistant contracts do not retain case citations");
  }
  if (
    !/citationStatus\?\s*:\s*["']started["']\s*\|\s*["']partial["']\s*\|\s*["']final["']/.test(
      sharedTypesSource,
    ) ||
    !/sheet\?\s*:\s*string/.test(sharedTypesSource) ||
    !/cell\?\s*:\s*string/.test(sharedTypesSource) ||
    !/kind\s*:\s*["']case["']/.test(sharedTypesSource)
  ) {
    problems.push(
      "frontend citation types do not support status, sheet/cell, and case citations",
    );
  }
  if (
    !/data\.type\s*===\s*["']citations["']/.test(hookSource) ||
    !/data\.status\s*===\s*["']started["']/.test(hookSource) ||
    !/data\.status\s*===\s*["']partial["']/.test(hookSource) ||
    !/data\.status\s*===\s*["']final["']/.test(hookSource) ||
    !/data\.type\s*===\s*["']case_citation["']/.test(hookSource)
  ) {
    problems.push(
      "useAssistantChat does not consume rich citation state and case citation events",
    );
  }
  return problems;
}

function turnScopedReadProblems(source: string): string[] {
  const problems: string[] = [];
  const runToolsSource = functionSource(source, "runToolCalls");
  const runLlmStreamSource = functionSource(source, "runLLMStream");
  if (!/export\s+type\s+TurnReadState\b/.test(source)) {
    problems.push("does not define TurnReadState");
  }
  if (!/export\s+async\s+function\s+getTurnReadIdentity\b/.test(source)) {
    problems.push("does not derive a stable document-version read identity");
  }
  if (!/export\s+function\s+duplicateReadDocumentResult\b/.test(source)) {
    problems.push("does not return a safe already-read result");
  }
  if (!/export\s+function\s+clearTurnReadsForDocument\b/.test(source)) {
    problems.push("does not expose edit invalidation for cached reads");
  }
  if (!runToolsSource) {
    problems.push("runToolCalls was not found");
    return problems;
  }
  const readDocumentSection = sourceSection(
    runToolsSource,
    'tc.function.name === "read_document"',
    ['tc.function.name === "find_in_document"'],
  );
  const fetchDocumentsSection = sourceSection(
    runToolsSource,
    'tc.function.name === "fetch_documents"',
    ['tc.function.name === "list_workflows"'],
  );
  for (const [toolName, section] of [
    ["read_document", readDocumentSection],
    ["fetch_documents", fetchDocumentsSection],
  ] as const) {
    if (
      !section ||
      !/getTurnReadIdentity\s*\(/.test(section) ||
      !/turnReadState\?\.has\(\s*readIdentity\.key\s*\)/.test(section) ||
      !/duplicateReadDocumentResult\s*\(\s*readIdentity\s*\)/.test(section) ||
      !/turnReadState\.set\(\s*readIdentity\.key\s*,\s*readIdentity\s*\)/.test(
        section,
      )
    ) {
      problems.push(
        `${toolName} does not suppress duplicate reads after a successful first read`,
      );
    }
  }
  if (
    !/clearTurnReadsForDocument\s*\(\s*turnReadState\s*,\s*indexed\.document_id\s*,?\s*\)/.test(
      runToolsSource,
    )
  ) {
    problems.push(
      "edit_document does not invalidate the edited document's read cache",
    );
  }
  if (
    !runLlmStreamSource ||
    !/const\s+turnReadState\s*:\s*TurnReadState\s*=\s*new\s+Map\s*\(/.test(
      runLlmStreamSource,
    ) ||
    !/runToolCalls\s*\([\s\S]*?turnReadState\s*,?\s*\)/.test(runLlmStreamSource)
  ) {
    problems.push(
      "runLLMStream does not keep and pass one turn-scoped read cache",
    );
  }
  return problems;
}

export function evaluateAssistantRuntimeContract(root: string): CheckResult[] {
  const modelSource = readSource(root, "backend/src/lib/llm/models.ts");
  const llmIndexSource = readSource(root, "backend/src/lib/llm/index.ts");
  const llmTypesSource = readSource(root, "backend/src/lib/llm/types.ts");
  const openAiSource = readSource(root, "backend/src/lib/llm/openai.ts");
  const chatToolsSource = readSource(root, "backend/src/lib/chatTools.ts");
  const assistantContractsSource = readSource(
    root,
    "backend/src/lib/assistantContracts.ts",
  );
  const chatRouteSource = readSource(root, "backend/src/routes/chat.ts");
  const projectChatRouteSource = readSource(
    root,
    "backend/src/routes/projectChat.ts",
  );
  const frontendModelsSource = readSource(
    root,
    "frontend/src/app/components/assistant/ModelToggle.tsx",
  );
  const frontendApiSource = readSource(
    root,
    "frontend/src/app/lib/docketApi.ts",
  );
  const assistantHookSource = readSource(
    root,
    "frontend/src/app/hooks/useAssistantChat.ts",
  );
  const sharedTypesSource = readSource(
    root,
    "frontend/src/app/components/shared/types.ts",
  );
  const assistantMessageSource = readSource(
    root,
    "frontend/src/app/components/assistant/AssistantMessage.tsx",
  );
  const askInputsPopupSource = readSource(
    root,
    "frontend/src/app/components/assistant/AskInputsPopup.tsx",
  );
  const tabularRouteSource = readSource(root, "backend/src/routes/tabular.ts");
  const userSettingsSource = readSource(
    root,
    "backend/src/lib/userSettings.ts",
  );
  const userRouteSource = readSource(root, "backend/src/routes/user.ts");

  const modelArrays = {
    CLAUDE_MAIN_MODELS: readConstStringArray(
      modelSource.source,
      "CLAUDE_MAIN_MODELS",
    ),
    GEMINI_MAIN_MODELS: readConstStringArray(
      modelSource.source,
      "GEMINI_MAIN_MODELS",
    ),
    OPENAI_MAIN_MODELS: readConstStringArray(
      modelSource.source,
      "OPENAI_MAIN_MODELS",
    ),
    CLAUDE_MID_MODELS: readConstStringArray(
      modelSource.source,
      "CLAUDE_MID_MODELS",
    ),
    GEMINI_MID_MODELS: readConstStringArray(
      modelSource.source,
      "GEMINI_MID_MODELS",
    ),
    OPENAI_MID_MODELS: readConstStringArray(
      modelSource.source,
      "OPENAI_MID_MODELS",
    ),
    CLAUDE_LOW_MODELS: readConstStringArray(
      modelSource.source,
      "CLAUDE_LOW_MODELS",
    ),
    GEMINI_LOW_MODELS: readConstStringArray(
      modelSource.source,
      "GEMINI_LOW_MODELS",
    ),
    OPENAI_LOW_MODELS: readConstStringArray(
      modelSource.source,
      "OPENAI_LOW_MODELS",
    ),
  };
  const modelArrayErrors = Object.entries(modelArrays)
    .filter(([, result]) => result.error)
    .map(([name, result]) => `${name}: ${result.error}`);
  const mainModels = [
    ...modelArrays.CLAUDE_MAIN_MODELS.values,
    ...modelArrays.GEMINI_MAIN_MODELS.values,
    ...modelArrays.OPENAI_MAIN_MODELS.values,
  ];
  const tabularModels = [
    ...new Set([
      ...modelArrays.CLAUDE_MID_MODELS.values,
      ...modelArrays.GEMINI_MID_MODELS.values,
      ...modelArrays.GEMINI_MAIN_MODELS.values,
      ...modelArrays.OPENAI_MID_MODELS.values,
      ...modelArrays.CLAUDE_LOW_MODELS.values,
      ...modelArrays.GEMINI_LOW_MODELS.values,
      ...modelArrays.OPENAI_LOW_MODELS.values,
    ]),
  ];
  const frontendMainModels = readModelOptions(
    frontendModelsSource.source,
    "MODELS",
  );
  const frontendTabularModels = readModelOptions(
    frontendModelsSource.source,
    "TABULAR_MODELS",
  );
  const backendDefaultModel = readStringConstant(
    modelSource.source,
    "DEFAULT_MAIN_MODEL",
  );
  const frontendDefaultModel = readStringConstant(
    frontendModelsSource.source,
    "DEFAULT_MODEL_ID",
  );

  const canonicalModelErrors = [
    modelSource.error,
    ...modelArrayErrors,
    ...duplicates(mainModels).map((model) => `duplicate main model: ${model}`),
    !backendDefaultModel ? "DEFAULT_MAIN_MODEL was not found" : "",
    backendDefaultModel && !mainModels.includes(backendDefaultModel)
      ? `DEFAULT_MAIN_MODEL is not a main model: ${backendDefaultModel}`
      : "",
    !/model\.startsWith\(["']claude["']\)\)\s*return\s*["']claude["']/.test(
      modelSource.source,
    )
      ? "providerForModel does not route Claude model IDs"
      : "",
    !/model\.startsWith\(["']gemini["']\)\)\s*return\s*["']gemini["']/.test(
      modelSource.source,
    )
      ? "providerForModel does not route Gemini model IDs"
      : "",
    !/model\.startsWith\(["']gpt-["']\)\)\s*return\s*["']openai["']/.test(
      modelSource.source,
    )
      ? "providerForModel does not route OpenAI model IDs"
      : "",
  ].filter(Boolean);
  const exactGpt56ModelErrors: string[] = [];
  const openAiMainModelDetail = describeSetMismatch(
    expectedOpenAiMainModels,
    modelArrays.OPENAI_MAIN_MODELS.values,
  );
  if (
    openAiMainModelDetail ||
    modelArrays.OPENAI_MAIN_MODELS.values.some(
      (model, index) => model !== expectedOpenAiMainModels[index],
    )
  ) {
    exactGpt56ModelErrors.push(
      `OPENAI_MAIN_MODELS must equal ${expectedOpenAiMainModels.join(", ")}; found ${modelArrays.OPENAI_MAIN_MODELS.values.join(", ") || "none"}${openAiMainModelDetail ? ` (${openAiMainModelDetail})` : ""}`,
    );
  }
  if (backendDefaultModel !== expectedDefaultMainModel) {
    exactGpt56ModelErrors.push(
      `DEFAULT_MAIN_MODEL must be ${expectedDefaultMainModel}; found ${backendDefaultModel ?? "none"}`,
    );
  }

  const adapterDefinitions = [
    { provider: "claude", functionName: "streamClaude", file: "claude.ts" },
    { provider: "openai", functionName: "streamOpenAI", file: "openai.ts" },
    { provider: "gemini", functionName: "streamGemini", file: "gemini.ts" },
  ];
  const adapterErrors: string[] = [];
  if (llmTypesSource.error) adapterErrors.push(llmTypesSource.error);
  if (!/\babortSignal\?\s*:\s*AbortSignal\b/.test(llmTypesSource.source)) {
    adapterErrors.push(
      "StreamChatParams does not declare abortSignal?: AbortSignal",
    );
  }
  if (chatToolsSource.error) adapterErrors.push(chatToolsSource.error);
  if (!/\bsignal\?\s*:\s*AbortSignal\b/.test(chatToolsSource.source)) {
    adapterErrors.push("runLLMStream does not accept signal?: AbortSignal");
  }
  if (
    !/\babortSignal\s*:\s*(?:params\.)?signal\b/.test(chatToolsSource.source)
  ) {
    adapterErrors.push("runLLMStream does not forward signal as abortSignal");
  }
  if (llmIndexSource.error) adapterErrors.push(llmIndexSource.error);
  for (const adapter of adapterDefinitions) {
    const adapterSource = readSource(
      root,
      `backend/src/lib/llm/${adapter.file}`,
    );
    if (adapterSource.error) {
      adapterErrors.push(adapterSource.error);
      continue;
    }
    if (!adapterSource.source.includes(`function ${adapter.functionName}`)) {
      adapterErrors.push(
        `${adapter.provider} adapter does not export ${adapter.functionName}`,
      );
    }
    if (!hasAbortSignalUse(adapterSource.source)) {
      adapterErrors.push(
        `${adapter.provider} adapter does not use abortSignal to cancel provider work`,
      );
    }
    const providerDispatch =
      adapter.provider === "gemini"
        ? new RegExp(
            `return\\s+${adapter.functionName}\\s*\\(\\s*params\\s*\\)`,
          )
        : new RegExp(
            `provider\\s*===\\s*["']${adapter.provider}["'][\\s\\S]*?${adapter.functionName}\\s*\\(\\s*params\\s*\\)`,
          );
    if (!providerDispatch.test(llmIndexSource.source)) {
      adapterErrors.push(
        `${adapter.provider} adapter is not dispatched by streamChatWithTools`,
      );
    }
  }

  const routeErrors: string[] = [];
  for (const [name, source] of [
    ["chat", chatRouteSource],
    ["project chat", projectChatRouteSource],
  ] as const) {
    if (source.error) {
      routeErrors.push(source.error);
    } else if (!routeCancelsProviderWork(source.source)) {
      routeErrors.push(
        `${name} route must set SSE headers, abort on res.close, and pass that signal to runLLMStream`,
      );
    }
  }
  const mainRequestResolutionErrors = [
    ...(chatRouteSource.error
      ? [chatRouteSource.error]
      : mainAssistantRouteResolutionProblems(chatRouteSource.source, "chat")),
    ...(projectChatRouteSource.error
      ? [projectChatRouteSource.error]
      : mainAssistantRouteResolutionProblems(
          projectChatRouteSource.source,
          "project chat",
        )),
  ];
  const explicitRuntimeModelErrors = chatToolsSource.error
    ? [chatToolsSource.error]
    : explicitAssistantRuntimeModelProblems(chatToolsSource.source);

  const frontendErrors: string[] = [];
  if (frontendApiSource.error) frontendErrors.push(frontendApiSource.error);
  for (const functionName of ["streamChat", "streamProjectChat"]) {
    if (
      !clientFunctionForwardsAbortSignal(frontendApiSource.source, functionName)
    ) {
      frontendErrors.push(
        `${functionName} does not accept and forward AbortSignal to fetch`,
      );
    }
  }
  if (assistantHookSource.error) frontendErrors.push(assistantHookSource.error);
  if (
    !/new\s+AbortController\s*\(\s*\)/.test(assistantHookSource.source) ||
    !/\bsignal\s*:\s*controller\.signal\b/.test(assistantHookSource.source)
  ) {
    frontendErrors.push(
      "useAssistantChat does not create and pass an AbortController signal",
    );
  }

  const sseProtocolErrors: string[] = [];
  const runLlmStreamSource = functionSource(
    chatToolsSource.source,
    "runLLMStream",
  );
  if (!runLlmStreamSource) {
    sseProtocolErrors.push("runLLMStream was not found");
  } else {
    for (const eventType of ["content_delta", "reasoning_delta", "citations"]) {
      if (!emitsSseEvent(runLlmStreamSource, eventType)) {
        sseProtocolErrors.push(`runLLMStream does not emit ${eventType}`);
      }
    }
    if (!/data:\s*\[DONE\]/.test(runLlmStreamSource)) {
      sseProtocolErrors.push("runLLMStream does not emit [DONE]");
    }
  }
  for (const eventType of [
    "content_delta",
    "reasoning_delta",
    "citations",
    "error",
  ]) {
    if (!clientConsumesSseEvent(assistantHookSource.source, eventType)) {
      sseProtocolErrors.push(`useAssistantChat does not consume ${eventType}`);
    }
  }
  if (!/dataStr\s*===\s*["']\[DONE\]["']/.test(assistantHookSource.source)) {
    sseProtocolErrors.push("useAssistantChat does not consume [DONE]");
  }

  const cancellationPersistenceErrors: string[] = [];
  for (const [name, source] of [
    ["chat", chatRouteSource],
    ["project chat", projectChatRouteSource],
  ] as const) {
    if (source.error) {
      cancellationPersistenceErrors.push(source.error);
      continue;
    }
    for (const problem of cancelledStreamPersistenceProblems(source.source)) {
      cancellationPersistenceErrors.push(`${name} route ${problem}`);
    }
  }

  const tabularGenerateRouteSource = sourceSection(
    tabularRouteSource.source,
    'tabularRouter.post("/:reviewId/generate"',
    ['tabularRouter.get("/:reviewId/chats"'],
  );
  const tabularChatRouteSource = sourceSection(
    tabularRouteSource.source,
    'tabularRouter.post("/:reviewId/chat"',
    ["function parseCellContent", "async function queryGeminiAllColumns"],
  );
  const queryGeminiAllColumnsSource = sourceSection(
    tabularRouteSource.source,
    "async function queryGeminiAllColumns",
    ["async function extractPdfMarkdown"],
  );
  const tabularSseCancellationErrors: string[] = [];
  if (tabularRouteSource.error) {
    tabularSseCancellationErrors.push(tabularRouteSource.error);
  } else {
    for (const problem of sseRouteCancellationProblems(
      tabularGenerateRouteSource,
      "queryGeminiAllColumns",
    )) {
      tabularSseCancellationErrors.push(`generate route ${problem}`);
    }
    for (const problem of sseRouteCancellationProblems(
      tabularChatRouteSource,
      "runLLMStream",
    )) {
      tabularSseCancellationErrors.push(`chat route ${problem}`);
    }
  }

  const tabularGenerationCleanupErrors = tabularRouteSource.error
    ? [tabularRouteSource.error]
    : tabularGenerationAbortCleanupProblems(
        tabularGenerateRouteSource,
        queryGeminiAllColumnsSource,
      );
  const tabularChatPersistenceErrors = tabularRouteSource.error
    ? [tabularRouteSource.error]
    : tabularChatPartialPersistenceProblems(tabularChatRouteSource).map(
        (problem) => `chat route ${problem}`,
      );
  const completedToolEventErrors =
    completedToolEventCancellationProblems(runLlmStreamSource);
  const tabularProviderCancellationErrors = tabularRouteSource.error
    ? [tabularRouteSource.error]
    : tabularProviderCancellationProblems(
        queryGeminiAllColumnsSource,
        llmIndexSource.source,
        openAiSource.source,
      );
  const askInputsServerErrors = chatToolsSource.error
    ? [chatToolsSource.error]
    : askInputsServerProblems(chatToolsSource.source);
  const askInputsResumeErrors = [
    ...(chatRouteSource.error
      ? [chatRouteSource.error]
      : askInputsRouteProblems(chatRouteSource.source, "chat")),
    ...(projectChatRouteSource.error
      ? [projectChatRouteSource.error]
      : askInputsRouteProblems(projectChatRouteSource.source, "project chat")),
    ...(frontendApiSource.error
      ? [frontendApiSource.error]
      : assistantHookSource.error
        ? [assistantHookSource.error]
        : assistantMessageSource.error
          ? [assistantMessageSource.error]
          : askInputsPopupSource.error
            ? [askInputsPopupSource.error]
            : askInputsClientProblems(
                frontendApiSource.source,
                assistantHookSource.source,
                assistantMessageSource.source,
                askInputsPopupSource.source,
              )),
  ];
  const richCitationContractErrors = [
    ...(assistantContractsSource.error ? [assistantContractsSource.error] : []),
    ...(chatToolsSource.error ? [chatToolsSource.error] : []),
    ...(chatRouteSource.error ? [chatRouteSource.error] : []),
    ...(projectChatRouteSource.error ? [projectChatRouteSource.error] : []),
    ...(sharedTypesSource.error ? [sharedTypesSource.error] : []),
    ...(assistantHookSource.error ? [assistantHookSource.error] : []),
  ];
  if (richCitationContractErrors.length === 0) {
    richCitationContractErrors.push(
      ...richCitationProblems(
        assistantContractsSource.source,
        chatToolsSource.source,
        chatRouteSource.source,
        projectChatRouteSource.source,
        sharedTypesSource.source,
        assistantHookSource.source,
      ),
    );
  }
  const turnScopedReadErrors = chatToolsSource.error
    ? [chatToolsSource.error]
    : turnScopedReadProblems(chatToolsSource.source);
  const tabularModelContainmentErrors = [
    ...(tabularRouteSource.error ? [tabularRouteSource.error] : []),
    ...(userSettingsSource.error ? [userSettingsSource.error] : []),
    ...(userRouteSource.error ? [userRouteSource.error] : []),
  ];
  if (tabularModelContainmentErrors.length === 0) {
    tabularModelContainmentErrors.push(
      ...tabularModelContainmentProblems(
        tabularRouteSource.source,
        userSettingsSource.source,
        userRouteSource.source,
      ),
    );
  }

  const modelPickerDetail = describeSetMismatch(
    mainModels,
    frontendMainModels.values,
  );
  const tabularPickerDetail = describeSetMismatch(
    tabularModels,
    frontendTabularModels.values,
  );

  return [
    {
      name: "backend canonical model registry",
      ok: canonicalModelErrors.length === 0,
      detail: canonicalModelErrors.join("; ") || undefined,
    },
    {
      name: "GPT-5.6 main model literals are exact",
      ok: exactGpt56ModelErrors.length === 0,
      detail: exactGpt56ModelErrors.join("; ") || undefined,
    },
    {
      name: "main model picker matches backend canonical models",
      ok:
        !frontendModelsSource.error &&
        !frontendMainModels.error &&
        !modelPickerDetail,
      detail:
        frontendModelsSource.error ??
        frontendMainModels.error ??
        modelPickerDetail,
    },
    {
      name: "tabular model picker matches backend canonical models",
      ok:
        !frontendModelsSource.error &&
        !frontendTabularModels.error &&
        !tabularPickerDetail,
      detail:
        frontendModelsSource.error ??
        frontendTabularModels.error ??
        tabularPickerDetail,
    },
    {
      name: "frontend default model matches backend default",
      ok:
        !!backendDefaultModel &&
        !!frontendDefaultModel &&
        backendDefaultModel === frontendDefaultModel,
      detail:
        !backendDefaultModel || !frontendDefaultModel
          ? "DEFAULT_MAIN_MODEL or DEFAULT_MODEL_ID was not found"
          : backendDefaultModel === frontendDefaultModel
            ? undefined
            : `backend: ${backendDefaultModel}; frontend: ${frontendDefaultModel}`,
    },
    {
      name: "provider adapters honor AbortSignal",
      ok: adapterErrors.length === 0,
      detail: adapterErrors.join("; ") || undefined,
    },
    {
      name: "SSE routes cancel provider work on disconnect",
      ok: routeErrors.length === 0,
      detail: routeErrors.join("; ") || undefined,
    },
    {
      name: "main assistant requests resolve before SSE",
      ok: mainRequestResolutionErrors.length === 0,
      detail: mainRequestResolutionErrors.join("; ") || undefined,
    },
    {
      name: "runLLMStream consumes explicit model settings",
      ok: explicitRuntimeModelErrors.length === 0,
      detail: explicitRuntimeModelErrors.join("; ") || undefined,
    },
    {
      name: "tabular chat and profiles stay on tabular models",
      ok: tabularModelContainmentErrors.length === 0,
      detail: tabularModelContainmentErrors.join("; ") || undefined,
    },
    {
      name: "SSE event protocol is complete",
      ok: sseProtocolErrors.length === 0,
      detail: sseProtocolErrors.join("; ") || undefined,
    },
    {
      name: "Ask Inputs server pause and persistence contract is complete",
      ok: askInputsServerErrors.length === 0,
      detail: askInputsServerErrors.join("; ") || undefined,
    },
    {
      name: "Ask Inputs authenticated route and client resume contract is complete",
      ok: askInputsResumeErrors.length === 0,
      detail: askInputsResumeErrors.join("; ") || undefined,
    },
    {
      name: "rich citation streaming and locator contract is complete",
      ok: richCitationContractErrors.length === 0,
      detail: richCitationContractErrors.join("; ") || undefined,
    },
    {
      name: "turn-scoped document read suppression is safe",
      ok: turnScopedReadErrors.length === 0,
      detail: turnScopedReadErrors.join("; ") || undefined,
    },
    {
      name: "cancelled stream persistence is safe",
      ok: cancellationPersistenceErrors.length === 0,
      detail: cancellationPersistenceErrors.join("; ") || undefined,
    },
    {
      name: "Tabular Review SSE cancellation is complete",
      ok: tabularSseCancellationErrors.length === 0,
      detail: tabularSseCancellationErrors.join("; ") || undefined,
    },
    {
      name: "Tabular Review generation abort cleanup is safe",
      ok: tabularGenerationCleanupErrors.length === 0,
      detail: tabularGenerationCleanupErrors.join("; ") || undefined,
    },
    {
      name: "Tabular Review chat partial persistence is safe",
      ok: tabularChatPersistenceErrors.length === 0,
      detail: tabularChatPersistenceErrors.join("; ") || undefined,
    },
    {
      name: "completed tool events survive cancellation",
      ok: completedToolEventErrors.length === 0,
      detail: completedToolEventErrors.join("; ") || undefined,
    },
    {
      name: "Tabular Review provider cancellation paths are complete",
      ok: tabularProviderCancellationErrors.length === 0,
      detail: tabularProviderCancellationErrors.join("; ") || undefined,
    },
    {
      name: "frontend streaming client forwards AbortSignal",
      ok: frontendErrors.length === 0,
      detail: frontendErrors.join("; ") || undefined,
    },
  ];
}

function parseRootArgument(args: string[]): string {
  const rootIndex = args.indexOf("--root");
  if (rootIndex < 0) return defaultRepositoryRoot;
  const root = args[rootIndex + 1];
  if (!root || root.startsWith("-")) {
    throw new Error("--root requires a repository path");
  }
  return resolve(root);
}

function printUsage(): void {
  console.log(
    "Usage: ./node_modules/.bin/tsx scripts/assistant-runtime-check.ts [--root /path/to/mike]",
  );
}

function main(): void {
  if (process.argv.slice(2).includes("--help")) {
    printUsage();
    return;
  }

  const root = parseRootArgument(process.argv.slice(2));
  const checks = evaluateAssistantRuntimeContract(root);
  for (const check of checks) {
    console.log(
      `${check.name}: ${check.ok ? "PASS" : "FAIL"}${check.detail ? ` — ${check.detail}` : ""}`,
    );
  }
  const passed = checks.every((check) => check.ok);
  console.log(`assistant-runtime-contract: ${passed ? "pass" : "fail"}`);
  if (!passed) process.exitCode = 1;
}

main();
