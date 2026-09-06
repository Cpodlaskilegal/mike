import {
    isClaudeOpus5Model,
    isClaudeOpus5ReasoningEffort,
    isOpenAiReasoningModel,
    normalizeOpenAiReasoningEffort,
    type AssistantReasoningEffort,
    type EffectiveAssistantGenerationSettings,
} from "./assistantGenerationSettings";

export type AssistantGenerationPayload = {
    model: string;
    reasoning_effort?: AssistantReasoningEffort;
    reasoning_mode?: "standard" | "pro";
};

export function buildAssistantGenerationPayload(
    settings: EffectiveAssistantGenerationSettings,
): AssistantGenerationPayload {
    if (isClaudeOpus5Model(settings.model)) {
        return {
            model: settings.model,
            reasoning_effort: isClaudeOpus5ReasoningEffort(
                settings.reasoningEffort,
            )
                ? settings.reasoningEffort
                : "high",
        };
    }
    if (!isOpenAiReasoningModel(settings.model)) return { model: settings.model };
    const effort =
        settings.reasoningMode === "pro" &&
        (settings.reasoningEffort === "none" ||
            settings.reasoningEffort === "low")
            ? "medium"
            : normalizeOpenAiReasoningEffort(
                  settings.model,
                  settings.reasoningEffort,
              );
    return {
        model: settings.model,
        reasoning_effort: effort,
        reasoning_mode: settings.reasoningMode,
    };
}

/** Match the backend's durable Pro/Max disconnect policy before SSE starts. */
export function assistantRequestContinuesAfterDisconnect(
    payload: AssistantGenerationPayload,
): boolean {
    return (
        payload.reasoning_mode === "pro" || payload.reasoning_effort === "max"
    );
}
