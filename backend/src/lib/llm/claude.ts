import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type {
    ContentBlock,
    ContentBlockParam,
    MessageCreateParamsBase,
    MessageParam,
    MessageStreamParams,
    StopReason,
    Tool,
    ToolUnion,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";
import {
    assertFinalSynthesisResult,
    buildToolLoopIteration,
    FINAL_SYNTHESIS_INSTRUCTION,
    normalizeMaxToolIterations,
    throwIfAborted,
} from "./types";
import {
    CLAUDE_MAIN_MODELS,
    CLAUDE_REASONING_EFFORTS,
    defaultClaudeReasoningEffort,
    supportsClaudeReasoningEffort,
    type ClaudeReasoningEffort,
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
// Higher effort needs enough room for both reasoning and the user-visible answer.
// https://platform.claude.com/docs/en/build-with-claude/effort
const HIGH_EFFORT_MAX_TOKENS = 64000;
const SIGNED_PREFIX_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5"]);
const MAX_SERVER_TOOL_CONTINUATIONS = 5;
const MAIN_CLAUDE_MODELS = new Set<string>(CLAUDE_MAIN_MODELS);

/**
 * The basic web tool versions work without dynamic filtering on older models.
 * Later fetch versions depend on model-specific code-execution support. Code
 * execution itself runs in Anthropic's sandbox, including its Bash facility;
 * it does not execute commands on Docket's host.
 */
export function claudeHostedTools(model: string): ToolUnion[] {
    if (!MAIN_CLAUDE_MODELS.has(model)) return [];
    return [
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        // Anthropic explicitly excludes web fetch on Opus 5. Keep search and
        // code execution available there instead of making every chat fail 400.
        // https://platform.claude.com/docs/en/models/opus-5/migration-guide
        ...(model === "claude-opus-5"
            ? []
            : [{
                  type: "web_fetch_20250910" as const,
                  name: "web_fetch" as const,
                  max_uses: 5,
                  max_content_tokens: 25_000,
                  citations: { enabled: true },
              }]),
        { type: "code_execution_20260521", name: "code_execution" },
    ];
}

function client(override?: string | null): Anthropic {
    const apiKey = override?.trim() || process.env.ANTHROPIC_API_KEY || "";
    return new Anthropic({ apiKey });
}

function resolveClaudeEffort(
    model: string,
    reasoningEffort: StreamChatParams["reasoningEffort"],
): ClaudeReasoningEffort {
    if (reasoningEffort === undefined) return defaultClaudeReasoningEffort(model);
    if (
        (CLAUDE_REASONING_EFFORTS as readonly string[]).includes(
            reasoningEffort,
        )
    ) {
        return reasoningEffort as ClaudeReasoningEffort;
    }
    throw new Error(
        `Claude reasoning effort must be one of: ${CLAUDE_REASONING_EFFORTS.join(", ")}`,
    );
}

function thinkingOptions(
    model: string,
    enableThinking: boolean | undefined,
    reasoningEffort: StreamChatParams["reasoningEffort"],
): Pick<MessageCreateParamsBase, "thinking" | "output_config"> {
    if (supportsClaudeReasoningEffort(model)) {
        return {
            thinking: { type: "adaptive", display: "summarized" },
            output_config: {
                effort: resolveClaudeEffort(model, reasoningEffort),
            },
        };
    }

    if (!enableThinking) return {};

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
    tools?: ToolUnion[];
    toolChoice?: MessageStreamParams["tool_choice"];
    containerId?: string;
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
    if (
        input.model === "claude-opus-5-5" &&
        (input.toolChoice?.type === "any" || input.toolChoice?.type === "tool")
    ) {
        throw new Error("Claude Opus 5.5 does not support forced tool choice");
    }
    return {
        model: input.model,
        system: input.systemPrompt,
        messages: input.messages,
        ...(input.tools?.length ? { tools: input.tools } : {}),
        ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
        ...(input.containerId ? { container: input.containerId } : {}),
        max_tokens:
            supportsClaudeReasoningEffort(input.model) &&
            (input.reasoningEffort === "xhigh" ||
                input.reasoningEffort === "max")
                ? HIGH_EFFORT_MAX_TOKENS
                : MAX_TOKENS,
        ...thinkingOptions(
            input.model,
            input.enableThinking,
            input.reasoningEffort,
        ),
    };
}

/** Build one tool-loop request without rewriting signed thinking prefixes. */
export function buildClaudeToolLoopRequest(
    input: ClaudeStreamingRequestInput & {
        systemPrompt: string;
        iteration: number;
        maxToolIterations: number;
    },
): { finalSynthesis: boolean; request: MessageStreamParams } {
    const plan = buildToolLoopIteration(
        input.iteration,
        input.maxToolIterations,
        input.tools ?? [],
        input.systemPrompt,
    );
    if (plan.finalSynthesis && hasPendingClaudeServerTool(input.messages)) {
        // A server tool called alongside a Docket tool is still pending until
        // the next request. Anthropic requires the same tool definitions and a
        // user message containing only client tool_result blocks; an extra
        // final-response user message would make the continuation invalid.
        return {
            finalSynthesis: true,
            request: buildClaudeStreamingRequest({
                ...input,
                toolChoice: { type: "none" },
            }),
        };
    }
    if (plan.finalSynthesis && SIGNED_PREFIX_MODELS.has(input.model)) {
        // These models validate every earlier token before a preserved thinking
        // block, including system and tool definitions. Disable execution via
        // tool_choice and append the instruction after the completed results.
        // https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5
        return {
            finalSynthesis: true,
            request: buildClaudeStreamingRequest({
                ...input,
                messages: [
                    ...input.messages,
                    {
                        role: "user",
                        content: `FINAL RESPONSE REQUIRED:\n${FINAL_SYNTHESIS_INSTRUCTION}`,
                    },
                ],
                toolChoice: input.tools?.length ? { type: "none" } : undefined,
            }),
        };
    }
    return {
        finalSynthesis: plan.finalSynthesis,
        request: buildClaudeStreamingRequest({
            ...input,
            systemPrompt: plan.systemPrompt,
            tools: plan.tools,
        }),
    };
}

function hasPendingClaudeServerTool(messages: MessageParam[]): boolean {
    const pending = new Set<string>();
    for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) {
            continue;
        }
        for (const block of message.content) {
            if (block.type === "server_tool_use") {
                pending.add(block.id);
            } else if ("tool_use_id" in block) {
                pending.delete(String(block.tool_use_id));
            }
        }
    }
    return pending.size > 0;
}

