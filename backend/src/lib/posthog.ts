import { PostHog } from "posthog-node";
import { safeErrorMessage } from "./safeError";

type Serializable =
    | string
    | number
    | boolean
    | null
    | Serializable[]
    | { [key: string]: Serializable };

type AiMessage = {
    role: string;
    content: string;
};

type AiGenerationCapture = {
    distinctId?: string;
    traceId: string;
    generationId: string;
    parentId?: string;
    sessionId?: string | null;
    spanName?: string;
    route?: string;
    chatId?: string | null;
    projectId?: string | null;
    model: string;
    provider: string;
    stream: boolean;
    latencySeconds: number;
    timeToFirstTokenSeconds?: number;
    input: AiMessage[] | string;
    output: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    error?: string;
    metadata?: Record<string, string | number | boolean | null | undefined>;
};

let posthogClient: PostHog | null = null;

function posthogKey(): string | null {
    return (
        process.env.POSTHOG_KEY?.trim() ||
        process.env.POSTHOG_API_KEY?.trim() ||
        null
    );
}

export function isPostHogConfigured(): boolean {
    return Boolean(posthogKey());
}

function getPostHog(): PostHog | null {
    const key = posthogKey();
    if (!key) return null;
    if (!posthogClient) {
        posthogClient = new PostHog(key, {
            host: process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
        });
    }
    return posthogClient;
}

function shouldCaptureAiContent(): boolean {
    return process.env.POSTHOG_AI_CAPTURE_CONTENT === "true";
}

function redactInput(input: AiMessage[] | string): Serializable {
    if (shouldCaptureAiContent()) {
        return input as Serializable;
    }

    if (typeof input === "string") {
        return {
            content: "[redacted]",
            content_length: input.length,
        };
    }

    return input.map((message) => ({
        role: message.role,
        content: "[redacted]",
        content_length: message.content.length,
    }));
}

function redactOutput(output: string): Serializable[] {
    if (shouldCaptureAiContent()) {
        return [{ content: output }];
    }

    return [
        {
            content: "[redacted]",
            content_length: output.length,
        },
    ];
}

function compactMetadata(
    metadata?: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> {
    const compacted: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(metadata ?? {})) {
        if (value !== undefined) compacted[key] = value;
    }
    return compacted;
}

export async function captureAiGeneration(
    event: AiGenerationCapture,
): Promise<void> {
    const client = getPostHog();
    if (!client) return;

    try {
        await client.captureImmediate({
            distinctId: event.distinctId || "anonymous",
            event: "$ai_generation",
            properties: {
                $ai_trace_id: event.traceId,
                $ai_generation_id: event.generationId,
                $ai_parent_id: event.parentId || event.traceId,
                $ai_session_id: event.sessionId || undefined,
                $ai_span_name: event.spanName,
                $ai_model: event.model,
                $ai_provider: event.provider,
                $ai_input: redactInput(event.input),
                $ai_output_choices: redactOutput(event.output),
                $ai_input_tokens: event.inputTokens,
                $ai_output_tokens: event.outputTokens,
                $ai_total_tokens: event.totalTokens,
                $ai_latency: event.latencySeconds,
                $ai_stream: event.stream,
                $ai_time_to_first_token: event.timeToFirstTokenSeconds,
                $ai_is_error: Boolean(event.error),
                $ai_error: event.error,
                app_route: event.route,
                chat_id: event.chatId || undefined,
                project_id: event.projectId || undefined,
                capture_content: shouldCaptureAiContent(),
                ...compactMetadata(event.metadata),
            },
        });
    } catch (error) {
        const message = safeErrorMessage(error, "Failed to capture AI generation");
        console.warn(`[posthog] failed to capture AI generation: ${message}`);
    }
}
