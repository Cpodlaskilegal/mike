import OpenAI from "openai";
import { randomUUID } from "crypto";
import type {
    Response,
    ResponseCreateParamsBase,
    ResponseCreateParamsNonStreaming,
    ResponseCreateParamsStreaming,
    ResponseFunctionToolCall,
    ResponseInput,
    ResponseInputItem,
    ResponseOutputItem,
    ResponseStreamEvent,
    ResponseTextConfig,
    Tool,
} from "openai/resources/responses/responses";
import type {
    AiObservabilityMetadata,
    JsonSchemaTextFormat,
    NormalizedToolCall,
    NormalizedToolResult,
    ReasoningEffort,
    ReasoningMode,
    StreamChatParams,
    StreamChatResult,
    TextVerbosity,
} from "./types";
import { throwIfAborted } from "./types";
import type { Gpt56ReasoningEffort } from "./models";
import { captureAiGeneration } from "../posthog";
import {
    calculateLlmCostNanos,
    deliverSpendReport,
    recordLlmUsage,
    spendUsd,
    type LlmCost,
    type RecordLlmUsageInput,
} from "../llmSpend";
import { safeErrorMessage } from "../safeError";

const MAX_OUTPUT_TOKENS = 16384;

type OpenAIResponseResult = {
    response: Response;
    latencySeconds: number;
    timeToFirstTokenSeconds?: number;
};

export type OpenAIRequestBuilderInput = Omit<
    ResponseCreateParamsBase,
    "reasoning"
> & {
    reasoningEffort: ReasoningEffort;
};

export type Gpt56ProReasoningEffort = Exclude<
    Gpt56ReasoningEffort,
    "none" | "low"
>;

export type CompletedOpenAIOutput =
    | { kind: "text"; text: string }
    | { kind: "refusal"; text: string }
    | { kind: "tool_calls"; text: "" };

class NamedOpenAIError extends Error {
    constructor(name: string, message: string) {
        super(message);
        this.name = name;
    }
}

function client(apiKeyOverride?: string | null): OpenAI {
    const apiKey = apiKeyOverride?.trim() || process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
        throw new Error(
            "An OpenAI API key is required to use OpenAI models. Configure OPENAI_API_KEY or save a user OpenAI key before selecting an OpenAI model.",
        );
    }
    return new OpenAI({ apiKey });
}

function defaultReasoningEffort(
    model: string,
    enableThinking?: boolean,
): ReasoningEffort {
    // For interactive Standard chat, mirror Claude/Gemini by spending
    // reasoning only where the UI is prepared to show it. One-shot title and
    // extraction calls stay lean unless their caller explicitly overrides it.
    if (enableThinking) {
        if (model.endsWith("-mini") || model.endsWith("-nano")) return "low";
        return "medium";
    }
    if (model.endsWith("-nano")) return "none";
    return "low";
}

function proReasoningEffort(
    effort: ReasoningEffort | undefined,
): Gpt56ProReasoningEffort {
    switch (effort) {
        case "medium":
        case "high":
        case "xhigh":
        case "max":
            return effort;
        default:
            return "medium";
    }
}

export function shouldStreamOpenAI(reasoningMode: ReasoningMode): boolean {
    return reasoningMode !== "pro";
}

export function buildOpenAIStandardStreamingRequest(
    input: OpenAIRequestBuilderInput,
): ResponseCreateParamsStreaming {
    const { reasoningEffort, ...request } = input;
    return {
        ...request,
        reasoning: { effort: reasoningEffort },
        stream: true,
    };
}

export function buildOpenAIProNonStreamingRequest(
    input: Omit<OpenAIRequestBuilderInput, "reasoningEffort"> & {
        reasoningEffort: Gpt56ProReasoningEffort;
    },
): ResponseCreateParamsNonStreaming {
    const { reasoningEffort, ...request } = input;
    return {
        ...request,
        reasoning: { effort: reasoningEffort, mode: "pro" },
        stream: false,
    };
}