export function toNativeMessages(
    messages: StreamChatParams["messages"],
): MessageParam[] {
    return messages.map((m) => {
        if (!m.media?.length) return { role: m.role, content: m.content };
        if (m.role !== "user") {
            throw new Error("Claude media can only be attached to user messages.");
        }
        const content: ContentBlockParam[] = [{ type: "text", text: m.content }];
        for (const media of m.media) {
            const mime = media.mimeType.toLowerCase();
            if (
                mime === "image/jpeg" ||
                mime === "image/png" ||
                mime === "image/gif" ||
                mime === "image/webp"
            ) {
                content.push({ type: "text", text: `Image: ${media.filename}` });
                content.push({
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: mime,
                        data: media.base64Data,
                    },
                });
            } else if (mime === "application/pdf") {
                content.push({
                    type: "document",
                    source: {
                        type: "base64",
                        media_type: "application/pdf",
                        data: media.base64Data,
                    },
                    title: media.filename,
                    citations: { enabled: true },
                });
            } else {
                throw new Error(
                    `Claude cannot understand ${mime || "unknown media"} natively in this Assistant.`,
                );
            }
        }
        return { role: m.role, content };
    });
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

/** Preserve a human-readable link for each verified web source in the turn. */
export function claudeWebSources(blocks: ContentBlock[]): string[] {
    const sources: string[] = [];
    const seen = new Set<string>();
    const add = (raw: string) => {
        try {
            const url = new URL(raw);
            if (url.protocol !== "http:" && url.protocol !== "https:") return;
            const value = url.toString();
            if (seen.has(value)) return;
            seen.add(value);
            sources.push(value);
        } catch {
            // Malformed provider metadata is not a user-facing source.
        }
    };
    for (const block of blocks) {
        if (block.type === "text") {
            for (const citation of block.citations ?? []) {
                if (citation.type === "web_search_result_location") {
                    add(citation.url);
                }
            }
        } else if (
            block.type === "web_fetch_tool_result" &&
            block.content.type === "web_fetch_result"
        ) {
            add(block.content.url);
        }
    }
    return sources;
}

function formatClaudeWebSources(sources: string[]): string {
    if (!sources.length) return "";
    return `\n\nSources: ${sources
        .map((url, index) => `[${index + 1}](${url.replaceAll("(", "%28").replaceAll(")", "%29")})`)
        .join(", ")}`;
}

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

