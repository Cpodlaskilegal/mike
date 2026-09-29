import type { DocketMessage } from "../components/shared/types";

export type AssistantSubmissionResult =
  | { kind: "preflight_failed"; message?: string; requestId?: string; draft?: DocketMessage }
  | { kind: "sent"; chatId: string | null };

export function isConfirmedPreflightFailure(input: {
  authRequired: boolean;
  httpRejectedBeforeStream: boolean;
  streamStarted: boolean;
  messageSaved?: boolean | null;
  runStatus?: "unknown" | null;
  retryable?: boolean | null;
}): boolean {
  return !input.streamStarted && input.runStatus !== "unknown" &&
    input.retryable !== false && input.messageSaved !== true &&
    (input.authRequired || input.httpRejectedBeforeStream);
}

export function parseAssistantHttpRejection(raw: string): {
  messageSaved: boolean | null;
  chatId: string | null;
  requestId: string | null;
  runStatus: "unknown" | null;
  retryable: boolean | null;
} {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      messageSaved: typeof data.message_saved === "boolean" ? data.message_saved : null,
      chatId: typeof data.chat_id === "string" && data.chat_id ? data.chat_id : null,
      requestId: typeof data.request_id === "string" && data.request_id ? data.request_id : null,
      runStatus: data.run_status === "unknown" ? "unknown" : null,
      retryable: typeof data.retryable === "boolean" ? data.retryable : null,
    };
  } catch {
    return { messageSaved: null, chatId: null, requestId: null, runStatus: null, retryable: null };
  }
}

export function preflightDraftFromResult(
  result: AssistantSubmissionResult,
  message: DocketMessage,
): DocketMessage | null {
  return result.kind === "preflight_failed"
    ? {
        ...(result.draft ?? message),
        ...(result.message ? { error: result.message } : {}),
        ...(result.requestId ? { startFailureRequestId: result.requestId } : {}),
      }
    : null;
}

/** Remove only the pair created for this local attempt, keeping prior turns. */
export function rollbackOptimisticPreflight(
  messages: DocketMessage[],
  submitted: DocketMessage,
  alreadyPresentUser?: DocketMessage,
): DocketMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant" || messages[messages.length - 2] !== submitted) {
    return messages;
  }
  return alreadyPresentUser
    ? [...messages.slice(0, -2), alreadyPresentUser]
    : messages.slice(0, -2);
}

/** A late handoff must not replace typing, attachments, or workflow changes. */
export function shouldApplyRecoveryDraft(currentEpoch: number): boolean {
  return currentEpoch === 0;
}

export function withDisplayedDocument(
  message: DocketMessage,
  displayedDoc?: { filename: string; documentId: string } | null,
): DocketMessage {
  if (!displayedDoc?.documentId ||
      message.files?.some((file) => file.document_id === displayedDoc.documentId)) {
    return message;
  }
  return {
    ...message,
    files: [
      ...(message.files ?? []),
      { filename: displayedDoc.filename, document_id: displayedDoc.documentId },
    ],
  };
}

export interface RecoveryContext {
  latestUser: DocketMessage;
  initiatingUser?: DocketMessage;
  isAskInputsResponse: boolean;
  askInputsRequestId?: string;
}

export function askInputsElementId(requestId: string): string {
  return `docket-ask-inputs-${requestId}`;
}

const ASK_INPUTS_RESPONSE_PREFIX = /^Responses to Docket's questions:/i;

/** The new turn is a draft. The user reviews it before any tool can run again. */
export function buildContinuationDraft(
  source: DocketMessage | RecoveryContext,
): DocketMessage {
  const context: RecoveryContext = "latestUser" in source
    ? source
    : { latestUser: source, isAskInputsResponse: false };
  const original = context.initiatingUser;
  const latest = context.latestUser;
  const priorRequestText = context.isAskInputsResponse
    ? [
        ...(original ? ["Initiating request:", original.content, ""] : []),
        "Latest response to Docket's questions:",
        latest.content,
      ]
    : ["Original request:", latest.content];
  const seenDocuments = new Set<string>();
  const files = [original, latest].flatMap((message) =>
    (message?.files ?? []).filter((file) => {
      const key = file.document_id ?? file.filename;
      if (seenDocuments.has(key)) return false;
      seenDocuments.add(key);
      return true;
    }).map((file) => ({ ...file })),
  );
  return {
    role: "user",
    content: [
      "Continue the request below from where the previous response stopped. Use work already completed, and do not repeat completed work or external changes. If you cannot tell whether an external change succeeded, ask me before trying it again.",
      "",
      ...priorRequestText,
    ].join("\n"),
    files: files.length ? files : undefined,
    workflow: latest.workflow
      ? { ...latest.workflow }
      : original?.workflow ? { ...original.workflow } : undefined,
  };
}

export function findRecoveryContext(
  messages: DocketMessage[],
  assistantIndex: number,
): RecoveryContext | null {
  if (messages[assistantIndex]?.role !== "assistant") return null;
  let latestUserIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return null;
  const latestUser = messages[latestUserIndex];
  const isAskInputsResponse = ASK_INPUTS_RESPONSE_PREFIX.test(latestUser.content);
  let initiatingUser: DocketMessage | undefined;
  let askInputsRequestId: string | undefined;
  if (isAskInputsResponse) {
    for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (!askInputsRequestId && candidate.role === "assistant") {
        for (const event of [...(candidate.events ?? [])].reverse()) {
          if (event.type === "ask_inputs") {
            askInputsRequestId = event.request_id;
            break;
          }
        }
      }
      if (candidate.role === "user" && !ASK_INPUTS_RESPONSE_PREFIX.test(candidate.content)) {
        initiatingUser = candidate;
        break;
      }
    }
  }
  return { latestUser, initiatingUser, isAskInputsResponse, askInputsRequestId };
}

export function findRecoverySource(
  messages: DocketMessage[],
  assistantIndex: number,
): DocketMessage | null {
  return findRecoveryContext(messages, assistantIndex)?.latestUser ?? null;
}

export function shouldOfferContinue(message: DocketMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.pending &&
    !!message.error &&
    (message.assistantRun?.status === "failed" ||
      message.assistantRun?.status === "interrupted") &&
    message.assistantRun.retryable === true
  );
}

export function shouldRestoreSubmittedDraft(
  result: AssistantSubmissionResult | void,
  submissionEpoch: number,
  currentEpoch: number,
): boolean {
  return result?.kind === "preflight_failed" && submissionEpoch === currentEpoch;
}
