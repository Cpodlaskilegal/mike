// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

export type Provider = "claude" | "gemini" | "openai";

export type OpenAIToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type LlmMessage = {
    role: "user" | "assistant";
    content: string;
};

export type NormalizedToolCall = {
    id: string;
    name: string;
    input: Record<string, unknown>;
};

export type NormalizedToolResult = {
    tool_use_id: string;
    content: string;
};

export type StreamCallbacks = {
    onReasoningDelta?: (text: string) => void;
    onReasoningBlockEnd?: () => void;
    onContentDelta?: (text: string) => void;
    onToolCallStart?: (call: NormalizedToolCall) => void;
};

/**
 * Durable provider identifiers and state for a long-running assistant turn.
 * OpenAI emits these updates as soon as the Responses API assigns an ID so
 * the route can persist it before the browser transport is detached.
 */
export type ProviderRunProgress = {
    provider: "openai";
    iteration: number;
    phase: "started" | "polling" | "resuming" | "completed" | "failed";
    background: boolean;
    providerResponseId?: string | null;
    providerRequestId?: string | null;
    providerStatus?: string | null;
    lastSequenceNumber?: number | null;
    recoveryAttempted?: boolean;
};

/**
 * Normalizes the cancellation errors surfaced by provider SDKs and Node's
 * fetch implementation. Routes use this to distinguish a disconnected client
 * from a provider failure that should be shown as an error.
 */
export function isAbortError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { name?: unknown; message?: unknown };
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const message =
        typeof candidate.message === "string" ? candidate.message : "";
    return (
        name === "AbortError" ||
        name === "APIUserAbortError" ||
        name.toLowerCase().includes("abort") ||
        message === "Stream aborted."
    );
}

/** Throw a normalized error when a caller-owned assistant stream is cancelled. */
export function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error("Stream aborted.");
    error.name = "AbortError";
    throw error;
}

/**
 * Preserve already-streamed assistant events while making an interrupted turn
 * unambiguous when it is reloaded from chat history.
 */
export function appendCancellationMarker<T extends { type: string }>(
    events: T[],
): (T | { type: "content"; text: string })[] {
    const hasCancellationMarker = events.some((event) => {
        const candidate = event as { type: string; text?: unknown };
        return (
            candidate.type === "content" &&
            candidate.text === "Cancelled by user."
        );
    });
    if (hasCancellationMarker) return [...events];
    return [...events, { type: "content", text: "Cancelled by user." }];
}

/** Keep a transport failure distinct from an explicit user cancellation. */
export function appendConnectionInterruptionMarker<T extends { type: string }>(
    events: T[],
): (T | { type: "content"; text: string })[] {
    const text =
        "Response interrupted by a browser connection or infrastructure timeout.";
    const hasMarker = events.some((event) => {
        const candidate = event as { type: string; text?: unknown };
        return candidate.type === "content" && candidate.text === text;
    });
    if (hasMarker) return [...events];
    return [...events, { type: "content", text }];
}

/**
 * Carries the safe-to-persist portion of a streamed turn back to the route
 * after the client has cancelled the provider request.
 */
export class AssistantStreamAbortError<TEvent = unknown> extends Error {
    readonly fullText: string;
    readonly events: TEvent[];

    constructor(fullText: string, events: TEvent[]) {
        super("Stream aborted.");
        this.name = "AbortError";
        this.fullText = fullText;
        this.events = events;
    }
}

export type UserApiKeys = {
    claude?: string | null;
    courtlistener?: string | null;
    gemini?: string | null;
    openai?: string | null;
    /** Server-only attribution metadata; never sent to a provider. */
    ownerUserId?: string;
    sources?: Partial<
        Record<
            "claude" | "gemini" | "openai",
            "account" | "user_api_key"
        >
    >;
};

export type ReasoningEffort =
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";

export type ReasoningMode = "standard" | "pro";

export type TextVerbosity = "low" | "medium" | "high";

export type AiObservabilityMetadata = Record<
    string,
    string | number | boolean | null | undefined
> & {
    requested_model?: string | null;
    resolved_model?: string | null;
    model_resolution_status?:
        | "direct"
        | "defaulted"
        | "legacy_mapped"
        | "unknown_fallback";
    reasoning_effort?: ReasoningEffort | null;
    reasoning_mode?: ReasoningMode | null;
    streaming?: boolean | null;
};

