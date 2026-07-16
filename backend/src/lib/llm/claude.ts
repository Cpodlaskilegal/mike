import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";
import { throwIfAborted } from "./types";
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

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [key: string]: unknown };

type NativeMessage = {
    role: "user" | "assistant";
    content: string | ContentBlock[];
};

const MAX_TOKENS = 16384;

function client(override?: string | null): Anthropic {
    const apiKey = override?.trim() || process.env.ANTHROPIC_API_KEY || "";
    return new Anthropic({ apiKey });
}

function thinkingOptions(
    model: string,
    enableThinking: boolean | undefined,
): Record<string, unknown> {
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

function toNativeMessages(
    messages: StreamChatParams["messages"],
): NativeMessage[] {
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

    const messages: NativeMessage[] = toNativeMessages(params.messages);
    let fullText = "";
    const traceId = params.aiObservability?.traceId || randomUUID();
    const parentId = traceId;

    for (let iter = 0; iter < maxIter; iter++) {
        throwIfAborted(params.abortSignal);
        const generationId = randomUUID();
        const requestStartedAt = Date.now();
        let iterationText = "";
        const stream = anthropic.messages.stream({
            model,
            system: systemPrompt,
            messages: messages as Anthropic.MessageParam[],
            tools: claudeTools.length
                ? (claudeTools as unknown as Tool[])
                : undefined,
            max_tokens: MAX_TOKENS,
            ...thinkingOptions(model, enableThinking),
            // Extended thinking requires temperature to be default (omitted).
        }, { signal: params.abortSignal });

        const abortStream = () => stream.abort();
        params.abortSignal?.addEventListener("abort", abortStream, {
            once: true,
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

        let final: Awaited<ReturnType<typeof stream.finalMessage>>;
        try {
            final = await stream.finalMessage();
        } catch (error) {
            if (params.abortSignal?.aborted) {
                throwIfAborted(params.abortSignal);
            }
            throw error;
        } finally {
            params.abortSignal?.removeEventListener("abort", abortStream);
        }
        if (sawThinking) callbacks.onReasoningBlockEnd?.();
        throwIfAborted(params.abortSignal);
        const stopReason = final.stop_reason;
        const assistantBlocks = final.content as ContentBlock[];

        // Extract text content and tool_use calls from the final assistant
        // message so we can accumulate text and drive the tool-call loop.
        const toolCalls: NormalizedToolCall[] = [];
        for (const block of assistantBlocks) {
            if (block.type === "text") {
                const txt = (block as { text: string }).text;
                if (typeof txt === "string") {
                    iterationText += txt;
                    fullText += txt;
                }
            } else if (block.type === "tool_use") {
                const tu = block as {
                    id: string;
                    name: string;
                    input: unknown;
                };
                const call: NormalizedToolCall = {
                    id: tu.id,
                    name: tu.name,
                    input: (tu.input as Record<string, unknown>) ?? {},
                };
                callbacks.onToolCallStart?.(call);
                toolCalls.push(call);
            }
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
                function_call_count: toolCalls.length,
                ...params.aiObservability?.metadata,
            },
        });

        if (stopReason !== "tool_use" || !toolCalls.length || !runTools) {
            break;
        }

        throwIfAborted(params.abortSignal);
        const results = await runTools(toolCalls);
        throwIfAborted(params.abortSignal);

        // Record the assistant turn (preserving the original content blocks,
        // which Claude requires on the follow-up) and the user turn that
        // carries the tool_result blocks.
        messages.push({ role: "assistant", content: assistantBlocks });
        messages.push({
            role: "user",
            content: results.map((r) => ({
                type: "tool_result",
                tool_use_id: r.tool_use_id,
                content: r.content,
            })),
        });
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
