import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    OPENAI_LOW_MODELS,
    type UserApiKeys,
} from "./llm";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

// Title generation is a lightweight task — always routed to the cheapest
// available model. Order: server-managed OpenAI (default for this Azure
// deployment), then user-supplied Claude key, then user-supplied Gemini key.
// Falls through to DEFAULT_TITLE_MODEL (gpt-5.4-nano) which still requires
// OPENAI_API_KEY to be set on the server.
function resolveTitleModel(apiKeys: UserApiKeys): string {
    if (process.env.OPENAI_API_KEY?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select("tabular_model, claude_api_key, gemini_api_key")
        .eq("user_id", userId)
        .single();

    const api_keys: UserApiKeys = {
        claude: data?.claude_api_key ?? null,
        gemini: data?.gemini_api_key ?? null,
    };

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select("claude_api_key, gemini_api_key")
        .eq("user_id", userId)
        .single();
    return {
        claude: data?.claude_api_key ?? null,
        gemini: data?.gemini_api_key ?? null,
    };
}