export type AiObservabilityContext = {
    distinctId?: string;
    traceId?: string;
    sessionId?: string | null;
    spanName?: string;
    route?: string;
    chatId?: string | null;
    projectId?: string | null;
    metadata?: AiObservabilityMetadata;
};

export type JsonSchemaTextFormat = {
    type: "json_schema";
    name: string;
    description?: string;
    schema: Record<string, unknown>;
    strict?: boolean;
};

export type StreamChatParams = {
    model: string;
    systemPrompt: string;
    messages: LlmMessage[];
    tools?: OpenAIToolSchema[];
    maxIterations?: number;
    callbacks?: StreamCallbacks;
    onProviderRunProgress?: (
        progress: ProviderRunProgress,
    ) => void | Promise<void>;
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKeys?: UserApiKeys;
    /**
     * Enable reasoning display for interactive chat. Older models also use
     * this flag to opt into thinking; current Claude models use adaptive
     * thinking regardless and expose their summaries only when requested.
     */
    enableThinking?: boolean;
    /**
     * Provider-specific generation tuning. OpenAI uses these directly through
     * the Responses API; current Claude models accept reasoningEffort while
     * reasoningMode remains OpenAI-only. Gemini ignores these options.
     */
    reasoningEffort?: ReasoningEffort;
    reasoningMode?: ReasoningMode;
    textVerbosity?: TextVerbosity;
    textFormat?: JsonSchemaTextFormat;
    aiObservability?: AiObservabilityContext;
    /** Abort an in-flight provider request when the streaming client disconnects. */
    abortSignal?: AbortSignal;
};

export type StreamChatResult = {
    fullText: string;
};

export const DEFAULT_MAX_TOOL_ITERATIONS = 10;

export const FINAL_SYNTHESIS_INSTRUCTION = `Tool use is no longer available for this response. Using only the information already gathered, provide the complete final answer now. Follow every original citation and output-format requirement. Do not request or claim to run another tool. If the available evidence is insufficient, state that limitation plainly instead of omitting the answer.`;

export function normalizeMaxToolIterations(
    value: number | undefined,
): number {
    if (value === undefined) return DEFAULT_MAX_TOOL_ITERATIONS;
    if (!Number.isFinite(value)) return DEFAULT_MAX_TOOL_ITERATIONS;
    return Math.max(0, Math.floor(value));
}

export function finalSynthesisSystemPrompt(systemPrompt: string): string {
    return `${systemPrompt}\n\nFINAL RESPONSE REQUIRED:\n${FINAL_SYNTHESIS_INSTRUCTION}`;
}

export function buildToolLoopIteration<T>(
    iteration: number,
    maxToolIterations: number,
    tools: T[],
    systemPrompt: string,
): {
    finalSynthesis: boolean;
    tools: T[];
    systemPrompt: string;
} {
    const finalSynthesis = iteration === maxToolIterations;
    return {
        finalSynthesis,
        tools: finalSynthesis ? [] : tools,
        systemPrompt: finalSynthesis
            ? finalSynthesisSystemPrompt(systemPrompt)
            : systemPrompt,
    };
}

export class ToolIterationLimitError extends Error {
    readonly provider: Provider;
    readonly providerResponseId: string | null;
    readonly providerRequestId: string | null;
    readonly retryable = true;

    constructor(
        provider: Provider,
        identifiers: {
            providerResponseId?: string | null;
            providerRequestId?: string | null;
        } = {},
    ) {
        super(
            "The assistant reached its tool iteration limit without producing a final answer.",
        );
        this.name = "TOOL_ITERATION_LIMIT";
        this.provider = provider;
        this.providerResponseId = identifiers.providerResponseId ?? null;
        this.providerRequestId = identifiers.providerRequestId ?? null;
    }
}

export function assertFinalSynthesisResult(
    provider: Provider,
    result: {
        text: string;
        toolCallCount: number;
        providerResponseId?: string | null;
        providerRequestId?: string | null;
    },
): void {
    if (result.toolCallCount > 0 || !result.text.trim()) {
        throw new ToolIterationLimitError(provider, {
            providerResponseId: result.providerResponseId,
            providerRequestId: result.providerRequestId,
        });
    }
}
