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
    ProviderRunProgress,
    ReasoningEffort,
    ReasoningMode,
    StreamChatParams,
    StreamChatResult,
    TextVerbosity,
} from "./types";
import { isAbortError, throwIfAborted } from "./types";
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
const BACKGROUND_POLL_INTERVAL_MS = 2_000;
const BACKGROUND_MAX_WAIT_MS = 20 * 60 * 1_000;
const BACKGROUND_REQUEST_TIMEOUT_MS = 30_000;

type OpenAIProviderRunUpdate = Omit<
    ProviderRunProgress,
    "provider" | "iteration"
>;

type OpenAIResponseResult = {
    response: Response;
    latencySeconds: number;
    timeToFirstTokenSeconds?: number;
    providerRequestId?: string | null;
    background: boolean;
    recoveryAttempted: boolean;
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

type OpenAIProviderIdentifiers = {
    providerResponseId?: string | null;
    providerRequestId?: string | null;
    lastSequenceNumber?: number | null;
    recoveryAttempted?: boolean;
};

class NamedOpenAIError extends Error {
    readonly providerResponseId: string | null;
    readonly providerRequestId: string | null;
    readonly lastSequenceNumber: number | null;
    readonly recoveryAttempted: boolean;

    constructor(
        name: string,
        message: string,
        identifiers: OpenAIProviderIdentifiers = {},
    ) {
        super(message);
        this.name = name;
        this.providerResponseId = identifiers.providerResponseId ?? null;
        this.providerRequestId = identifiers.providerRequestId ?? null;
        this.lastSequenceNumber = identifiers.lastSequenceNumber ?? null;
        this.recoveryAttempted = identifiers.recoveryAttempted ?? false;
    }
}

function providerIdentifiers(error: unknown): OpenAIProviderIdentifiers {
    if (!error || typeof error !== "object") return {};
    const candidate = error as {
        providerResponseId?: unknown;
        providerRequestId?: unknown;
        lastSequenceNumber?: unknown;
        recoveryAttempted?: unknown;
        request_id?: unknown;
    };
    return {
        providerResponseId:
            typeof candidate.providerResponseId === "string"
                ? candidate.providerResponseId
                : null,
        providerRequestId:
            typeof candidate.providerRequestId === "string"
                ? candidate.providerRequestId
                : typeof candidate.request_id === "string"
                  ? candidate.request_id
                  : null,
        lastSequenceNumber:
            typeof candidate.lastSequenceNumber === "number"
                ? candidate.lastSequenceNumber
                : null,
        recoveryAttempted: candidate.recoveryAttempted === true,
    };
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

export function shouldUseOpenAIBackground(
    reasoningMode: ReasoningMode,
    reasoningEffort?: ReasoningEffort,
): boolean {
    return reasoningMode === "pro" || reasoningEffort === "max";
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

export function buildOpenAIProBackgroundRequest(
    input: Omit<OpenAIRequestBuilderInput, "reasoningEffort"> & {
        reasoningEffort: Gpt56ProReasoningEffort;
    },
): ResponseCreateParamsNonStreaming {
    const { reasoningEffort, ...request } = input;
    return {
        ...request,
        reasoning: { effort: reasoningEffort, mode: "pro" },
        background: true,
        store: true,
        stream: false,
    };
}

/** @deprecated Use buildOpenAIProBackgroundRequest. */
export const buildOpenAIProNonStreamingRequest =
    buildOpenAIProBackgroundRequest;

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
    identifiers: OpenAIProviderIdentifiers = {},
): NamedOpenAIError {
    return new NamedOpenAIError(
        name,
        safeErrorMessage(unsafeMessage, fallback),
        identifiers,
    );
}

export function extractCompletedOpenAIOutput(
    response: Response,
): CompletedOpenAIOutput {
    if (response.status === "failed") {
        throw namedResponseError(
            "OPENAI_RESPONSE_FAILED",
            response.error?.message,
            "OpenAI response failed",
            { providerResponseId: response.id },
        );
    }
    if (response.status === "incomplete") {
        throw namedResponseError(
            "OPENAI_RESPONSE_INCOMPLETE",
            response.incomplete_details?.reason,
            "OpenAI response incomplete",
            { providerResponseId: response.id },
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
        { providerResponseId: response.id },
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

type OpenAIStreamConsumeParams = {
    enableThinking?: boolean;
    onDelta?: (delta: string) => void;
    onReasoningDelta?: (delta: string) => void;
    onReasoningBlockEnd?: () => void;
    abortSignal?: AbortSignal;
    startedAt?: number;
    onResponseId?: (responseId: string) => void | Promise<void>;
};

type OpenAIStreamState = {
    final: Response | null;
    reasoningOpen: boolean;
    timeToFirstTokenSeconds?: number;
    providerResponseId: string | null;
    lastSequenceNumber: number | null;
};

function responseIdFromEvent(event: ResponseStreamEvent): string | null {
    if (!("response" in event)) return null;
    const response = event.response as { id?: unknown } | undefined;
    return typeof response?.id === "string" ? response.id : null;
}

async function consumeOpenAIStreamSegment(
    stream: AsyncIterable<ResponseStreamEvent>,
    params: OpenAIStreamConsumeParams,
    state: OpenAIStreamState,
): Promise<void> {
    const startedAt = params.startedAt ?? Date.now();
    for await (const event of stream) {
        throwIfAborted(params.abortSignal);
        const sequenceNumber = (event as { sequence_number?: unknown })
            .sequence_number;
        if (typeof sequenceNumber === "number") {
            state.lastSequenceNumber = sequenceNumber;
        }
        const eventResponseId = responseIdFromEvent(event);
        if (eventResponseId && eventResponseId !== state.providerResponseId) {
            state.providerResponseId = eventResponseId;
            await params.onResponseId?.(eventResponseId);
        }

        if (event.type === "response.output_text.delta") {
            state.timeToFirstTokenSeconds ??= elapsedSeconds(startedAt);
            params.onDelta?.(event.delta);
        } else if (
            params.enableThinking &&
            (event.type === "response.reasoning_summary_text.delta" ||
                event.type === "response.reasoning_text.delta")
        ) {
            state.reasoningOpen = true;
            params.onReasoningDelta?.(event.delta);
        } else if (
            params.enableThinking &&
            (event.type === "response.reasoning_summary_text.done" ||
                event.type === "response.reasoning_text.done")
        ) {
            if (state.reasoningOpen) {
                params.onReasoningBlockEnd?.();
                state.reasoningOpen = false;
            }
        } else if (event.type === "response.completed") {
            state.final = event.response;
        } else if (event.type === "response.failed") {
            throw namedResponseError(
                "OPENAI_RESPONSE_FAILED",
                event.response.error?.message,
                "OpenAI response failed",
                {
                    providerResponseId: state.providerResponseId,
                    lastSequenceNumber: state.lastSequenceNumber,
                },
            );
        } else if (event.type === "response.incomplete") {
            throw namedResponseError(
                "OPENAI_RESPONSE_INCOMPLETE",
                event.response.incomplete_details?.reason,
                "OpenAI response incomplete",
                {
                    providerResponseId: state.providerResponseId,
                    lastSequenceNumber: state.lastSequenceNumber,
                },
            );
        } else if (event.type === "error") {
            throw namedResponseError(
                "OPENAI_STREAM_ERROR",
                event.message,
                "OpenAI stream failed",
                {
                    providerResponseId: state.providerResponseId,
                    lastSequenceNumber: state.lastSequenceNumber,
                },
            );
        }
    }
}

function incompleteStreamError(
    state: OpenAIStreamState,
    recoveryAttempted: boolean,
): NamedOpenAIError {
    return new NamedOpenAIError(
        "OPENAI_STREAM_INCOMPLETE",
        "OpenAI stream ended without a completed response.",
        {
            providerResponseId: state.providerResponseId,
            lastSequenceNumber: state.lastSequenceNumber,
            recoveryAttempted,
        },
    );
}

export async function consumeOpenAIStandardStream(
    stream: AsyncIterable<ResponseStreamEvent>,
    params: OpenAIStreamConsumeParams,
): Promise<{
    response: Response;
    timeToFirstTokenSeconds?: number;
    providerResponseId: string | null;
    lastSequenceNumber: number | null;
}> {
    const state: OpenAIStreamState = {
        final: null,
        reasoningOpen: false,
        providerResponseId: null,
        lastSequenceNumber: null,
    };
    await consumeOpenAIStreamSegment(stream, params, state);
    if (!state.final) {
        throw incompleteStreamError(state, false);
    }
    extractCompletedOpenAIOutput(state.final);
    return {
        response: state.final,
        timeToFirstTokenSeconds: state.timeToFirstTokenSeconds,
        providerResponseId: state.providerResponseId,
        lastSequenceNumber: state.lastSequenceNumber,
    };
}

export async function consumeOpenAIStreamWithSingleResume(
    stream: AsyncIterable<ResponseStreamEvent>,
    params: OpenAIStreamConsumeParams & {
        resume: (
            responseId: string,
            startingAfter: number | null,
        ) => Promise<AsyncIterable<ResponseStreamEvent>>;
        onResume?: (
            responseId: string,
            startingAfter: number | null,
        ) => void | Promise<void>;
    },
): Promise<{
    response: Response;
    timeToFirstTokenSeconds?: number;
    providerResponseId: string | null;
    lastSequenceNumber: number | null;
    recoveryAttempted: boolean;
}> {
    const state: OpenAIStreamState = {
        final: null,
        reasoningOpen: false,
        providerResponseId: null,
        lastSequenceNumber: null,
    };
    await consumeOpenAIStreamSegment(stream, params, state);
    let recoveryAttempted = false;

    if (!state.final && state.providerResponseId) {
        recoveryAttempted = true;
        await params.onResume?.(
            state.providerResponseId,
            state.lastSequenceNumber,
        );
        const resumed = await params.resume(
            state.providerResponseId,
            state.lastSequenceNumber,
        );
        await consumeOpenAIStreamSegment(resumed, params, state);
    }

    if (!state.final) {
        throw new NamedOpenAIError(
            "OPENAI_STREAM_INCOMPLETE",
            "OpenAI stream ended without a completed response.",
            {
                providerResponseId: state.providerResponseId,
                lastSequenceNumber: state.lastSequenceNumber,
                recoveryAttempted,
            },
        );
    }
    extractCompletedOpenAIOutput(state.final);
    return {
        response: state.final,
        timeToFirstTokenSeconds: state.timeToFirstTokenSeconds,
        providerResponseId: state.providerResponseId,
        lastSequenceNumber: state.lastSequenceNumber,
        recoveryAttempted,
    };
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
    assistant_run_id?: string;
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
            ...(typeof input.metadata?.assistant_run_id === "string" &&
            input.metadata.assistant_run_id
                ? { assistant_run_id: input.metadata.assistant_run_id }
                : {}),
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
        metadata?: ResponseCreateParamsBase["metadata"];
        onDelta?: (delta: string) => void;
        onReasoningDelta?: (delta: string) => void;
        onReasoningBlockEnd?: () => void;
        abortSignal?: AbortSignal;
        background?: boolean;
        onProviderProgress?: (
            progress: OpenAIProviderRunUpdate,
        ) => void | Promise<void>;
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
        ...(params.metadata ? { metadata: params.metadata } : {}),
        ...(params.background ? { background: true, store: true } : {}),
    });
    const created = await openai.responses
        .create(request, {
            signal: params.abortSignal,
            ...(params.background
                ? {
                      timeout: BACKGROUND_REQUEST_TIMEOUT_MS,
                      maxRetries: 2,
                  }
                : {}),
        })
        .withResponse();
    let providerRequestId = created.request_id;
    let providerResponseId: string | null = null;
    let consumed: Awaited<
        ReturnType<typeof consumeOpenAIStreamWithSingleResume>
    >;
    try {
        consumed = await consumeOpenAIStreamWithSingleResume(
            created.data as AsyncIterable<ResponseStreamEvent>,
            {
            enableThinking: params.enableThinking,
            onDelta: params.onDelta,
            onReasoningDelta: params.onReasoningDelta,
            onReasoningBlockEnd: params.onReasoningBlockEnd,
                abortSignal: params.abortSignal,
                startedAt,
                onResponseId: async (responseId) => {
                    providerResponseId = responseId;
                    await params.onProviderProgress?.({
                        phase: "started",
                        background: params.background ?? false,
                        providerResponseId,
                        providerRequestId,
                        providerStatus: params.background
                            ? "in_progress"
                            : null,
                        recoveryAttempted: false,
                    });
                },
                onResume: async (responseId, startingAfter) => {
                    console.warn("[openai] resuming incomplete response stream", {
                        provider_response_id: responseId,
                        provider_request_id: providerRequestId,
                        starting_after: startingAfter,
                    });
                    await params.onProviderProgress?.({
                        phase: "resuming",
                        background: params.background ?? false,
                        providerResponseId: responseId,
                        providerRequestId,
                        providerStatus: params.background
                            ? "in_progress"
                            : null,
                        lastSequenceNumber: startingAfter,
                        recoveryAttempted: true,
                    });
                },
                resume: async (responseId, startingAfter) => {
                    const resumed = await openai.responses
                        .retrieve(
                            responseId,
                            {
                                stream: true,
                                ...(startingAfter === null
                                    ? {}
                                    : { starting_after: startingAfter }),
                            },
                            {
                                signal: params.abortSignal,
                                timeout: BACKGROUND_REQUEST_TIMEOUT_MS,
                            },
                        )
                        .withResponse();
                    providerRequestId = resumed.request_id ?? providerRequestId;
                    return resumed.data as AsyncIterable<ResponseStreamEvent>;
                },
            },
        );
    } catch (error) {
        if (
            params.background &&
            providerResponseId
        ) {
            await cancelBackgroundResponse(openai, providerResponseId);
        }
        if (error instanceof NamedOpenAIError && !error.providerRequestId) {
            throw new NamedOpenAIError(error.name, error.message, {
                providerResponseId:
                    error.providerResponseId ?? providerResponseId,
                providerRequestId,
                lastSequenceNumber: error.lastSequenceNumber,
                recoveryAttempted: error.recoveryAttempted,
            });
        }
        throw error;
    }
    await params.onProviderProgress?.({
        phase: "completed",
        background: params.background ?? false,
        providerResponseId:
            consumed.providerResponseId ?? consumed.response.id,
        providerRequestId,
        providerStatus: consumed.response.status,
        lastSequenceNumber: consumed.lastSequenceNumber,
        recoveryAttempted: consumed.recoveryAttempted,
    });
    return {
        response: consumed.response,
        latencySeconds: elapsedSeconds(startedAt),
        timeToFirstTokenSeconds: consumed.timeToFirstTokenSeconds,
        providerRequestId,
        background: params.background ?? false,
        recoveryAttempted: consumed.recoveryAttempted,
    };
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            const error = new Error("Stream aborted.");
            error.name = "AbortError";
            reject(error);
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

async function requestBackgroundResponseCancellation(
    openai: Pick<OpenAI, "responses">,
    responseId: string,
): Promise<void> {
    await openai.responses.cancel(responseId, {
        timeout: BACKGROUND_REQUEST_TIMEOUT_MS,
        maxRetries: 2,
    });
    console.info("[openai] cancelled background response", {
        provider_response_id: responseId,
    });
}

async function cancelBackgroundResponse(
    openai: Pick<OpenAI, "responses">,
    responseId: string,
): Promise<void> {
    try {
        await requestBackgroundResponseCancellation(openai, responseId);
    } catch (error) {
        console.warn("[openai] failed to cancel background response", {
            provider_response_id: responseId,
            error: safeErrorMessage(error, "OpenAI cancellation failed"),
        });
    }
}

export async function retrieveOpenAIBackgroundResponse(input: {
    apiKey?: string | null;
    responseId: string;
    abortSignal?: AbortSignal;
}): Promise<{ response: Response; providerRequestId: string | null }> {
    const openai = client(input.apiKey);
    const retrieved = await openai.responses
        .retrieve(input.responseId, undefined, {
            signal: input.abortSignal,
            timeout: BACKGROUND_REQUEST_TIMEOUT_MS,
            maxRetries: 2,
        })
        .withResponse();
    return {
        response: retrieved.data,
        providerRequestId: retrieved.request_id ?? null,
    };
}

export async function cancelOpenAIBackgroundResponse(input: {
    apiKey?: string | null;
    responseId: string;
}): Promise<void> {
    // Direct user/recovery cancellation must surface failure so the durable
    // cancel_requested row remains retryable. Provider-cleanup calls inside the
    // streaming adapter intentionally use the best-effort wrapper above.
    await requestBackgroundResponseCancellation(
        client(input.apiKey),
        input.responseId,
    );
}

export function openAIResponseHasFunctionCalls(response: Response): boolean {
    return extractFunctionCalls(response).length > 0;
}

export async function waitForOpenAIBackgroundResponse(
    openai: Pick<OpenAI, "responses">,
    initial: Response,
    params: {
        abortSignal?: AbortSignal;
        providerRequestId?: string | null;
        onProviderProgress?: (
            progress: OpenAIProviderRunUpdate,
        ) => void | Promise<void>;
        pollIntervalMs?: number;
        maxWaitMs?: number;
    },
): Promise<{ response: Response; providerRequestId: string | null }> {
    let response = initial;
    let providerRequestId = params.providerRequestId ?? null;
    const startedAt = Date.now();

    console.info("[openai] background response started", {
        provider_response_id: response.id,
        provider_request_id: providerRequestId,
        status: response.status,
    });
    try {
        await params.onProviderProgress?.({
            phase: "started",
            background: true,
            providerResponseId: response.id,
            providerRequestId,
            providerStatus: response.status,
            recoveryAttempted: false,
        });
        while (response.status === "queued" || response.status === "in_progress") {
            if (
                Date.now() - startedAt >=
                (params.maxWaitMs ?? BACKGROUND_MAX_WAIT_MS)
            ) {
                throw new NamedOpenAIError(
                    "OPENAI_BACKGROUND_TIMEOUT",
                    "The Pro response is still running after the background wait limit. Retry in Standard mode or try again later.",
                    {
                        providerResponseId: response.id,
                        providerRequestId,
                    },
                );
            }
            await delayWithAbort(
                params.pollIntervalMs ?? BACKGROUND_POLL_INTERVAL_MS,
                params.abortSignal,
            );
            const retrieved = await openai.responses
                .retrieve(response.id, undefined, {
                    signal: params.abortSignal,
                    timeout: BACKGROUND_REQUEST_TIMEOUT_MS,
                    maxRetries: 2,
                })
                .withResponse();
            response = retrieved.data;
            providerRequestId = retrieved.request_id ?? providerRequestId;
            await params.onProviderProgress?.({
                phase: "polling",
                background: true,
                providerResponseId: response.id,
                providerRequestId,
                providerStatus: response.status,
                recoveryAttempted: false,
            });
        }
    } catch (error) {
        if (isAbortError(error) || params.abortSignal?.aborted) {
            await cancelBackgroundResponse(openai, response.id);
            throw new NamedOpenAIError(
                "AbortError",
                "Stream aborted.",
                {
                    providerResponseId: response.id,
                    providerRequestId,
                },
            );
        }
        if (
            error instanceof NamedOpenAIError &&
            error.name === "OPENAI_BACKGROUND_TIMEOUT"
        ) {
            await cancelBackgroundResponse(openai, response.id);
        } else if (!isAbortError(error)) {
            await cancelBackgroundResponse(openai, response.id);
        }
        throw error;
    }

    console.info("[openai] background response reached terminal state", {
        provider_response_id: response.id,
        provider_request_id: providerRequestId,
        status: response.status,
        latency_seconds: elapsedSeconds(startedAt),
    });
    await params.onProviderProgress?.({
        phase: "completed",
        background: true,
        providerResponseId: response.id,
        providerRequestId,
        providerStatus: response.status,
        recoveryAttempted: false,
    });
    return { response, providerRequestId };
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
        metadata?: ResponseCreateParamsBase["metadata"];
        abortSignal?: AbortSignal;
        onProviderProgress?: (
            progress: OpenAIProviderRunUpdate,
        ) => void | Promise<void>;
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
        ...(params.metadata ? { metadata: params.metadata } : {}),
    };
    const isBackground = params.reasoningMode === "pro";
    const created = await (isBackground
        ? openai.responses.create(
              buildOpenAIProBackgroundRequest({
                  ...requestBase,
                  reasoningEffort: proReasoningEffort(reasoningEffort),
              }),
              {
                  signal: params.abortSignal,
                  timeout: BACKGROUND_REQUEST_TIMEOUT_MS,
                  maxRetries: 2,
              },
          )
        : openai.responses.create(
              buildOpenAIStandardNonStreamingRequest({
                  ...requestBase,
                  reasoningEffort,
              }),
              { signal: params.abortSignal },
          )).withResponse();
    const backgroundResult = isBackground
        ? await waitForOpenAIBackgroundResponse(openai, created.data, {
              abortSignal: params.abortSignal,
              providerRequestId: created.request_id,
              onProviderProgress: params.onProviderProgress,
          })
        : { response: created.data, providerRequestId: created.request_id };
    const response = backgroundResult.response;
    throwIfAborted(params.abortSignal);
    extractCompletedOpenAIOutput(response);
    return {
        response,
        latencySeconds: elapsedSeconds(startedAt),
        providerRequestId: backgroundResult.providerRequestId,
        background: isBackground,
        recoveryAttempted: false,
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
    const background = shouldUseOpenAIBackground(
        reasoningMode,
        params.reasoningEffort,
    );
    let input = toInput(params.messages);
    let fullText = "";
    const traceId = params.aiObservability?.traceId || randomUUID();
    const parentId = traceId;
    const assistantRunId =
        params.aiObservability?.metadata?.assistant_run_id;
    const responseMetadata =
        typeof assistantRunId === "string" && assistantRunId
            ? {
                  docket_run_id: assistantRunId,
                  docket_trace_id: traceId,
              }
            : undefined;

    for (let iter = 0; iter < maxIter; iter++) {
        throwIfAborted(params.abortSignal);
        const beforeLength = fullText.length;
        const generationId = randomUUID();
        const requestStartedAt = Date.now();
        let iterationText = "";
        let result: OpenAIResponseResult;
        const reportProviderProgress = params.onProviderRunProgress
            ? (progress: OpenAIProviderRunUpdate) =>
                  params.onProviderRunProgress?.({
                      provider: "openai",
                      iteration: iter + 1,
                      ...progress,
                  })
            : undefined;
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
                      metadata: responseMetadata,
                      onDelta: (delta) => {
                          iterationText += delta;
                          fullText += delta;
                          callbacks.onContentDelta?.(delta);
                      },
                      onReasoningDelta: callbacks.onReasoningDelta,
                      onReasoningBlockEnd: callbacks.onReasoningBlockEnd,
                      abortSignal: params.abortSignal,
                      background,
                      onProviderProgress: reportProviderProgress,
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
                      metadata: responseMetadata,
                      abortSignal: params.abortSignal,
                      onProviderProgress: reportProviderProgress,
                  });
        } catch (error) {
            const identifiers = providerIdentifiers(error);
            if (params.onProviderRunProgress) {
                try {
                    await params.onProviderRunProgress({
                        provider: "openai",
                        iteration: iter + 1,
                        phase: "failed",
                        background,
                        providerResponseId:
                            identifiers.providerResponseId ?? null,
                        providerRequestId:
                            identifiers.providerRequestId ?? null,
                        providerStatus: "failed",
                        lastSequenceNumber:
                            identifiers.lastSequenceNumber ?? null,
                        recoveryAttempted:
                            identifiers.recoveryAttempted ?? false,
                    });
                } catch (progressError) {
                    console.error(
                        "[openai] failed to persist provider failure state",
                        safeErrorMessage(
                            progressError,
                            "Provider progress persistence failed",
                        ),
                    );
                }
            }
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
                    provider_response_id:
                        identifiers.providerResponseId ?? null,
                    provider_request_id:
                        identifiers.providerRequestId ?? null,
                    stream_last_sequence_number:
                        identifiers.lastSequenceNumber ?? null,
                    stream_recovery_attempted:
                        identifiers.recoveryAttempted ?? false,
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
                provider_response_id: response.id,
                provider_request_id: result.providerRequestId ?? null,
                background: result.background,
                stream_recovery_attempted: result.recoveryAttempted,
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
