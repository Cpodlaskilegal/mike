import type { Provider, ReasoningMode } from "./types";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat models — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MAIN_MODELS = [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
] as const;

export type MainModelId =
    | (typeof CLAUDE_MAIN_MODELS)[number]
    | (typeof GEMINI_MAIN_MODELS)[number]
    | (typeof OPENAI_MAIN_MODELS)[number];

export const ASSISTANT_REASONING_EFFORTS = [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export type AssistantReasoningEffort =
    (typeof ASSISTANT_REASONING_EFFORTS)[number];

// Backwards-compatible GPT aliases for callers that still name this contract
// after the first provider that exposed it in Docket.
export const GPT_5_6_REASONING_EFFORTS = ASSISTANT_REASONING_EFFORTS;
export type Gpt56ReasoningEffort = AssistantReasoningEffort;

// https://developers.openai.com/api/docs/models/gpt-6-astra
export const ASTRA_REASONING_EFFORTS = [
    "low",
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

export type ClaudeReasoningEffort = (typeof CLAUDE_REASONING_EFFORTS)[number];

// Preserve imports used by older callers while sharing the current Claude
// effort contract across the models that support all five levels.
export const CLAUDE_OPUS_5_REASONING_EFFORTS = CLAUDE_REASONING_EFFORTS;
export type ClaudeOpus5ReasoningEffort = ClaudeReasoningEffort;

export const CLAUDE_REASONING_MODELS = [
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-opus-5",
] as const;

export function defaultClaudeReasoningEffort(model: string): ClaudeReasoningEffort {
    return model === "claude-opus-5-5" ? "medium" : "high";
}

export function supportsClaudeReasoningEffort(
    model: unknown,
): model is (typeof CLAUDE_REASONING_MODELS)[number] {
    return (
        typeof model === "string" &&
        (CLAUDE_REASONING_MODELS as readonly string[]).includes(model)
    );
}

export type MainModelResolutionStatus =
    | "direct"
    | "defaulted"
    | "legacy_mapped"
    | "unknown_fallback";

export type ResolvedMainModelRequest = {
    requestedModel: string | null;
    selectionModel: string;
    providerModel: string;
    provider: Provider;
    reasoningEffort?: AssistantReasoningEffort;
    reasoningMode?: ReasoningMode;
    status: MainModelResolutionStatus;
};

export type MainModelRequestParseResult =
    | { ok: true; value: ResolvedMainModelRequest }
    | { ok: false; detail: string };

type OpenAiMainModelId = (typeof OPENAI_MAIN_MODELS)[number];

type OpenAiMainModelConfig = {
    selectionModel: OpenAiMainModelId;
    providerModel: OpenAiMainModelId;
    supportedReasoningEfforts: readonly AssistantReasoningEffort[];
    supportedReasoningModes: readonly ["standard", "pro"];
    defaultReasoningEffort: Gpt56ReasoningEffort;
    streamingByMode: { readonly standard: true; readonly pro: false };
};

const OPENAI_MAIN_MODEL_REGISTRY = {
    "gpt-6-astra": {
        selectionModel: "gpt-6-astra",
        providerModel: "gpt-6-astra",
        supportedReasoningEfforts: ASTRA_REASONING_EFFORTS,
        supportedReasoningModes: ["standard", "pro"],
        defaultReasoningEffort: "max",
        streamingByMode: { standard: true, pro: false },
    },
    "gpt-6-sol": {
        selectionModel: "gpt-6-sol",
        providerModel: "gpt-6-sol",
        supportedReasoningEfforts: ASSISTANT_REASONING_EFFORTS,
        supportedReasoningModes: ["standard", "pro"],
        defaultReasoningEffort: "medium",
        streamingByMode: { standard: true, pro: false },
    },
    "gpt-6-luna": {
        selectionModel: "gpt-6-luna",
        providerModel: "gpt-6-luna",
        supportedReasoningEfforts: ASSISTANT_REASONING_EFFORTS,
        supportedReasoningModes: ["standard", "pro"],
        defaultReasoningEffort: "medium",
        streamingByMode: { standard: true, pro: false },
    },
    "gpt-5.6-sol": {
        selectionModel: "gpt-5.6-sol",
        providerModel: "gpt-5.6-sol",
        supportedReasoningEfforts: GPT_5_6_REASONING_EFFORTS,
        supportedReasoningModes: ["standard", "pro"],
        defaultReasoningEffort: "max",
        streamingByMode: { standard: true, pro: false },
    },
    "gpt-5.6-terra": {
        selectionModel: "gpt-5.6-terra",
        providerModel: "gpt-5.6-terra",
        supportedReasoningEfforts: GPT_5_6_REASONING_EFFORTS,
        supportedReasoningModes: ["standard", "pro"],
        defaultReasoningEffort: "medium",
        streamingByMode: { standard: true, pro: false },
    },
    "gpt-5.6-luna": {
        selectionModel: "gpt-5.6-luna",
        providerModel: "gpt-5.6-luna",
        supportedReasoningEfforts: GPT_5_6_REASONING_EFFORTS,
        supportedReasoningModes: ["standard", "pro"],
        defaultReasoningEffort: "medium",
        streamingByMode: { standard: true, pro: false },
    },
} as const satisfies Record<OpenAiMainModelId, OpenAiMainModelConfig>;

type LegacyMainModelConfig = {
    selectionModel: OpenAiMainModelId;
    reasoningEffort: Gpt56ReasoningEffort;
    reasoningMode: ReasoningMode;
};

const LEGACY_MAIN_MODEL_MAP: Record<string, LegacyMainModelConfig> = {
    "gpt-5.5": {
        selectionModel: "gpt-5.6-sol",
        reasoningEffort: "medium",
        reasoningMode: "standard",
    },
    "gpt-5.5-pro": {
        selectionModel: "gpt-5.6-sol",
        reasoningEffort: "high",
        reasoningMode: "pro",
    },
    "gpt-5.4": {
        selectionModel: "gpt-5.6-sol",
        reasoningEffort: "medium",
        reasoningMode: "standard",
    },
    "gpt-5.4-mini": {
        selectionModel: "gpt-5.6-terra",
        reasoningEffort: "low",
        reasoningMode: "standard",
    },
};

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = [
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
] as const;
export const GEMINI_MID_MODELS = ["gemini-3-flash-preview"] as const;
export const OPENAI_MID_MODELS = [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite-preview"] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.4-nano"] as const;

export const DEFAULT_MAIN_MODEL = "gpt-6-astra";
export const DEFAULT_TITLE_MODEL = "gpt-5.4-nano";
export const DEFAULT_TABULAR_MODEL = "gpt-5.4-mini";

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
]);