/** Server tools have no client result; replay the paused assistant blocks. */
export function buildClaudePausedContinuation(
    assistantBlocks: ContentBlock[],
): MessageParam {
    return {
        role: "assistant",
        content: assistantBlocks as unknown as ContentBlockParam[],
    };
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
    const maxToolIterations = normalizeMaxToolIterations(params.maxIterations);
    const anthropic = client(apiKeys?.claude);
    const claudeTools: ToolUnion[] = [
        ...(toClaudeTools(tools) as unknown as Tool[]),
        ...claudeHostedTools(model),
    ];

    const messages = toNativeMessages(params.messages);
    let fullText = "";
    let containerId: string | undefined;
    let serverToolContinuations = 0;
    const webSources = new Set<string>();
    const traceId = params.aiObservability?.traceId || randomUUID();
    const parentId = traceId;

    for (let iter = 0; iter <= maxToolIterations; iter++) {
        throwIfAborted(params.abortSignal);
        let iterationText = "";
        const { finalSynthesis, request } = buildClaudeToolLoopRequest({
            model,
            systemPrompt,
            messages,
            tools: claudeTools,
            containerId,
            iteration: iter,
            maxToolIterations,
            enableThinking,
            reasoningEffort: params.reasoningEffort,
        });
        let requestForAttempt = request;
        let final: Anthropic.Message;
        let iteration: ClaudeIterationContent;

        // Anthropic executes hosted tools internally. A long server-side run
        // can return pause_turn, which must be replayed verbatim with the same
        // tool definitions before Docket handles another client tool round.
        while (true) {
            throwIfAborted(params.abortSignal);
            const generationId = randomUUID();
            const requestStartedAt = Date.now();
            const stream = anthropic.messages.stream(requestForAttempt, {
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

            final = await waitForClaudeFinalMessage(
                stream,
                params.abortSignal,
            );
            if (sawThinking) callbacks.onReasoningBlockEnd?.();
            throwIfAborted(params.abortSignal);
            containerId = final.container?.id ?? containerId;
            iteration = extractClaudeIterationContent(final);
            iterationText += iteration.text;
            fullText += iteration.text;
            for (const source of claudeWebSources(iteration.assistantBlocks)) {
                webSources.add(source);
            }
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
                input: aiInputMessages(
                    typeof requestForAttempt.system === "string"
                        ? requestForAttempt.system
                        : systemPrompt,
                    params.messages,
                ),
                output: iteration.text,
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
                    server_tool_continuations: serverToolContinuations,
                    web_search_requests:
                        final.usage.server_tool_use?.web_search_requests ?? 0,
                    web_fetch_requests:
                        final.usage.server_tool_use?.web_fetch_requests ?? 0,
                    tool_count: finalSynthesis ? 0 : claudeTools.length,
                    function_call_count: iteration.toolCalls.length,
                    final_synthesis: finalSynthesis,
                    ...params.aiObservability?.metadata,
                },
            });

            if (final.stop_reason !== "pause_turn") break;
            serverToolContinuations += 1;
            if (serverToolContinuations > MAX_SERVER_TOOL_CONTINUATIONS) {
                throw new ClaudeStopReasonError(
                    "pause_turn",
                    "Claude server tools paused too many times before completing the response.",
                    true,
                );
            }
            const paused = buildClaudePausedContinuation(
                iteration.assistantBlocks,
            );
            requestForAttempt = {
                ...requestForAttempt,
                messages: [...requestForAttempt.messages, paused],
                ...(containerId ? { container: containerId } : {}),
            };
            if (!finalSynthesis) messages.push(paused);
        }

        assertUsableClaudeStopReason(final.stop_reason);

        if (finalSynthesis) {
            assertFinalSynthesisResult("claude", {
                text: iterationText,
                toolCallCount: iteration.toolCalls.length,
                providerResponseId: final.id,
            });
            break;
        }
        if (final.stop_reason !== "tool_use") break;
        if (!iteration.toolCalls.length) {
            throw new Error("Claude returned tool_use without a client tool call.");
        }
        if (!runTools) {
            throw new Error(
                "Claude requested a tool, but no tool executor is available.",
            );
        }

        throwIfAborted(params.abortSignal);
        const results = await runTools(iteration.toolCalls);
        throwIfAborted(params.abortSignal);

        messages.push(
            ...buildClaudeToolContinuation(iteration.assistantBlocks, results),
        );
    }

    const sourceFooter = formatClaudeWebSources([...webSources]);
    if (sourceFooter) {
        fullText += sourceFooter;
        if (callbacks.onSources) callbacks.onSources(sourceFooter);
        else callbacks.onContentDelta?.(sourceFooter);
    }
    return { fullText };
}

export async function completeClaudeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    reasoningEffort?: StreamChatParams["reasoningEffort"];
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
            ...thinkingOptions(params.model, false, params.reasoningEffort),
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
