export type ChatStreamErrorCode =
    | "cancelled"
    | "missing_api_key"
    | "model_unavailable"
    | "rate_limited"
    | "request_too_large"
    | "provider_unavailable"
    | "network"
    | "timeout"
    | "tool_failed"
    | "unknown";

export type ChatStreamErrorPayload = {
    type: "error";
    message: string;
    code: ChatStreamErrorCode;
    retryable: boolean;
};

function errorStatus(err: unknown): number | null {
    if (!err || typeof err !== "object") return null;
    const candidate = err as {
        status?: unknown;
        statusCode?: unknown;
        code?: unknown;
    };
    if (typeof candidate.status === "number") return candidate.status;
    if (typeof candidate.statusCode === "number") return candidate.statusCode;
    if (typeof candidate.code === "number") return candidate.code;
    return null;
}

function errorText(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
        return JSON.stringify(err);
    } catch {
        return "";
    }
}

export function toChatStreamError(err: unknown): ChatStreamErrorPayload {
    const status = errorStatus(err);
    const text = errorText(err);
    const lower = text.toLowerCase();

    if (lower.includes("abort") || lower.includes("cancel")) {
        return {
            type: "error",
            code: "cancelled",
            retryable: false,
            message: "The assistant request was cancelled before it finished.",
        };
    }

    if (
        lower.includes("api key") ||
        lower.includes("invalid_api_key") ||
        lower.includes("authentication") ||
        status === 401 ||
        status === 403
    ) {
        return {
            type: "error",
            code: "missing_api_key",
            retryable: false,
            message:
                "The selected model provider is missing or rejecting its API key. Check Account > Models or the server environment variables, then try again.",
        };
    }

    if (
        lower.includes("model_not_found") ||
        lower.includes("does not have access") ||
        lower.includes("not have access to this model") ||
        lower.includes("unsupported model") ||
        lower.includes("model is not available")
    ) {
        return {
            type: "error",
            code: "model_unavailable",
            retryable: false,
            message:
                "The selected model is not available for this account. Choose another model or update the provider credentials.",
        };
    }

    if (
        status === 429 ||
        lower.includes("rate limit") ||
        lower.includes("rate_limit") ||
        lower.includes("quota") ||
        lower.includes("too many requests")
    ) {
        return {
            type: "error",
            code: "rate_limited",
            retryable: true,
            message:
                "The model provider is rate limiting this request or the quota is exhausted. Wait a moment, then retry or switch models.",
        };
    }

    if (
        lower.includes("context length") ||
        lower.includes("maximum context") ||
        lower.includes("token limit") ||
        lower.includes("too many tokens") ||
        lower.includes("request too large") ||
        status === 413
    ) {
        return {
            type: "error",
            code: "request_too_large",
            retryable: false,
            message:
                "The request is too large for the selected model. Remove some documents, narrow the prompt, or start a smaller chat.",
        };
    }

    if (
        lower.includes("timeout") ||
        lower.includes("timed out") ||
        lower.includes("etimedout")
    ) {
        return {
            type: "error",
            code: "timeout",
            retryable: true,
            message:
                "The assistant request timed out. Retry with fewer documents or a shorter prompt.",
        };
    }

    if (
        status === 502 ||
        status === 503 ||
        status === 504 ||
        lower.includes("overloaded") ||
        lower.includes("temporarily unavailable") ||
        lower.includes("service unavailable")
    ) {
        return {
            type: "error",
            code: "provider_unavailable",
            retryable: true,
            message:
                "The model provider is temporarily unavailable. Retry in a moment or switch models.",
        };
    }

    if (
        lower.includes("econnreset") ||
        lower.includes("socket hang up") ||
        lower.includes("fetch failed") ||
        lower.includes("network")
    ) {
        return {
            type: "error",
            code: "network",
            retryable: true,
            message:
                "The backend lost its connection to the model provider. Retry; if it repeats, check the provider status or network path.",
        };
    }

    if (
        lower.includes("mcp") ||
        lower.includes("tool") ||
        lower.includes("function call")
    ) {
        return {
            type: "error",
            code: "tool_failed",
            retryable: true,
            message:
                "A connected tool failed while the assistant was working. Retry, or disable the connector/tool and try again.",
        };
    }

    return {
        type: "error",
        code: "unknown",
        retryable: true,
        message:
            "The assistant failed before it could finish. Retry, or check the server logs for the chat stream error if it happens again.",
    };
}

export function chatStreamErrorLine(err: unknown): string {
    return `data: ${JSON.stringify(toChatStreamError(err))}\n\n`;
}
