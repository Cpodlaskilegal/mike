import { createServerSupabase } from "./supabase";
import {
    resolveTabularModel,
    DEFAULT_TITLE_MODEL,
    OPENAI_LOW_MODELS,
    type UserApiKeys,
} from "./llm";
import { getUserApiKeys as getStoredUserApiKeys } from "./userApiKeys";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    legal_research_us: boolean;
    api_keys: UserApiKeys;
};

// Title generation is a lightweight task. Prefer OpenAI for this Azure
// deployment when an env or user key is available, then fall back to Claude or
// Gemini user keys.
function resolveTitleModel(apiKeys: UserApiKeys): string {
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data, error } = await client
        .from("user_profiles")
        .select("tabular_model, legal_research_us")
        .eq("user_id", userId)
        .single();
    const api_keys = await getStoredUserApiKeys(userId, client);
    const legalResearchUs =
        error && (error as { code?: string }).code === "42703"
            ? true
            : (data as { legal_research_us?: boolean | null } | null)
                  ?.legal_research_us !== false;

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model: resolveTabularModel(data?.tabular_model),
        legal_research_us: legalResearchUs,
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    return getStoredUserApiKeys(userId, client);
}
