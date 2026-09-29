"use client";

import { AssistantDiagnosticId } from "./AssistantDiagnosticId";

interface Props {
    runId?: string;
    requestId?: string;
    errorCode?: string | null;
    startupSaved?: boolean;
    statusUnconfirmed?: boolean;
    canContinue: boolean;
    canRestore?: boolean;
    showRestore?: boolean;
    onContinue: () => void;
    onRestore: () => void;
    onRetryInputs?: () => void;
}

/** Recovery is a draft action: nothing is sent until the user reviews it. */
export function AssistantRecoveryActions({
    runId,
    requestId,
    errorCode,
    startupSaved = false,
    statusUnconfirmed = false,
    canContinue,
    canRestore = true,
    showRestore = true,
    onContinue,
    onRestore,
    onRetryInputs,
}: Props) {
    return (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-gray-800">
            {!statusUnconfirmed && (
            <div className="flex flex-wrap items-center gap-2">
                {onRetryInputs ? (
                    <button
                        type="button"
                        onClick={onRetryInputs}
                        className="rounded-md bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700"
                    >
                        Return to Docket&apos;s questions
                    </button>
                ) : (
                <button
                    type="button"
                    onClick={onContinue}
                    disabled={!canContinue}
                    className="rounded-md bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Continue in a new message
                </button>
                )}
                {showRestore && (
                    <button
                        type="button"
                        onClick={onRestore}
                        disabled={!canRestore}
                        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Restore original request
                    </button>
                )}
            </div>
            )}
            <p className="mt-2 text-xs text-gray-600">
                {statusUnconfirmed
                    ? "The request status is unconfirmed. Do not resubmit this request. Contact support with the Request ID while Docket checks whether it started."
                    : startupSaved
                    ? "Your request was saved, but the assistant response did not start. Review before trying again."
                    : "Review the draft before sending. Docket will not automatically repeat external changes."}
            </p>
            {(runId || requestId || errorCode) && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-600">
                    {runId && <AssistantDiagnosticId id={runId} kind="run" />}
                    {requestId && <AssistantDiagnosticId id={requestId} kind="request" />}
                    {errorCode && <span>Reason: {errorCode}</span>}
                </div>
            )}
        </div>
    );
}
