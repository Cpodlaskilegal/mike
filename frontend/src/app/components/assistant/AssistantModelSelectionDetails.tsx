import type { DocketModelSelection } from "../shared/types";

export function AssistantModelSelectionDetails({ selection, instructionVersion }: {
    selection?: DocketModelSelection; instructionVersion?: number;
}) {
    if (!selection) return null;
    return <div className="mb-2 text-xs text-gray-500">
        <p>{selection.mode === "auto" ? "Auto" : "Manual"}: {selection.model} · {selection.task}</p>
        <p className="mt-1">{selection.reason}</p>
        <details className="mt-1"><summary className="cursor-pointer">Selection details</summary>
            <p>Policy {selection.policyVersion}{instructionVersion === undefined ? "" : ` · Project instructions V${instructionVersion}`}</p>
        </details>
    </div>;
}
