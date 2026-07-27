"use client";

import {
    type AssistantReasoningEffort,
} from "@/app/lib/assistantGenerationSettings";

const LABELS: Record<AssistantReasoningEffort, string> = {
    none: "None",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "X-High",
    max: "Max",
};

export function ReasoningEffortToggle({
    value,
    efforts,
    onChange,
    disabled = false,
}: {
    value: AssistantReasoningEffort;
    efforts: readonly AssistantReasoningEffort[];
    onChange: (effort: AssistantReasoningEffort) => void;
    disabled?: boolean;
}) {
    return (
        <select
            aria-label="Reasoning effort"
            value={value}
            disabled={disabled}
            onChange={(event) =>
                onChange(event.target.value as AssistantReasoningEffort)
            }
            className="h-8 rounded-lg border-0 bg-transparent px-2 text-sm text-gray-500 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
            {efforts.map((effort) => (
                <option key={effort} value={effort}>
                    {LABELS[effort]}
                </option>
            ))}
        </select>
    );
}
