function parseDetail(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const httpMatch = trimmed.match(/^HTTP\s+\d+:\s*([\s\S]*)$/i);
  const candidate = httpMatch?.[1]?.trim() || trimmed;

  try {
    const parsed = JSON.parse(candidate) as {
      detail?: unknown;
      message?: unknown;
    };
    if (typeof parsed.detail === "string") return parsed.detail;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // keep the original text
  }

  return candidate.replace(/^Error:\s*/i, "").trim();
}

export function describeChatError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const detail = parseDetail(raw);
  const lower = detail.toLowerCase();

  if (!detail || lower === "stream error" || lower === "something went wrong") {
    return "The assistant failed before it could finish. Retry, or check the selected model, attached documents, and model API keys if it happens again.";
  }

  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return "The browser could not reach the backend. Check the API server connection, then try again.";
  }

  if (lower.includes("api key") || lower.includes("invalid_api_key")) {
    return "The selected model provider is missing or rejecting its API key. Check Account > Models or the server environment variables, then try again.";
  }

  if (
    lower.includes("does not have access") ||
    lower.includes("model_not_found") ||
    lower.includes("unsupported model")
  ) {
    return "The selected model is not available for this account. Choose another model or update the provider credentials.";
  }

  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("quota") ||
    lower.includes("too many requests")
  ) {
    return "The model provider is rate limiting this request or the quota is exhausted. Wait a moment, then retry or switch models.";
  }

  if (
    lower.includes("context length") ||
    lower.includes("maximum context") ||
    lower.includes("token limit") ||
    lower.includes("too many tokens") ||
    lower.includes("request too large")
  ) {
    return "The request is too large for the selected model. Remove some documents, narrow the prompt, or start a smaller chat.";
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "The assistant request timed out. Retry with fewer documents or a shorter prompt.";
  }

  if (
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("overloaded")
  ) {
    return "The model provider is temporarily unavailable. Retry in a moment or switch models.";
  }

  return detail;
}
