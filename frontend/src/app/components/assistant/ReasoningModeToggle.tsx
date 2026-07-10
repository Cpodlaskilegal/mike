"use client";

import type { AssistantReasoningMode } from "@/app/lib/assistantGenerationSettings";

export function ReasoningModeToggle({
    value,
    onChange,
    disabled = false,
}: {
    value: AssistantReasoningMode;
    onChange: (mode: AssistantReasoningMode) => void;
    disabled?: boolean;
}) {
    return (
        <div
            className="flex h-8 items-center rounded-lg bg-gray-100 p-0.5"
            aria-label="Reasoning mode"
            title="Pro can take longer and cost more"
        >
            {(["standard", "pro"] as const).map((mode) => (
                <button
                    key={mode}
                    type="button"
                    disabled={disabled}
                    aria-pressed={value === mode}
                    onClick={() => onChange(mode)}
                    className={`h-7 rounded-md px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        value === mode
                            ? "bg-white text-gray-800 shadow-sm"
                            : "text-gray-500 hover:text-gray-700"
                    }`}
                >
                    {mode === "standard" ? "Standard" : "Pro"}
                </button>
            ))}
        </div>
    );
}
