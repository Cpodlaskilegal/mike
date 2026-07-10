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
    | "xhigh";

export type TextVerbosity = "low" | "medium" | "high";

export type AiObservabilityContext = {
    distinctId?: string;
    traceId?: string;
    sessionId?: string | null;
    spanName?: string;
    route?: string;
    chatId?: string | null;
    projectId?: string | null;
    metadata?: Record<string, string | number | boolean | null | undefined>;
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
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKeys?: UserApiKeys;
    /**
     * Enable provider-side reasoning/thinking. Off by default — should only
     * be turned on for interactive chat surfaces where the user actually
     * benefits from seeing the thought stream. Bulk extraction jobs and
     * one-shot completions should leave this off to save tokens and latency.
     */
    enableThinking?: boolean;
    /**
     * Provider-specific generation tuning. OpenAI uses these directly through
     * the Responses API; Claude/Gemini ignore them unless their adapters add
     * equivalent knobs later.
     */
    reasoningEffort?: ReasoningEffort;
    textVerbosity?: TextVerbosity;
    textFormat?: JsonSchemaTextFormat;
    aiObservability?: AiObservabilityContext;
    /** Abort an in-flight provider request when the streaming client disconnects. */
    abortSignal?: AbortSignal;
};

export type StreamChatResult = {
    fullText: string;
};
