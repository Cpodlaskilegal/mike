import type { ApiKeyState } from "@/app/lib/docketApi";
import {
    CLAUDE_MAIN_MODEL_IDS,
    GEMINI_MAIN_MODEL_IDS,
    GPT56_MODEL_IDS,
} from "@/app/lib/assistantGenerationSettings";

export type ModelProvider = "claude" | "gemini" | "openai";
export type ModelGroup = "Anthropic" | "Google" | "OpenAI";

const CLAUDE_MODELS = new Set<string>(CLAUDE_MAIN_MODEL_IDS);
const GEMINI_MODELS = new Set<string>(GEMINI_MAIN_MODEL_IDS);
const OPENAI_MODELS = new Set<string>(GPT56_MODEL_IDS);

export function getModelProvider(modelId: string): ModelProvider | null {
    if (OPENAI_MODELS.has(modelId) || modelId.startsWith("gpt-")) {
        return "openai";
    }
    if (CLAUDE_MODELS.has(modelId) || modelId.startsWith("claude-")) {
        return "claude";
    }
    if (GEMINI_MODELS.has(modelId) || modelId.startsWith("gemini-")) {
        return "gemini";
    }
    return null;
}

export function isModelAvailable(
    modelId: string,
    apiKeys: ApiKeyState,
): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    return isProviderAvailable(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyState,
): boolean {
    return !!apiKeys[provider]?.configured;
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