export function buildOpenAIStandardNonStreamingRequest(
    input: OpenAIRequestBuilderInput,
): ResponseCreateParamsNonStreaming {
    const { reasoningEffort, ...request } = input;
    return {
        ...request,
        reasoning: { effort: reasoningEffort },
        stream: false,
    };
}

function textConfig(
    textVerbosity?: TextVerbosity,
    textFormat?: JsonSchemaTextFormat,
): ResponseTextConfig | undefined {
    if (!textVerbosity && !textFormat) return undefined;
    const config: ResponseTextConfig = {};
    if (textVerbosity) config.verbosity = textVerbosity;
    if (textFormat) {
        config.format = {
            type: "json_schema",
            name: textFormat.name,
            description: textFormat.description,
            schema: textFormat.schema,
            strict: textFormat.strict,
        };
    }
    return config;
}

function toInput(messages: StreamChatParams["messages"]): ResponseInput {
    return messages.map((m): ResponseInputItem => ({
        type: "message",
        role: m.role,
        content: m.content,
    }));
}

function toOpenAITools(tools: StreamChatParams["tools"] = []): Tool[] {
    return tools.map((t) => ({
        type: "function",
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
        strict: false,
    }));
}

function parseToolArguments(raw: string): Record<string, unknown> {
    if (!raw.trim()) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function extractFunctionCalls(response: Response): ResponseFunctionToolCall[] {
    return response.output.filter(
        (item): item is ResponseFunctionToolCall =>
            item.type === "function_call" && item.status !== "incomplete",
    );
}

function namedResponseError(
    name: string,
    unsafeMessage: unknown,
    fallback: string,
): NamedOpenAIError {
    return new NamedOpenAIError(name, safeErrorMessage(unsafeMessage, fallback));
}

export function extractCompletedOpenAIOutput(
    response: Response,
): CompletedOpenAIOutput {
    if (response.status === "failed") {
        throw namedResponseError(
            "OPENAI_RESPONSE_FAILED",
            response.error?.message,
            "OpenAI response failed",
        );
    }
    if (response.status === "incomplete") {
        throw namedResponseError(
            "OPENAI_RESPONSE_INCOMPLETE",
            response.incomplete_details?.reason,
            "OpenAI response incomplete",
        );
    }

    const outputText = response.output_text ?? "";
    if (outputText) return { kind: "text", text: outputText };

    const messageText = response.output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content)
        .filter((content) => content.type === "output_text")
        .map((content) => content.text)
        .join("");
    if (messageText) return { kind: "text", text: messageText };

    const refusal = response.output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content)
        .filter((content) => content.type === "refusal")
        .map((content) => content.refusal)
        .filter(Boolean)
        .join("\n");
    if (refusal) return { kind: "refusal", text: refusal };

    if (extractFunctionCalls(response).length > 0) {
        return { kind: "tool_calls", text: "" };
    }

    throw new NamedOpenAIError(
        "OPENAI_EMPTY_RESPONSE",
        "OpenAI completed without usable output.",
    );
}

export function emitCompletedOpenAIContent(
    response: Response,
    onContentDelta?: (delta: string) => void,
): CompletedOpenAIOutput {
    const output = extractCompletedOpenAIOutput(response);
    if (output.text) onContentDelta?.(output.text);
    return output;
}

export function emitOpenAIToolCallStarts(
    response: Response,
    onToolCallStart?: (call: NormalizedToolCall) => void,
): NormalizedToolCall[] {
    const calls = extractFunctionCalls(response).map((call) => ({
        id: call.call_id,
        name: call.name,
        input: parseToolArguments(call.arguments),
    }));
    for (const call of calls) onToolCallStart?.(call);
    return calls;
}

