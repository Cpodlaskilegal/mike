import type {
  DocketAssistantRun,
  DocketMessage,
} from "../components/shared/types";

export const ASSISTANT_CANCELLATION_PENDING_MESSAGE =
  "Cancellation requested. Docket is confirming provider shutdown.";

/** Find the newest pending assistant message carrying a durable run ID. */
export function findHydratedAssistantRun(
  messages: DocketMessage[],
): DocketAssistantRun | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === "assistant" &&
      message.pending &&
      message.assistantRun
    ) {
      return message.assistantRun;
    }
  }
  return null;
}

/** Show durable cancellation acknowledgement while provider shutdown finishes. */
export function markAssistantCancellationPending(
  messages: DocketMessage[],
  streamRequestId: string,
): DocketMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === "assistant" &&
      message.pending &&
      message.assistantRun?.streamRequestId === streamRequestId
    ) {
      const updated = [...messages];
      updated[index] = {
        ...message,
        error: ASSISTANT_CANCELLATION_PENDING_MESSAGE,
      };
      return updated;
    }
  }
  return messages;
}
