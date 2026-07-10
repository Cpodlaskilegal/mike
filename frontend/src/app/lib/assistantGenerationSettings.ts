export const GPT56_MODEL_IDS = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
] as const;

export const GPT56_REASONING_EFFORTS = [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export const PRO_REASONING_EFFORTS = [
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export const CLAUDE_MAIN_MODEL_IDS = [
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
] as const;

export const GEMINI_MAIN_MODEL_IDS = [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;

export const ALLOWED_MAIN_MODEL_IDS: ReadonlySet<string> = new Set([
    ...GPT56_MODEL_IDS,
    ...CLAUDE_MAIN_MODEL_IDS,
    ...GEMINI_MAIN_MODEL_IDS,
]);

export const ASSISTANT_GENERATION_STORAGE_KEY =
    "docket.assistant-generation-settings.v1";
export const LEGACY_ASSISTANT_MODEL_STORAGE_KEY = "docket.selectedModel";

export type Gpt56ModelId = (typeof GPT56_MODEL_IDS)[number];
export type Gpt56ReasoningEffort =
    (typeof GPT56_REASONING_EFFORTS)[number];
export type ProReasoningEffort = (typeof PRO_REASONING_EFFORTS)[number];
export type AssistantReasoningMode = "standard" | "pro";

export type AssistantGenerationSettingsState = {
    model: string;
    standardEffort: Gpt56ReasoningEffort;
    proEffort: ProReasoningEffort;
    reasoningMode: AssistantReasoningMode;
    sessionKey: string | null;
};

export type EffectiveAssistantGenerationSettings = {
    model: string;
    reasoningEffort: Gpt56ReasoningEffort;
    reasoningMode: AssistantReasoningMode;
};

export type AssistantGenerationStorageSnapshot = {
    versioned?: string | null;
    legacy?: string | null;
};

const DEFAULT_MODEL: Gpt56ModelId = "gpt-5.6-sol";
const DEFAULT_EFFORT: Gpt56ReasoningEffort = "medium";
const GPT56_MODEL_SET = new Set<string>(GPT56_MODEL_IDS);
const EFFORT_SET = new Set<string>(GPT56_REASONING_EFFORTS);
const PRO_EFFORT_SET = new Set<string>(PRO_REASONING_EFFORTS);

const LEGACY_GPT_SETTINGS: Record<
    string,
    { model: Gpt56ModelId; effort: Gpt56ReasoningEffort }
> = {
    "gpt-5.5": { model: "gpt-5.6-sol", effort: "medium" },
    "gpt-5.5-pro": { model: "gpt-5.6-sol", effort: "high" },
    "gpt-5.4": { model: "gpt-5.6-sol", effort: "medium" },
    "gpt-5.4-mini": { model: "gpt-5.6-terra", effort: "low" },
};

function isReasoningEffort(value: unknown): value is Gpt56ReasoningEffort {
    return typeof value === "string" && EFFORT_SET.has(value);
}

function isProReasoningEffort(value: unknown): value is ProReasoningEffort {
    return typeof value === "string" && PRO_EFFORT_SET.has(value);
}

function isAllowedMainModel(value: unknown): value is string {
    return typeof value === "string" && ALLOWED_MAIN_MODEL_IDS.has(value);
}

function proEffortFor(
    effort: Gpt56ReasoningEffort,
): ProReasoningEffort {
    return isProReasoningEffort(effort) ? effort : "medium";
}

function hydratedState(
    model: string,
    standardEffort: Gpt56ReasoningEffort,
): AssistantGenerationSettingsState {
    return {
        model,
        standardEffort,
        proEffort: proEffortFor(standardEffort),
        reasoningMode: "standard",
        sessionKey: null,
    };
}

export function isGpt56Model(model: unknown): model is Gpt56ModelId {
    return typeof model === "string" && GPT56_MODEL_SET.has(model);
}

export function defaultAssistantGenerationSettings(): AssistantGenerationSettingsState {
    return hydratedState(DEFAULT_MODEL, DEFAULT_EFFORT);
}

function parseVersionedSettings(
    raw: string | null | undefined,
): AssistantGenerationSettingsState | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        if (
            record.version !== 1 ||
            !isAllowedMainModel(record.model) ||
            !isReasoningEffort(record.standardEffort)
        ) {
            return null;
        }
        return hydratedState(record.model, record.standardEffort);
    } catch {
        return null;
    }
}

function migrateLegacySettings(
    raw: string | null | undefined,
): AssistantGenerationSettingsState | null {
    if (!raw) return null;
    const mapped = LEGACY_GPT_SETTINGS[raw];
    if (mapped) return hydratedState(mapped.model, mapped.effort);
    if (isAllowedMainModel(raw)) return hydratedState(raw, DEFAULT_EFFORT);
    return null;
}

export function deserializeAssistantGenerationSettings(
    raw: AssistantGenerationStorageSnapshot | null | undefined,
): AssistantGenerationSettingsState {
    const versioned = parseVersionedSettings(raw?.versioned);
    if (versioned) return versioned;
    return (
        migrateLegacySettings(raw?.legacy) ??
        defaultAssistantGenerationSettings()
    );
}

export function serializeAssistantGenerationSettings(
    state: AssistantGenerationSettingsState,
): string {
    const model = isAllowedMainModel(state.model)
        ? state.model
        : DEFAULT_MODEL;
    const standardEffort = isReasoningEffort(state.standardEffort)
        ? state.standardEffort
        : DEFAULT_EFFORT;
    return JSON.stringify({ version: 1, model, standardEffort });
}

export function selectAssistantModel(
    state: AssistantGenerationSettingsState,
    model: string,
): AssistantGenerationSettingsState {
    const nextModel = isAllowedMainModel(model) ? model : DEFAULT_MODEL;
    return {
        ...state,
        model: nextModel,
        reasoningMode: isGpt56Model(nextModel)
            ? state.reasoningMode
            : "standard",
    };
}

export function selectAssistantEffort(
    state: AssistantGenerationSettingsState,
    effort: Gpt56ReasoningEffort,
): AssistantGenerationSettingsState {
    if (state.reasoningMode === "pro") {
        return {
            ...state,
            proEffort: proEffortFor(effort),
        };
    }
    return {
        ...state,
        standardEffort: isReasoningEffort(effort)
            ? effort
            : state.standardEffort,
    };
}

export function setAssistantReasoningMode(
    state: AssistantGenerationSettingsState,
    mode: AssistantReasoningMode,
): AssistantGenerationSettingsState {
    if (mode !== "pro" || !isGpt56Model(state.model)) {
        return { ...state, reasoningMode: "standard" };
    }
    return {
        ...state,
        proEffort: proEffortFor(state.standardEffort),
        reasoningMode: "pro",
    };
}

export function resetAssistantSession(
    state: AssistantGenerationSettingsState,
): AssistantGenerationSettingsState {
    return { ...state, reasoningMode: "standard" };
}

export function effectiveAssistantGenerationSettings(
    state: AssistantGenerationSettingsState,
): EffectiveAssistantGenerationSettings {
    const isPro = state.reasoningMode === "pro" && isGpt56Model(state.model);
    return {
        model: state.model,
        reasoningEffort: isPro ? state.proEffort : state.standardEffort,
        reasoningMode: isPro ? "pro" : "standard",
    };
}