export function buildToolContinuationInput(
    response: Response,
    results: NormalizedToolResult[],
): ResponseInput {
    const responseItems = response.output.map((item: ResponseOutputItem) => {
        if ("status" in item && item.status === "failed") {
            throw new NamedOpenAIError(
                "OPENAI_TOOL_OUTPUT_FAILED",
                "OpenAI returned a failed output item.",
            );
        }
        // The SDK output union includes failed tool-output statuses that its
        // input union intentionally rejects. After the guard, completed
        // response items are the provider-prescribed continuation payload.
        return item as ResponseInputItem;
    });
    const toolOutputs: ResponseInputItem[] = results.map((result) => ({
        type: "function_call_output",
        call_id: result.tool_use_id,
        output: result.content,
    }));
    return [...responseItems, ...toolOutputs];
}

function elapsedSeconds(startedAt: number): number {
    return (Date.now() - startedAt) / 1000;
}

export async function consumeOpenAIStandardStream(
    stream: AsyncIterable<ResponseStreamEvent>,
    params: {
        enableThinking?: boolean;
        onDelta?: (delta: string) => void;
        onReasoningDelta?: (delta: string) => void;
        onReasoningBlockEnd?: () => void;
        abortSignal?: AbortSignal;
        startedAt?: number;
    },
): Promise<{
    response: Response;
    timeToFirstTokenSeconds?: number;
}> {
    const startedAt = params.startedAt ?? Date.now();
    let final: Response | null = null;
    let reasoningOpen = false;
    let timeToFirstTokenSeconds: number | undefined;

    for await (const event of stream) {
        throwIfAborted(params.abortSignal);
        if (event.type === "response.output_text.delta") {
            timeToFirstTokenSeconds ??= elapsedSeconds(startedAt);
            params.onDelta?.(event.delta);
        } else if (
            params.enableThinking &&
            (event.type === "response.reasoning_summary_text.delta" ||
                event.type === "response.reasoning_text.delta")
        ) {
            reasoningOpen = true;
            params.onReasoningDelta?.(event.delta);
        } else if (
            params.enableThinking &&
            (event.type === "response.reasoning_summary_text.done" ||
                event.type === "response.reasoning_text.done")
        ) {
            if (reasoningOpen) {
                params.onReasoningBlockEnd?.();
                reasoningOpen = false;
            }
        } else if (event.type === "response.completed") {
            final = event.response;
        } else if (event.type === "response.failed") {
            throw namedResponseError(
                "OPENAI_RESPONSE_FAILED",
                event.response.error?.message,
                "OpenAI response failed",
            );
        } else if (event.type === "response.incomplete") {
            throw namedResponseError(
                "OPENAI_RESPONSE_INCOMPLETE",
                event.response.incomplete_details?.reason,
                "OpenAI response incomplete",
            );
        } else if (event.type === "error") {
            throw namedResponseError(
                "OPENAI_STREAM_ERROR",
                event.message,
                "OpenAI stream failed",
            );
        }
    }
    if (!final) {
        throw new NamedOpenAIError(
            "OPENAI_STREAM_INCOMPLETE",
            "OpenAI stream ended without a completed response.",
        );
    }
    extractCompletedOpenAIOutput(final);
    return { response: final, timeToFirstTokenSeconds };
}

function aiInputMessages(
    systemPrompt: string | undefined,
    messages: StreamChatParams["messages"] | string,
) {
    const input =
        typeof messages === "string"
            ? [{ role: "user", content: messages }]
            : messages.map((message) => ({
                  role: message.role,
                  content: message.content,
              }));
    if (!systemPrompt) return input;
    return [{ role: "system", content: systemPrompt }, ...input];
}

export type NormalizedOpenAIUsage = {
    provider: "openai";
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    cacheCreation5mTokens: number;
    outputTokens: number;
    totalTokens: number;
    providerResponseId: string;
};

