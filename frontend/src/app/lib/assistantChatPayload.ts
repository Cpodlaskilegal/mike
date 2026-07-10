import {
    isGpt56Model,
    type EffectiveAssistantGenerationSettings,
    type Gpt56ReasoningEffort,
} from "./assistantGenerationSettings";

export type AssistantGenerationPayload = {
    model: string;
    reasoning_effort?: Gpt56ReasoningEffort;
    reasoning_mode?: "standard" | "pro";
};

export function buildAssistantGenerationPayload(
    settings: EffectiveAssistantGenerationSettings,
): AssistantGenerationPayload {
    if (!isGpt56Model(settings.model)) return { model: settings.model };
    const effort =
        settings.reasoningMode === "pro" &&
        (settings.reasoningEffort === "none" ||
            settings.reasoningEffort === "low")
            ? "medium"
            : settings.reasoningEffort;
    return {
        model: settings.model,
        reasoning_effort: effort,
        reasoning_mode: settings.reasoningMode,
    };
}
