export class AssistantStreamPrematureEofError extends Error {
  readonly retryable = true;

  constructor() {
    super(
      "The assistant connection ended before Docket received its completion marker. Retry if the response does not appear in this chat.",
    );
    this.name = "AssistantStreamPrematureEofError";
  }
}

export function requireAssistantStreamDone(input: {
  sawDone: boolean;
  sawTerminalEvent: boolean;
}): void {
  if (!input.sawDone || !input.sawTerminalEvent) {
    throw new AssistantStreamPrematureEofError();
  }
}

export function createAssistantStreamRequestId(): string {
  return globalThis.crypto.randomUUID();
}

export type AssistantStreamTerminalStatus =
  | "completed"
  | "background_pending"
  | "cancellation_pending"
  | "cancelled"
  | "error";

export function parseAssistantStreamTerminalStatus(
  value: unknown,
): AssistantStreamTerminalStatus | null {
  return value === "completed" ||
    value === "background_pending" ||
    value === "cancellation_pending" ||
    value === "cancelled" ||
    value === "error"
    ? value
    : null;
}

export interface AssistantStreamFailure {
  runId?: string;
  code: string;
  retryable: boolean;
  message: string;
}

export function parseAssistantStreamFailure(
  value: Record<string, unknown>,
): AssistantStreamFailure {
  return {
    ...(typeof value.runId === "string" && value.runId.trim()
      ? { runId: value.runId }
      : {}),
    code: typeof value.code === "string" && value.code.trim()
      ? value.code : "stream_error",
    retryable: value.retryable === true,
    message: typeof value.message === "string" && value.message.trim()
      ? value.message : "The assistant failed before it could finish.",
  };
}
