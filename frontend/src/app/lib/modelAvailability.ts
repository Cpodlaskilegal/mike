export type ModelProvider = "claude" | "gemini" | "openai";
export type ModelGroup = "Anthropic" | "Google" | "OpenAI";

export type ProviderAvailability = {
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    openaiEnabled: boolean;
};

export function getModelProvider(modelId: string): ModelProvider | null {
    if (modelId.startsWith("claude")) return "claude";
    if (modelId.startsWith("gemini")) return "gemini";
    if (modelId.startsWith("gpt-")) return "openai";
    return null;
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ProviderAvailability,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    if (provider === "openai") return apiKeys.openaiEnabled;
    return provider === "claude"
        ? !!apiKeys.claudeApiKey?.trim()
        : !!apiKeys.geminiApiKey?.trim();
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ProviderAvailability,
): boolean {
    if (provider === "openai") return apiKeys.openaiEnabled;
    return provider === "claude"
        ? !!apiKeys.claudeApiKey?.trim()
        : !!apiKeys.geminiApiKey?.trim();
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "openai") return "OpenAI";
    return "Google (Gemini)";
}

export function modelGroupToProvider(
    group: ModelGroup,
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "OpenAI") return "openai";
    return "gemini";
}