const TABULAR_MODELS = new Set<string>([
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    throw new Error(`Unknown model id: ${model}`);
}

export function resolveModel(
    id: string | null | undefined,
    fallback: string,
): string {
    if (id && ALL_MODELS.has(id)) return id;
    return fallback;
}

export function isKnownModelId(id: unknown): id is string {
    return typeof id === "string" && ALL_MODELS.has(id);
}

export function isTabularModelId(id: unknown): id is string {
    return typeof id === "string" && TABULAR_MODELS.has(id);
}

export function resolveTabularModel(id: unknown): string {
    return isTabularModelId(id) ? id : DEFAULT_TABULAR_MODEL;
}

type MainModelRequest = {
    model?: string;
    reasoning_effort?: AssistantReasoningEffort;
    reasoning_mode?: ReasoningMode;
};

const NON_OPENAI_MAIN_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
]);

const LEGACY_NON_OPENAI_MAIN_MODEL_MAP: Record<string, string> = {
    // Mythos 5 is limited-access and is not available to Docket's Anthropic
    // account. Preserve stale browser selections by moving them to the
    // account-accessible Sonnet 5 model instead of falling back to OpenAI.
    "claude-mythos-5": "claude-sonnet-5",
};

function isNonOpenAiMainRequestModel(model: string): boolean {
    return (
        NON_OPENAI_MAIN_MODELS.has(model) ||
        hasOwn(LEGACY_NON_OPENAI_MAIN_MODEL_MAP, model)
    );
}

function isOpenAiMainModel(model: string): model is OpenAiMainModelId {
    return hasOwn(OPENAI_MAIN_MODEL_REGISTRY, model);
}

function isClaudeReasoningEffort(
    value: unknown,
): value is ClaudeReasoningEffort {
    return (
        typeof value === "string" &&
        (CLAUDE_REASONING_EFFORTS as readonly string[]).includes(value)
    );
}