export function normalizeOpenAIUsage(response: Response): NormalizedOpenAIUsage {
    return {
        provider: "openai",
        model: response.model,
        inputTokens: response.usage?.input_tokens ?? 0,
        cachedInputTokens:
            response.usage?.input_tokens_details?.cached_tokens ?? 0,
        cacheCreation5mTokens:
            response.usage?.input_tokens_details?.cache_write_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
        providerResponseId: response.id,
    };
}

export function buildOpenAILedgerUsage(
    response: Response,
    params: Pick<StreamChatParams, "apiKeys" | "aiObservability">,
): RecordLlmUsageInput {
    const usage = normalizeOpenAIUsage(response);
    return {
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheCreation5mTokens: usage.cacheCreation5mTokens,
        outputTokens: usage.outputTokens,
        providerResponseId: usage.providerResponseId,
        billingSource: params.apiKeys?.sources?.openai ?? "account",
        context: {
            userId:
                params.apiKeys?.ownerUserId ??
                params.aiObservability?.distinctId,
            route: params.aiObservability?.route,
            chatId: params.aiObservability?.chatId,
            projectId: params.aiObservability?.projectId,
        },
    };
}

export type OpenAIGenerationMetadata = {
    requested_model: string | null;
    resolved_model: string | null;
    actual_response_model: string | null;
    reasoning_mode: ReasoningMode | null;
    reasoning_effort: ReasoningEffort | null;
    streaming: boolean;
    model_resolution_status:
        | NonNullable<AiObservabilityMetadata["model_resolution_status"]>
        | null;
};

export function buildOpenAIGenerationIdentity(input: {
    resolvedModel: string;
    actualResponseModel: string | null;
    streaming: boolean;
    metadata?: AiObservabilityMetadata;
}): { model: string; metadata: OpenAIGenerationMetadata } {
    return {
        model: input.actualResponseModel ?? input.resolvedModel,
        metadata: {
            requested_model:
                input.metadata?.requested_model ?? input.resolvedModel,
            resolved_model:
                input.metadata?.resolved_model ?? input.resolvedModel,
            actual_response_model: input.actualResponseModel,
            reasoning_mode: input.metadata?.reasoning_mode ?? null,
            reasoning_effort: input.metadata?.reasoning_effort ?? null,
            streaming: input.streaming,
            model_resolution_status:
                input.metadata?.model_resolution_status ?? "direct",
        },
    };
}

type RecordedOpenAIUsage = {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: LlmCost;
};

async function recordOpenAIUsage(input: {
    response: Response;
    params: Pick<StreamChatParams, "apiKeys" | "aiObservability">;
}): Promise<RecordedOpenAIUsage> {
    const normalized = normalizeOpenAIUsage(input.response);
    const ledgerUsage = buildOpenAILedgerUsage(input.response, input.params);
    const fallbackCost = calculateLlmCostNanos(ledgerUsage);

    try {
        const recorded = await recordLlmUsage(ledgerUsage);
        await Promise.all(
            recorded.newReports.map((report) => deliverSpendReport(report.id)),
        );
        return {
            inputTokens: normalized.inputTokens,
            outputTokens: normalized.outputTokens,
            totalTokens: normalized.totalTokens,
            cost: recorded.cost,
        };
    } catch (error) {
        console.error(
            "[llm-spend] failed to record OpenAI usage",
            safeErrorMessage(error, "LLM usage accounting failed"),
        );
        return {
            inputTokens: normalized.inputTokens,
            outputTokens: normalized.outputTokens,
            totalTokens: normalized.totalTokens,
            cost: fallbackCost,
        };
    }
}

