const SECRET_CONTEXT_PATTERNS = [
  /(Incorrect API key provided:\s*)([^.\s]+)(\.?)/gi,
  /\b((?:api[_ -]?key|x-api-key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret|secret|authorization|bearer|password|cookie|set-cookie|database[_ -]?url|connection[_ -]?string|azure[_ -]?storage[_ -]?(?:key|connection[_ -]?string)|azure[_ -]?client[_ -]?secret|account[_ -]?key|sas[_ -]?token|signature|sig)\s*(?:provided\s*)?(?:is|:|=)\s*(?:bearer\s+)?)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:)([^@\s/]+)(@)/gi,
];

const PROVIDER_KEY_PATTERNS = [
  /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{12,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export function redactSensitiveText(value: string): string {
  let redacted = value;

  redacted = redacted.replace(
    SECRET_CONTEXT_PATTERNS[0],
    "$1[redacted]$3",
  );
  redacted = redacted.replace(SECRET_CONTEXT_PATTERNS[1], "$1[redacted]");
  redacted = redacted.replace(SECRET_CONTEXT_PATTERNS[2], "$1[redacted]$3");

  for (const pattern of PROVIDER_KEY_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }

  return redacted;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

export function safeErrorMessage(
  error: unknown,
  fallback = "Unexpected error",
): string {
  return redactSensitiveText(messageFromError(error, fallback));
}

export function safeErrorLog(error: unknown): {
  name: string | null;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name ? redactSensitiveText(error.name) : null,
      message: safeErrorMessage(error),
      stack: error.stack ? redactSensitiveText(error.stack) : undefined,
    };
  }

  return {
    name: null,
    message: safeErrorMessage(error),
  };
}
