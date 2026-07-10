"use client";

import {
    GPT56_REASONING_EFFORTS,
    PRO_REASONING_EFFORTS,
    type AssistantReasoningMode,
    type Gpt56ReasoningEffort,
} from "@/app/lib/assistantGenerationSettings";

const LABELS: Record<Gpt56ReasoningEffort, string> = {
    none: "None",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "X-High",
    max: "Max",
};

export function ReasoningEffortToggle({
    value,
    mode,
    onChange,
    disabled = false,
}: {
    value: Gpt56ReasoningEffort;
    mode: AssistantReasoningMode;
    onChange: (effort: Gpt56ReasoningEffort) => void;
    disabled?: boolean;
}) {
    const efforts =
        mode === "pro" ? PRO_REASONING_EFFORTS : GPT56_REASONING_EFFORTS;
    return (
        <select
            aria-label="Reasoning effort"
            value={value}
            disabled={disabled}
            onChange={(event) =>
                onChange(event.target.value as Gpt56ReasoningEffort)
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