async function createStreamingResponse(
    openai: OpenAI,
    params: {
        model: string;
        systemPrompt: string;
        input: ResponseInput;
        tools: Tool[];
        previousResponseId?: string;
        enableThinking?: boolean;
        reasoningEffort?: ReasoningEffort;
        textVerbosity?: TextVerbosity;
        textFormat?: JsonSchemaTextFormat;
        onDelta?: (delta: string) => void;
        onReasoningDelta?: (delta: string) => void;
        onReasoningBlockEnd?: () => void;
        abortSignal?: AbortSignal;
    },
): Promise<OpenAIResponseResult> {
    throwIfAborted(params.abortSignal);
    const startedAt = Date.now();
    const request = buildOpenAIStandardStreamingRequest({
        model: params.model,
        instructions: params.systemPrompt,
        input: params.input,
        previous_response_id: params.previousResponseId,
        tools: params.tools.length ? params.tools : undefined,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        reasoningEffort:
            params.reasoningEffort ??
            defaultReasoningEffort(
                params.model,
                params.enableThinking,
            ),
        text: textConfig(params.textVerbosity, params.textFormat),
        parallel_tool_calls: true,
    });
    const stream = await openai.responses.create(request, {
        signal: params.abortSignal,
    });
    const consumed = await consumeOpenAIStandardStream(
        stream as AsyncIterable<ResponseStreamEvent>,
        {
            enableThinking: params.enableThinking,
            onDelta: params.onDelta,
            onReasoningDelta: params.onReasoningDelta,
            onReasoningBlockEnd: params.onReasoningBlockEnd,
            abortSignal: params.abortSignal,
            startedAt,
        },
    );
    return {
        response: consumed.response,
        latencySeconds: elapsedSeconds(startedAt),
        timeToFirstTokenSeconds: consumed.timeToFirstTokenSeconds,
    };
}

async function createNonStreamingResponse(
    openai: OpenAI,
    params: {
        model: string;
        systemPrompt?: string;
        input: string | ResponseInput;
        tools?: Tool[];
        previousResponseId?: string;
        maxTokens?: number;
        enableThinking?: boolean;
        reasoningEffort?: ReasoningEffort;
        reasoningMode?: ReasoningMode;
        textVerbosity?: TextVerbosity;
        textFormat?: JsonSchemaTextFormat;
        abortSignal?: AbortSignal;
    },
): Promise<OpenAIResponseResult> {
    throwIfAborted(params.abortSignal);
    const startedAt = Date.now();
    const reasoningEffort =
        params.reasoningEffort ??
        defaultReasoningEffort(
            params.model,
            params.enableThinking,
        );
    const requestBase = {
        model: params.model,
        instructions: params.systemPrompt,
        input: params.input,
        previous_response_id: params.previousResponseId,
        tools: params.tools?.length ? params.tools : undefined,
        max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
        text: textConfig(params.textVerbosity, params.textFormat),
        parallel_tool_calls: true,
    };
    const response = params.reasoningMode === "pro"
        ? await openai.responses.create(
              buildOpenAIProNonStreamingRequest({
                  ...requestBase,
                  reasoningEffort: proReasoningEffort(reasoningEffort),
              }),
              { signal: params.abortSignal },
          )
        : await openai.responses.create(
              buildOpenAIStandardNonStreamingRequest({
                  ...requestBase,
                  reasoningEffort,
              }),
              { signal: params.abortSignal },
          );
    throwIfAborted(params.abortSignal);
    extractCompletedOpenAIOutput(response);
    return {
        response,
        latencySeconds: elapsedSeconds(startedAt),
    };
}