export function resolveMainModelRequest(
    request: MainModelRequest,
): ResolvedMainModelRequest {
    const requestedModel = request.model ?? null;

    if (supportsClaudeReasoningEffort(request.model)) {
        return {
            requestedModel,
            selectionModel: request.model,
            providerModel: request.model,
            provider: "claude",
            reasoningEffort: isClaudeReasoningEffort(request.reasoning_effort)
                ? request.reasoning_effort
                : defaultClaudeReasoningEffort(request.model),
            status: "direct",
        };
    }

    if (request.model && NON_OPENAI_MAIN_MODELS.has(request.model)) {
        return {
            requestedModel,
            selectionModel: request.model,
            providerModel: request.model,
            provider: providerForModel(request.model),
            status: "direct",
        };
    }

    if (
        request.model &&
        hasOwn(LEGACY_NON_OPENAI_MAIN_MODEL_MAP, request.model)
    ) {
        const mappedModel = LEGACY_NON_OPENAI_MAIN_MODEL_MAP[request.model];
        return {
            requestedModel,
            selectionModel: mappedModel,
            providerModel: mappedModel,
            provider: providerForModel(mappedModel),
            status: "legacy_mapped",
        };
    }

    let selectionModel: OpenAiMainModelId;
    let defaultEffort: Gpt56ReasoningEffort;
    let defaultMode: ReasoningMode;
    let status: MainModelResolutionStatus;

    if (request.model === undefined) {
        selectionModel = DEFAULT_MAIN_MODEL;
        defaultEffort =
            OPENAI_MAIN_MODEL_REGISTRY[selectionModel].defaultReasoningEffort;
        defaultMode = "standard";
        status = "defaulted";
    } else if (isOpenAiMainModel(request.model)) {
        selectionModel = request.model;
        defaultEffort =
            OPENAI_MAIN_MODEL_REGISTRY[selectionModel].defaultReasoningEffort;
        defaultMode = "standard";
        status = "direct";
    } else if (hasOwn(LEGACY_MAIN_MODEL_MAP, request.model)) {
        const legacy = LEGACY_MAIN_MODEL_MAP[request.model];
        selectionModel = legacy.selectionModel;
        defaultEffort = legacy.reasoningEffort;
        defaultMode = legacy.reasoningMode;
        status = "legacy_mapped";
    } else {
        selectionModel = DEFAULT_MAIN_MODEL;
        defaultEffort =
            OPENAI_MAIN_MODEL_REGISTRY[selectionModel].defaultReasoningEffort;
        defaultMode = "standard";
        status = "unknown_fallback";
    }

    const reasoningMode = request.reasoning_mode ?? defaultMode;
    let reasoningEffort = request.reasoning_effort ?? defaultEffort;
    if (selectionModel === "gpt-6-astra" && reasoningEffort === "none") {
        reasoningEffort = "low";
    }
    if (
        reasoningMode === "pro" &&
        (reasoningEffort === "none" || reasoningEffort === "low")
    ) {
        reasoningEffort = "medium";
    }

    const config = OPENAI_MAIN_MODEL_REGISTRY[selectionModel];
    return {
        requestedModel,
        selectionModel: config.selectionModel,
        providerModel: config.providerModel,
        provider: "openai",
        reasoningEffort,
        reasoningMode,
        status,
    };
}

function parseFailure(detail: string): MainModelRequestParseResult {
    return { ok: false, detail };
}

function hasOwn(record: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

export function parseMainModelRequest(
    body: unknown,
): MainModelRequestParseResult {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return parseFailure("request body must be an object");
    }

    const raw = body as Record<string, unknown>;
    let model: string | undefined;
    if (hasOwn(raw, "model")) {
        if (typeof raw.model !== "string" || raw.model.trim() === "") {
            return parseFailure("model must be a non-empty string");
        }
        model = raw.model.trim();
    }

    if (model && isNonOpenAiMainRequestModel(model)) {
        if (supportsClaudeReasoningEffort(model)) {
            let reasoningEffort: ClaudeReasoningEffort = defaultClaudeReasoningEffort(model);
            if (hasOwn(raw, "reasoning_effort")) {
                if (!isClaudeReasoningEffort(raw.reasoning_effort)) {
                    return parseFailure(
                        `reasoning_effort must be one of: ${CLAUDE_REASONING_EFFORTS.join(", ")}`,
                    );
                }
                reasoningEffort = raw.reasoning_effort;
            }
            return {
                ok: true,
                value: resolveMainModelRequest({
                    model,
                    reasoning_effort: reasoningEffort,
                }),
            };
        }
        return { ok: true, value: resolveMainModelRequest({ model }) };
    }

    let reasoningEffort: AssistantReasoningEffort | undefined;
    const supportedEfforts = model && isOpenAiMainModel(model)
        ? OPENAI_MAIN_MODEL_REGISTRY[model].supportedReasoningEfforts
        : GPT_5_6_REASONING_EFFORTS;
    if (hasOwn(raw, "reasoning_effort")) {
        if (
            typeof raw.reasoning_effort !== "string" ||
            !(supportedEfforts as readonly string[]).includes(
                raw.reasoning_effort,
            )
        ) {
            return parseFailure(
                `reasoning_effort must be one of: ${supportedEfforts.join(", ")}`,
            );
        }
        reasoningEffort = raw.reasoning_effort as AssistantReasoningEffort;
    }

    let reasoningMode: ReasoningMode | undefined;
    if (hasOwn(raw, "reasoning_mode")) {
        if (
            typeof raw.reasoning_mode !== "string" ||
            (raw.reasoning_mode !== "standard" &&
                raw.reasoning_mode !== "pro")
        ) {
            return parseFailure("reasoning_mode must be one of: standard, pro");
        }
        reasoningMode = raw.reasoning_mode;
    }

    return {
        ok: true,
        value: resolveMainModelRequest({
            model,
            reasoning_effort: reasoningEffort,
            reasoning_mode: reasoningMode,
        }),
    };
}
