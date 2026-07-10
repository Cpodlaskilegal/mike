import OpenAI from "openai";
import { randomUUID } from "crypto";
import type {
    Response,
    ResponseFunctionToolCall,
    ResponseInput,
    ResponseInputItem,
    ResponseStreamEvent,
    ResponseTextConfig,
    Tool,
} from "openai/resources/responses/responses";
import type {
    JsonSchemaTextFormat,
    NormalizedToolCall,
    ReasoningEffort,
    StreamChatParams,
    StreamChatResult,
    TextVerbosity,
} from "./types";
import { throwIfAborted } from "./types";
import { captureAiGeneration } from "../posthog";
import {
    calculateLlmCostNanos,
    deliverSpendReport,
    recordLlmUsage,
    spendUsd,
    type LlmCost,
} from "../llmSpend";
import { safeErrorMessage } from "../safeError";

const MAX_OUTPUT_TOKENS = 16384;

type OpenAIResponseResult = {
    response: Response;
    latencySeconds: number;
    timeToFirstTokenSeconds?: number;
};

function client(apiKeyOverride?: string | null): OpenAI {
    const apiKey = apiKeyOverride?.trim() || process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
        throw new Error(
            "An OpenAI API key is required to use OpenAI models. Configure OPENAI_API_KEY or save a user OpenAI key before selecting an OpenAI model.",
        );
    }
    return new OpenAI({ apiKey });
}

function isProModel(model: string): boolean {
    return model === "gpt-5.5-pro";
}

function defaultReasoningEffort(
    model: string,
    enableThinking?: boolean,
): ReasoningEffort {
    // OpenAI pro models are explicitly high-reasoning/non-streaming. For the
    // normal chat surface, mirror Claude/Gemini by spending reasoning only
    // where the UI is prepared to show it; extraction and short generated text
    // stay lean unless a caller overrides this.
    if (isProModel(model)) return "high";
    if (enableThinking) {
        if (model.endsWith("-mini") || model.endsWith("-nano")) return "low";
        return "medium";
    }
    if (model.endsWith("-nano")) return "none";
    return "low";
}