export async function streamOpenAI(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const openai = client(params.apiKeys?.openai);
    const openaiTools = toOpenAITools(tools);
    const reasoningMode = params.reasoningMode ?? "standard";
    const streaming = shouldStreamOpenAI(reasoningMode);
    let input = toInput(params.messages);
    let fullText = "";
    const traceId = params.aiObservability?.traceId || randomUUID();
    const parentId = traceId;

    for (let iter = 0; iter < maxIter; iter++) {
        throwIfAborted(params.abortSignal);
        const beforeLength = fullText.length;
        const generationId = randomUUID();
        const requestStartedAt = Date.now();
        let iterationText = "";
        let result: OpenAIResponseResult;
        try {
            result = streaming
                ? await createStreamingResponse(openai, {
                      model,
                      systemPrompt,
                      input,
                      tools: openaiTools,
                      enableThinking: params.enableThinking,
                      reasoningEffort: params.reasoningEffort,
                      textVerbosity: params.textVerbosity,
                      textFormat: params.textFormat,
                      onDelta: (delta) => {
                          iterationText += delta;
                          fullText += delta;
                          callbacks.onContentDelta?.(delta);
                      },
                      onReasoningDelta: callbacks.onReasoningDelta,
                      onReasoningBlockEnd: callbacks.onReasoningBlockEnd,
                      abortSignal: params.abortSignal,
                  })
                : await createNonStreamingResponse(openai, {
                      model,
                      systemPrompt,
                      input,
                      tools: openaiTools,
                      enableThinking: params.enableThinking,
                      reasoningEffort: params.reasoningEffort,
                      reasoningMode,
                      textVerbosity: params.textVerbosity,
                      textFormat: params.textFormat,
                      abortSignal: params.abortSignal,
                  });
        } catch (error) {
            const generationIdentity = buildOpenAIGenerationIdentity({
                resolvedModel: model,
                actualResponseModel: null,
                streaming,
                metadata: params.aiObservability?.metadata,
            });
            await captureAiGeneration({
                distinctId: params.aiObservability?.distinctId,
                traceId,
                generationId,
                parentId,
                sessionId: params.aiObservability?.sessionId,
                spanName: params.aiObservability?.spanName || "Chat completion",
                route: params.aiObservability?.route,
                chatId: params.aiObservability?.chatId,
                projectId: params.aiObservability?.projectId,
                model: generationIdentity.model,
                provider: "openai",
                stream: streaming,
                latencySeconds: elapsedSeconds(requestStartedAt),
                input: aiInputMessages(systemPrompt, params.messages),
                output: "",
                error: safeErrorMessage(error),
                metadata: {
                    iteration: iter + 1,
                    tool_count: openaiTools.length,
                    ...generationIdentity.metadata,
                },
            });
            throw error;
        }

        const { response } = result;
        throwIfAborted(params.abortSignal);
        const shouldEmitCompletedContent =
            !streaming || fullText.length === beforeLength;
        const completedOutput = shouldEmitCompletedContent
            ? emitCompletedOpenAIContent(
                  response,
                  callbacks.onContentDelta,
              )
            : extractCompletedOpenAIOutput(response);
        if (shouldEmitCompletedContent && completedOutput.text) {
            iterationText += completedOutput.text;
            fullText += completedOutput.text;
        }

        const usage = await recordOpenAIUsage({ response, params });
        const generationIdentity = buildOpenAIGenerationIdentity({
            resolvedModel: model,
            actualResponseModel: response.model,
            streaming,
            metadata: params.aiObservability?.metadata,
        });

        await captureAiGeneration({
            distinctId: params.aiObservability?.distinctId,
            traceId,
            generationId,
            parentId,
            sessionId: params.aiObservability?.sessionId,
            spanName: params.aiObservability?.spanName || "Chat completion",
            route: params.aiObservability?.route,
            chatId: params.aiObservability?.chatId,
            projectId: params.aiObservability?.projectId,
            model: generationIdentity.model,
            provider: "openai",
            stream: streaming,
            latencySeconds: result.latencySeconds,
            timeToFirstTokenSeconds: result.timeToFirstTokenSeconds,
            input: aiInputMessages(systemPrompt, params.messages),
            output: iterationText || completedOutput.text,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            inputCostUsd: spendUsd(
                usage.cost.inputCostNanos + usage.cost.cachedInputCostNanos,
            ),
            outputCostUsd: spendUsd(usage.cost.outputCostNanos),
            totalCostUsd: spendUsd(usage.cost.totalCostNanos),
            metadata: {
                iteration: iter + 1,
                tool_count: openaiTools.length,
                function_call_count: extractFunctionCalls(response).length,
                ...generationIdentity.metadata,
            },
        });

        const calls = extractFunctionCalls(response);
        if (!calls.length || !runTools) break;

        const normalizedCalls = emitOpenAIToolCallStarts(
            response,
            callbacks.onToolCallStart,
        );

        throwIfAborted(params.abortSignal);
        const results = await runTools(normalizedCalls);
        throwIfAborted(params.abortSignal);
        input = [
            ...input,
            ...buildToolContinuationInput(response, results),
        ];
    }

    return { fullText };
}

