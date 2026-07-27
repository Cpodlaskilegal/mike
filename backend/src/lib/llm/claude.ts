import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type {
    ContentBlock,
    ContentBlockParam,
    MessageParam,
    MessageStreamParams,
    StopReason,
    Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";
import { throwIfAborted } from "./types";
import {
    CLAUDE_OPUS_5_REASONING_EFFORTS,
    type ClaudeOpus5ReasoningEffort,
} from "./models";
import { toClaudeTools } from "./tools";
import { captureAiGeneration } from "../posthog";
import {
    calculateLlmCostNanos,
    deliverSpendReport,
    recordLlmUsage,
    spendUsd,
    type LlmCost,
} from "../llmSpend";
import { safeErrorMessage } from "../safeError";

const MAX_TOKENS = 16384;

function client(override?: string | null): Anthropic {
    const apiKey = override?.trim() || process.env.ANTHROPIC_API_KEY || "";
    return new Anthropic({ apiKey });
}

function resolveClaudeOpus5Effort(
    reasoningEffort: StreamChatParams["reasoningEffort"],
): ClaudeOpus5ReasoningEffort {
    if (reasoningEffort === undefined) return "high";
    if (
        (CLAUDE_OPUS_5_REASONING_EFFORTS as readonly string[]).includes(
            reasoningEffort,
        )
    ) {
        return reasoningEffort as ClaudeOpus5ReasoningEffort;
    }
    throw new Error(
        `Claude Opus 5 reasoning effort must be one of: ${CLAUDE_OPUS_5_REASONING_EFFORTS.join(", ")}`,
    );
}

function thinkingOptions(
    model: string,
    enableThinking: boolean | undefined,
    reasoningEffort: StreamChatParams["reasoningEffort"],
): Pick<MessageStreamParams, "thinking" | "output_config"> {
    if (model === "claude-opus-5") {
        return {
            thinking: { type: "adaptive", display: "summarized" },
            output_config: {
                effort: resolveClaudeOpus5Effort(reasoningEffort),
            },
        };
    }

    if (!enableThinking) return {};

    if (model === "claude-sonnet-5" || model === "claude-fable-5") {
        return { output_config: { effort: "high" } };
    }

    if (
        model === "claude-opus-4-8" ||
        model === "claude-opus-4-7" ||
        model === "claude-opus-4-6" ||
        model === "claude-sonnet-4-6"
    ) {
        return {
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
        };
    }

    return {};
}

export type ClaudeStreamingRequestInput = {
    model: string;
    systemPrompt?: string;
    messages: MessageParam[];
    tools?: Tool[];
    enableThinking?: boolean;
    reasoningEffort?: StreamChatParams["reasoningEffort"];
};

/**
 * Build the stable Messages API payload separately from I/O so model-specific
 * tuning can be contract-tested without calling Anthropic.
 */
export function buildClaudeStreamingRequest(
    input: ClaudeStreamingRequestInput,
): MessageStreamParams {
    return {
        model: input.model,
        system: input.systemPrompt,
        messages: input.messages,
        ...(input.tools?.length ? { tools: input.tools } : {}),
        max_tokens: MAX_TOKENS,
        ...thinkingOptions(
            input.model,
            input.enableThinking,
            input.reasoningEffort,
        ),
    };
}

function toNativeMessages(
    messages: StreamChatParams["messages"],
): MessageParam[] {
    return messages.map((m) => ({ role: m.role, content: m.content }));
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

type RecordedClaudeUsage = {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: LlmCost;
};

export type ClaudeIterationContent = {
    text: string;
    toolCalls: NormalizedToolCall[];
    assistantBlocks: ContentBlock[];
};

/**
 * Keep response blocks untouched so adaptive-thinking signatures remain valid
 * when the assistant turn is replayed alongside tool results.
 */
export function extractClaudeIterationContent(
    response: Anthropic.Message,
): ClaudeIterationContent {
    let text = "";
    const toolCalls: NormalizedToolCall[] = [];

    for (const block of response.content) {
        if (block.type === "text") {
            text += block.text;
        } else if (block.type === "tool_use") {
            toolCalls.push({
                id: block.id,
                name: block.name,
                input: (block.input as Record<string, unknown>) ?? {},
            });
        }
    }

    return {
        text,
        toolCalls,
        assistantBlocks: response.content,
    };
}

export function buildClaudeToolContinuation(
    assistantBlocks: ContentBlock[],
    results: NormalizedToolResult[],
): MessageParam[] {
    return [
        {
            role: "assistant",
            // Response blocks are the exact continuation payload Anthropic
            // expects, including thinking text, redactions, and signatures.
            content: assistantBlocks as unknown as ContentBlockParam[],
        },
        {
            role: "user",
            content: results.map((result) => ({
                type: "tool_result",
                tool_use_id: result.tool_use_id,
                content: result.content,
            })),
        },
    ];
}

export class ClaudeStopReasonError extends Error {
    readonly code: "model_context_window_exceeded" | "pause_turn";
    readonly provider = "anthropic";
    readonly retryable: boolean;

    constructor(
        code: "model_context_window_exceeded" | "pause_turn",
        message: string,
        retryable: boolean,
    ) {
        super(message);
        this.name = "ClaudeStopReasonError";
        this.code = code;
        this.retryable = retryable;
    }
}

/**
 * Max-token and refusal responses may contain useful text and are therefore
 * terminal successes. Context exhaustion and an unhandled paused turn are
 * surfaced as explicit, classifiable failures.
 */
export function assertUsableClaudeStopReason(
    stopReason: StopReason | null,
): void {
    if (stopReason === "model_context_window_exceeded") {
        throw new ClaudeStopReasonError(
            stopReason,
            "Claude model_context_window_exceeded: request too large for the selected model.",
            false,
        );
    }
    if (stopReason === "pause_turn") {
        throw new ClaudeStopReasonError(
            stopReason,
            "Claude returned pause_turn before completing the response.",
            true,
        );
    }
}

type ClaudeMessageStreamLike = {
    abort(): void;
    finalMessage(): Promise<Anthropic.Message>;
};

export async function waitForClaudeFinalMessage(
    stream: ClaudeMessageStreamLike,
    abortSignal?: AbortSignal,
): Promise<Anthropic.Message> {
    const abortStream = () => stream.abort();
    if (abortSignal?.aborted) {
        abortStream();
        throwIfAborted(abortSignal);
    }
    abortSignal?.addEventListener("abort", abortStream, { once: true });

    try {
        return await stream.finalMessage();
    } catch (error) {
        if (abortSignal?.aborted) {
            throwIfAborted(abortSignal);
        }
        throw error;
    } finally {
        abortSignal?.removeEventListener("abort", abortStream);
    }
}

async function recordClaudeUsage(input: {
    model: string;
    response: Anthropic.Message;
    params: Pick<StreamChatParams, "apiKeys" | "aiObservability">;
}): Promise<RecordedClaudeUsage> {
    const usage = input.response.usage;
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheCreation5mTokens = usage.cache_creation
        ? usage.cache_creation.ephemeral_5m_input_tokens ?? 0
        : usage.cache_creation_input_tokens ?? 0;
    const cacheCreation1hTokens =
        usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const totalTokens =
        inputTokens +
        outputTokens +
        cacheReadTokens +
        cacheCreation5mTokens +
        cacheCreation1hTokens;
    const costInput = {
        provider: "claude" as const,
        model: input.model,
        inputTokens,
        cacheReadTokens,
        cacheCreation5mTokens,
        cacheCreation1hTokens,
        outputTokens,
    };
    const fallbackCost = calculateLlmCostNanos(costInput);

    try {
        const recorded = await recordLlmUsage({
            ...costInput,
            providerResponseId: input.response.id,
            billingSource: input.params.apiKeys?.sources?.claude ?? "account",
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
            "[llm-spend] failed to record Claude usage",
            safeErrorMessage(error, "LLM usage accounting failed"),
        );
        return { inputTokens, outputTokens, totalTokens, cost: fallbackCost };
    }
}

export async function streamClaude(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        enableThinking,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const anthropic = client(apiKeys?.claude);
    const claudeTools = toClaudeTools(tools);

    const messages = toNativeMessages(params.messages);
    let fullText = "";
    const traceId = params.aiObservability?.traceId || randomUUID();
    const parentId = traceId;

    for (let iter = 0; iter < maxIter; iter++) {
        throwIfAborted(params.abortSignal);
        const generationId = randomUUID();
        const requestStartedAt = Date.now();
        let iterationText = "";
        const request = buildClaudeStreamingRequest({
            model,
            systemPrompt,
            messages,
            tools: claudeTools as unknown as Tool[],
            enableThinking,
            reasoningEffort: params.reasoningEffort,
        });
        const stream = anthropic.messages.stream(request, {
            signal: params.abortSignal,
        });

        let sawThinking = false;

        stream.on("text", (delta) => {
            callbacks.onContentDelta?.(delta);
        });
        if (enableThinking) {
            stream.on("thinking", (delta) => {
                sawThinking = true;
                callbacks.onReasoningDelta?.(delta);
            });
        }

        const final = await waitForClaudeFinalMessage(
            stream,
            params.abortSignal,
        );
        if (sawThinking) callbacks.onReasoningBlockEnd?.();
        throwIfAborted(params.abortSignal);
        const stopReason = final.stop_reason;
        const iteration = extractClaudeIterationContent(final);
        iterationText += iteration.text;
        fullText += iteration.text;
        for (const call of iteration.toolCalls) {
            callbacks.onToolCallStart?.(call);
        }

        const usage = await recordClaudeUsage({
            model,
            response: final,
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
            provider: "anthropic",
            stream: true,
            latencySeconds: elapsedSeconds(requestStartedAt),
            input: aiInputMessages(systemPrompt, params.messages),
            output: iterationText,
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
                tool_count: claudeTools.length,
                function_call_count: iteration.toolCalls.length,
                ...params.aiObservability?.metadata,
            },
        });

        assertUsableClaudeStopReason(stopReason);

        if (
            stopReason !== "tool_use" ||
            !iteration.toolCalls.length ||
            !runTools
        ) {
            break;
        }

        throwIfAborted(params.abortSignal);
        const results = await runTools(iteration.toolCalls);
        throwIfAborted(params.abortSignal);

        messages.push(
            ...buildClaudeToolContinuation(iteration.assistantBlocks, results),
        );
    }

    return { fullText };
}

export async function completeClaudeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: StreamChatParams["apiKeys"];
    aiObservability?: StreamChatParams["aiObservability"];
}): Promise<string> {
    const anthropic = client(params.apiKeys?.claude);
    const traceId = params.aiObservability?.traceId || randomUUID();
    const generationId = randomUUID();
    const requestStartedAt = Date.now();
    try {
        const resp = await anthropic.messages.create({
            model: params.model,
            max_tokens: params.maxTokens ?? 512,
            system: params.systemPrompt,
            messages: [{ role: "user", content: params.user }],
        });
        const text = resp.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
        const usage = await recordClaudeUsage({
            model: params.model,
            response: resp,
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
            provider: "anthropic",
            stream: false,
            latencySeconds: elapsedSeconds(requestStartedAt),
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
            provider: "anthropic",
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

// Helper re-export for callers wanting to hand normalized results back in.
export type { NormalizedToolResult };