function reasoningForModel(
    model: string,
    reasoningEffort?: ReasoningEffort,
    enableThinking?: boolean,
) {
    return {
        effort: reasoningEffort ?? defaultReasoningEffort(model, enableThinking),
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

function outputText(response: Response): string {
    return response.output_text ?? "";
}

function elapsedSeconds(startedAt: number): number {
    return (Date.now() - startedAt) / 1000;
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

type RecordedOpenAIUsage = {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: LlmCost;
};

async function recordOpenAIUsage(input: {
    model: string;
    response: Response;
    params: Pick<StreamChatParams, "apiKeys" | "aiObservability">;
}): Promise<RecordedOpenAIUsage> {
    const inputTokens = input.response.usage?.input_tokens ?? 0;
    const cachedInputTokens =
        input.response.usage?.input_tokens_details?.cached_tokens ?? 0;
    const outputTokens = input.response.usage?.output_tokens ?? 0;
    const totalTokens = input.response.usage?.total_tokens ?? 0;
    const costInput = {
        provider: "openai" as const,
        model: input.model,
        inputTokens,
        cachedInputTokens,
        outputTokens,
    };
    const fallbackCost = calculateLlmCostNanos(costInput);

    try {
        const recorded = await recordLlmUsage({
            ...costInput,
            providerResponseId: input.response.id,
            billingSource: input.params.apiKeys?.sources?.openai ?? "account",
            context: {
                userId:
                    input.params.apiKeys?.ownerUserId ??
                    input.params.aiObservability?.distinctId,
                route: input.params.aiObservability?.route,
                chatId: input.params.aiObservability?.chatId,
                projectId: input.params.aiObservability?.projectId,
            },
        });
        await Promise.all(
            recorded.newReports.map((report) => deliverSpendReport(report.id)),
        );
        return { inputTokens, outputTokens, totalTokens, cost: recorded.cost };
    } catch (error) {
        console.error(
            "[llm-spend] failed to record OpenAI usage",
            safeErrorMessage(error, "LLM usage accounting failed"),
        );
        return { inputTokens, outputTokens, totalTokens, cost: fallbackCost };
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
    const stream = await openai.responses.create({
        model: params.model,
        instructions: params.systemPrompt,
        input: params.input,
        previous_response_id: params.previousResponseId,
        tools: params.tools.length ? params.tools : undefined,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        reasoning: reasoningForModel(
            params.model,
            params.reasoningEffort,
            params.enableThinking,
        ),
        text: textConfig(params.textVerbosity, params.textFormat),
        parallel_tool_calls: true,
        stream: true,
    }, { signal: params.abortSignal });

    let final: Response | null = null;
    let reasoningOpen = false;
    let timeToFirstTokenSeconds: number | undefined;
    for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
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
            throw new Error(event.response.error?.message ?? "OpenAI response failed");
        } else if (event.type === "response.incomplete") {
            throw new Error(
                event.response.incomplete_details?.reason ??
                    "OpenAI response incomplete",
            );
        } else if (event.type === "error") {
            throw new Error(event.message);
        }
    }
    if (!final) throw new Error("OpenAI stream ended without a completed response");
    return {
        response: final,
        latencySeconds: elapsedSeconds(startedAt),
        timeToFirstTokenSeconds,
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
        textVerbosity?: TextVerbosity;
        textFormat?: JsonSchemaTextFormat;
        abortSignal?: AbortSignal;
    },
): Promise<OpenAIResponseResult> {
    throwIfAborted(params.abortSignal);
    const startedAt = Date.now();
    const response = await openai.responses.create({
        model: params.model,
        instructions: params.systemPrompt,
        input: params.input,
        previous_response_id: params.previousResponseId,
        tools: params.tools?.length ? params.tools : undefined,
        max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
        reasoning: reasoningForModel(
            params.model,
            params.reasoningEffort,
            params.enableThinking,
        ),
        text: textConfig(params.textVerbosity, params.textFormat),
        parallel_tool_calls: true,
        stream: false,
    }, { signal: params.abortSignal });
    throwIfAborted(params.abortSignal);
    if (response.status === "failed") {
        throw new Error(response.error?.message ?? "OpenAI response failed");
    }
    if (response.status === "incomplete") {
        throw new Error(
            response.incomplete_details?.reason ?? "OpenAI response incomplete",
        );
    }
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
            result = isProModel(model)
                ? await createNonStreamingResponse(openai, {
                      model,
                      systemPrompt,
                      input,
                      tools: openaiTools,
                      enableThinking: params.enableThinking,
                      reasoningEffort: params.reasoningEffort,
                      textVerbosity: params.textVerbosity,
                      textFormat: params.textFormat,
                      abortSignal: params.abortSignal,
                  })
                : await createStreamingResponse(openai, {
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
                  });
        } catch (error) {
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
                model,
                provider: "openai",
                stream: !isProModel(model),
                latencySeconds: elapsedSeconds(requestStartedAt),
                input: aiInputMessages(systemPrompt, params.messages),
                output: "",
                error: safeErrorMessage(error),
                metadata: {
                    iteration: iter + 1,
                    tool_count: openaiTools.length,
                    ...params.aiObservability?.metadata,
                },
            });
            throw error;
        }

        const { response } = result;
        throwIfAborted(params.abortSignal);

        if (isProModel(model)) {
            const text = outputText(response);
            iterationText += text;
            fullText += text;
            callbacks.onContentDelta?.(text);
        } else if (fullText.length === beforeLength) {
            const text = outputText(response);
            if (text) {
                iterationText += text;
                fullText += text;
                callbacks.onContentDelta?.(text);
            }
        }

        const usage = await recordOpenAIUsage({
            model,
            response,
            params,
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
            model,
            provider: "openai",
            stream: !isProModel(model),
            latencySeconds: result.latencySeconds,
            timeToFirstTokenSeconds: result.timeToFirstTokenSeconds,
            input: aiInputMessages(systemPrompt, params.messages),
            output: iterationText || outputText(response),
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
                ...params.aiObservability?.metadata,
            },
        });

        const calls = extractFunctionCalls(response);
        if (!calls.length || !runTools) break;

        const normalizedCalls: NormalizedToolCall[] = calls.map((call) => ({
            id: call.call_id,
            name: call.name,
            input: parseToolArguments(call.arguments),
        }));
        for (const call of normalizedCalls) callbacks.onToolCallStart?.(call);

        throwIfAborted(params.abortSignal);
        const results = await runTools(normalizedCalls);
        throwIfAborted(params.abortSignal);
        input = [
            ...input,
            ...(response.output as ResponseInputItem[]),
            ...results.map((result): ResponseInputItem => ({
                type: "function_call_output",
                call_id: result.tool_use_id,
                output: result.content,
            })),
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
        const text = outputText(result.response);
        const usage = await recordOpenAIUsage({
            model: params.model,
            response: result.response,
            params,
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
            model: params.model,
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
            metadata: params.aiObservability?.metadata,
        });
        return text;
    } catch (error) {
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
            model: params.model,
            provider: "openai",
            stream: false,
            latencySeconds: elapsedSeconds(requestStartedAt),
            input: aiInputMessages(params.systemPrompt, params.user),
            output: "",
            error: safeErrorMessage(error),
            metadata: params.aiObservability?.metadata,
        });
        throw error;
    }
}
