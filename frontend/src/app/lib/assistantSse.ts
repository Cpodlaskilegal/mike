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