export async function completeOpenAIText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    abortSignal?: AbortSignal;
    apiKeys?: StreamChatParams["apiKeys"];
    reasoningEffort?: ReasoningEffort;
    textVerbosity?: TextVerbosity;
    textFormat?: JsonSchemaTextFormat;
    aiObservability?: StreamChatParams["aiObservability"];
}): Promise<string> {
    const openai = client(params.apiKeys?.openai);
    const traceId = params.aiObservability?.traceId || randomUUID();
    const generationId = randomUUID();
    const requestStartedAt = Date.now();
    try {
        const result = await createNonStreamingResponse(openai, {
            model: params.model,
            systemPrompt: params.systemPrompt,
            input: params.user,
            maxTokens: params.maxTokens ?? 512,
            abortSignal: params.abortSignal,
            reasoningEffort: params.reasoningEffort,
            textVerbosity: params.textVerbosity,
            textFormat: params.textFormat,
        });
        const text = extractCompletedOpenAIOutput(result.response).text;
        const usage = await recordOpenAIUsage({
            response: result.response,
            params,
        });
        const generationIdentity = buildOpenAIGenerationIdentity({
            resolvedModel: params.model,
            actualResponseModel: result.response.model,
            streaming: false,
            metadata: params.aiObservability?.metadata,
        });
        await captureAiGeneration({
            distinctId: params.aiObservability?.distinctId,
            traceId,
            generationId,
            parentId: traceId,
            sessionId: params.aiObservability?.sessionId,
            spanName: params.aiObservability?.spanName || "Text completion",
            route: params.aiObservability?.route,
            chatId: params.aiObservability?.chatId,
            projectId: params.aiObservability?.projectId,
            model: generationIdentity.model,
            provider: "openai",
            stream: false,
            latencySeconds: result.latencySeconds,
            input: aiInputMessages(params.systemPrompt, params.user),
            output: text,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            inputCostUsd: spendUsd(
                usage.cost.inputCostNanos + usage.cost.cachedInputCostNanos,
            ),
            outputCostUsd: spendUsd(usage.cost.outputCostNanos),
            totalCostUsd: spendUsd(usage.cost.totalCostNanos),
            metadata: generationIdentity.metadata,
        });
        return text;
    } catch (error) {
        const generationIdentity = buildOpenAIGenerationIdentity({
            resolvedModel: params.model,
            actualResponseModel: null,
            streaming: false,
            metadata: params.aiObservability?.metadata,
        });
        await captureAiGeneration({
            distinctId: params.aiObservability?.distinctId,
            traceId,
            generationId,
            parentId: traceId,
            sessionId: params.aiObservability?.sessionId,
            spanName: params.aiObservability?.spanName || "Text completion",
            route: params.aiObservability?.route,
            chatId: params.aiObservability?.chatId,
            projectId: params.aiObservability?.projectId,
            model: generationIdentity.model,
            provider: "openai",
            stream: false,
            latencySeconds: elapsedSeconds(requestStartedAt),
            input: aiInputMessages(params.systemPrompt, params.user),
            output: "",
            error: safeErrorMessage(error),
            metadata: generationIdentity.metadata,
        });
        throw error;
    }
}
