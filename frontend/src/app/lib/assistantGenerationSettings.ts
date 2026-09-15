export const GPT56_MODEL_IDS = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
] as const;

export const ASTRA_MODEL_ID = "gpt-6-astra";

export const OPENAI_MAIN_MODEL_IDS = [
    ASTRA_MODEL_ID,
    ...GPT56_MODEL_IDS,
] as const;

export const ASTRA_REASONING_EFFORTS = [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
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

export const CLAUDE_REASONING_EFFORTS = [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export const CLAUDE_OPUS_5_REASONING_EFFORTS = CLAUDE_REASONING_EFFORTS;

export const CLAUDE_REASONING_MODEL_IDS = [
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-opus-5",
] as const;

export const CLAUDE_MAIN_MODEL_IDS = [
    "claude-fable-5-1",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
] as const;

export const GEMINI_MAIN_MODEL_IDS = [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;

export const ALLOWED_MAIN_MODEL_IDS: ReadonlySet<string> = new Set([
    ...OPENAI_MAIN_MODEL_IDS,
    ...CLAUDE_MAIN_MODEL_IDS,
    ...GEMINI_MAIN_MODEL_IDS,
]);

export const ASSISTANT_GENERATION_STORAGE_KEY =
    "docket.assistant-generation-settings.v1";
export const LEGACY_ASSISTANT_MODEL_STORAGE_KEY = "docket.selectedModel";

export type Gpt56ModelId = (typeof GPT56_MODEL_IDS)[number];
export type OpenAiMainModelId = (typeof OPENAI_MAIN_MODEL_IDS)[number];
export type AssistantReasoningEffort =
    (typeof GPT56_REASONING_EFFORTS)[number];
export type Gpt56ReasoningEffort = AssistantReasoningEffort;
export type ProReasoningEffort = (typeof PRO_REASONING_EFFORTS)[number];
export type ClaudeReasoningModelId = (typeof CLAUDE_REASONING_MODEL_IDS)[number];
export type ClaudeReasoningEffort =
    (typeof CLAUDE_REASONING_EFFORTS)[number];
export type ClaudeOpus5ReasoningEffort = ClaudeReasoningEffort;
export type AssistantReasoningMode = "standard" | "pro";

export type AssistantGenerationSettingsState = {
    model: string;
    standardEffort: Gpt56ReasoningEffort;
    proEffort: ProReasoningEffort;
    claudeEffort: ClaudeReasoningEffort;
    reasoningMode: AssistantReasoningMode;
    sessionKey: string | null;
};

export type EffectiveAssistantGenerationSettings = {
    model: string;
    reasoningEffort: AssistantReasoningEffort;
    reasoningMode: AssistantReasoningMode;
};

export type AssistantGenerationStorageSnapshot = {
    versioned?: string | null;
    legacy?: string | null;
};

const DEFAULT_MODEL: OpenAiMainModelId = ASTRA_MODEL_ID;
const DEFAULT_EFFORT: Gpt56ReasoningEffort = "max";
const DEFAULT_CLAUDE_EFFORT: ClaudeReasoningEffort = "high";
const GPT56_MODEL_SET = new Set<string>(GPT56_MODEL_IDS);
const OPENAI_MAIN_MODEL_SET = new Set<string>(OPENAI_MAIN_MODEL_IDS);
const EFFORT_SET = new Set<string>(GPT56_REASONING_EFFORTS);
const PRO_EFFORT_SET = new Set<string>(PRO_REASONING_EFFORTS);
const CLAUDE_EFFORT_SET = new Set<string>(CLAUDE_REASONING_EFFORTS);
const CLAUDE_REASONING_MODEL_SET = new Set<string>(CLAUDE_REASONING_MODEL_IDS);

const LEGACY_GPT_SETTINGS: Record<
    string,
    { model: Gpt56ModelId; effort: Gpt56ReasoningEffort }
> = {
    "gpt-5.5": { model: "gpt-5.6-sol", effort: "medium" },
    "gpt-5.5-pro": { model: "gpt-5.6-sol", effort: "high" },
    "gpt-5.4": { model: "gpt-5.6-sol", effort: "medium" },
    "gpt-5.4-mini": { model: "gpt-5.6-terra", effort: "low" },
};

const LEGACY_NON_OPENAI_MODELS: Record<string, string> = {
    "claude-mythos-5": "claude-sonnet-5",
};

function isReasoningEffort(value: unknown): value is Gpt56ReasoningEffort {
    return typeof value === "string" && EFFORT_SET.has(value);
}

function isProReasoningEffort(value: unknown): value is ProReasoningEffort {
    return typeof value === "string" && PRO_EFFORT_SET.has(value);
}

export function isClaudeReasoningEffort(
    value: unknown,
): value is ClaudeReasoningEffort {
    return (
        typeof value === "string" &&
        CLAUDE_EFFORT_SET.has(value)
    );
}

export const isClaudeOpus5ReasoningEffort = isClaudeReasoningEffort;

function isAllowedMainModel(value: unknown): value is string {
    return typeof value === "string" && ALLOWED_MAIN_MODEL_IDS.has(value);
}

function storedMainModel(value: unknown): string | null {
    if (isAllowedMainModel(value)) return value;
    if (typeof value !== "string") return null;
    return LEGACY_NON_OPENAI_MODELS[value] ?? null;
}

function proEffortFor(
    effort: Gpt56ReasoningEffort,
): ProReasoningEffort {
    return isProReasoningEffort(effort) ? effort : "medium";
}

function hydratedState(
    model: string,
    standardEffort: Gpt56ReasoningEffort,
    claudeEffort: ClaudeReasoningEffort = DEFAULT_CLAUDE_EFFORT,
): AssistantGenerationSettingsState {
    const effort = normalizeOpenAiReasoningEffort(model, standardEffort);
    return {
        model,
        standardEffort: effort,
        proEffort: proEffortFor(effort),
        claudeEffort,
        reasoningMode: "standard",
        sessionKey: null,
    };
}

export function isGpt56Model(model: unknown): model is Gpt56ModelId {
    return typeof model === "string" && GPT56_MODEL_SET.has(model);
}

export function isOpenAiReasoningModel(
    model: unknown,
): model is OpenAiMainModelId {
    return typeof model === "string" && OPENAI_MAIN_MODEL_SET.has(model);
}

export function normalizeOpenAiReasoningEffort(
    model: unknown,
    effort: AssistantReasoningEffort,
): AssistantReasoningEffort {
    return model === ASTRA_MODEL_ID && effort === "none" ? "low" : effort;
}

export function isClaudeOpus5Model(
    model: unknown,
): model is "claude-opus-5" {
    return model === "claude-opus-5";
}

export function isClaudeReasoningModel(
    model: unknown,
): model is ClaudeReasoningModelId {
    return typeof model === "string" && CLAUDE_REASONING_MODEL_SET.has(model);
}

export function assistantReasoningEffortsFor(
    model: unknown,
    mode: AssistantReasoningMode,
): readonly AssistantReasoningEffort[] | null {
    if (isClaudeReasoningModel(model)) {
        return CLAUDE_REASONING_EFFORTS;
    }
    if (!isOpenAiReasoningModel(model)) return null;
    return mode === "pro"
        ? PRO_REASONING_EFFORTS
        : model === ASTRA_MODEL_ID
          ? ASTRA_REASONING_EFFORTS
          : GPT56_REASONING_EFFORTS;
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
        const model = storedMainModel(record.model);
        if (
            record.version !== 1 ||
            !model ||
            !isReasoningEffort(record.standardEffort)
        ) {
            return null;
        }
        const claudeEffort = isClaudeReasoningEffort(
            record.claudeEffort,
        )
            ? record.claudeEffort
            : DEFAULT_CLAUDE_EFFORT;
        return hydratedState(model, record.standardEffort, claudeEffort);
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
    const model = storedMainModel(raw);
    if (model) return hydratedState(model, DEFAULT_EFFORT);
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
    const standardEffort = normalizeOpenAiReasoningEffort(
        model,
        isReasoningEffort(state.standardEffort)
            ? state.standardEffort
            : DEFAULT_EFFORT,
    );
    const claudeEffort = isClaudeReasoningEffort(state.claudeEffort)
        ? state.claudeEffort
        : DEFAULT_CLAUDE_EFFORT;
    return JSON.stringify({
        version: 1,
        model,
        standardEffort,
        claudeEffort,
    });
}

export type AssistantGenerationSettingsStorage = {
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

export function persistAssistantGenerationSettings(
    storage: AssistantGenerationSettingsStorage,
    state: AssistantGenerationSettingsState,
): boolean {
    try {
        storage.setItem(
            ASSISTANT_GENERATION_STORAGE_KEY,
            serializeAssistantGenerationSettings(state),
        );
    } catch {
        return false;
    }

    try {
        storage.removeItem(LEGACY_ASSISTANT_MODEL_STORAGE_KEY);
    } catch {
        // The versioned preference already won hydration precedence. Storage
        // implementations can deny removal independently of a successful set.
    }
    return true;
}

export function selectAssistantModel(
    state: AssistantGenerationSettingsState,
    model: string,
): AssistantGenerationSettingsState {
    const nextModel = isAllowedMainModel(model) ? model : DEFAULT_MODEL;
    return {
        ...state,
        model: nextModel,
        standardEffort: normalizeOpenAiReasoningEffort(
            nextModel,
            state.standardEffort,
        ),
        reasoningMode: isOpenAiReasoningModel(nextModel)
            ? state.reasoningMode
            : "standard",
    };
}

export function selectAssistantEffort(
    state: AssistantGenerationSettingsState,
    effort: AssistantReasoningEffort,
): AssistantGenerationSettingsState {
    if (isClaudeReasoningModel(state.model)) {
        return {
            ...state,
            claudeEffort: isClaudeReasoningEffort(effort)
                ? effort
                : state.claudeEffort,
        };
    }
    if (state.reasoningMode === "pro") {
        return {
            ...state,
            proEffort: proEffortFor(effort),
        };
    }
    return {
        ...state,
        standardEffort: isReasoningEffort(effort)
            ? normalizeOpenAiReasoningEffort(state.model, effort)
            : state.standardEffort,
    };
}

export function setAssistantReasoningMode(
    state: AssistantGenerationSettingsState,
    mode: AssistantReasoningMode,
): AssistantGenerationSettingsState {
    if (mode !== "pro" || !isOpenAiReasoningModel(state.model)) {
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

export function activateAssistantSession(
    state: AssistantGenerationSettingsState,
    nextSessionKey: string,
): AssistantGenerationSettingsState {
    if (state.sessionKey === nextSessionKey) return state;
    return {
        ...resetAssistantSession(state),
        sessionKey: nextSessionKey,
    };
}

export function adoptCreatedAssistantChat(
    state: AssistantGenerationSettingsState,
    createdChatKey: string,
): AssistantGenerationSettingsState {
    if (state.sessionKey === "new:assistant") {
        return { ...state, sessionKey: createdChatKey };
    }
    return {
        ...resetAssistantSession(state),
        sessionKey: createdChatKey,
    };
}

export function effectiveAssistantGenerationSettings(
    state: AssistantGenerationSettingsState,
): EffectiveAssistantGenerationSettings {
    const isPro =
        state.reasoningMode === "pro" && isOpenAiReasoningModel(state.model);
    if (isClaudeReasoningModel(state.model)) {
        return {
            model: state.model,
            reasoningEffort: state.claudeEffort,
            reasoningMode: "standard",
        };
    }
    return {
        model: state.model,
        reasoningEffort: isPro
            ? state.proEffort
            : normalizeOpenAiReasoningEffort(state.model, state.standardEffort),
        reasoningMode: isPro ? "pro" : "standard",
    };
}
