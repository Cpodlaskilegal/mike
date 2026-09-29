import { NATIVE_MODEL_MEDIA_MIME_TYPES } from "./documentTypes";
import { nativeMediaSupport } from "./nativeMedia";
import { parseMainModelRequest, type ResolvedMainModelRequest } from "./llm/models";
import type { UserApiKeys } from "./llm/types";

export const ASSISTANT_MODEL_POLICY_VERSION = "docket-auto-2026-09-29-v1";
export const ASSISTANT_TASKS = ["drafting", "research", "summary"] as const;
export type AssistantTask = (typeof ASSISTANT_TASKS)[number];
export type AssistantBudgetPolicy = "economy" | "balanced" | "quality";
export type AssistantModelSelection = {
  mode: "auto" | "manual";
  model: string;
  reason: string;
  policyVersion: string;
  task: AssistantTask;
  budgetPolicy: AssistantBudgetPolicy;
};

export function assistantModelSelectionFromRow(row: Record<string, unknown>): AssistantModelSelection | undefined {
  if ((row.model_selection_mode !== "auto" && row.model_selection_mode !== "manual") ||
    typeof row.model !== "string" || typeof row.model_selection_reason !== "string" ||
    typeof row.model_policy_version !== "string" ||
    !(ASSISTANT_TASKS as readonly unknown[]).includes(row.model_task) ||
    (row.model_budget_policy !== "economy" && row.model_budget_policy !== "balanced" && row.model_budget_policy !== "quality")) return undefined;
  return { mode: row.model_selection_mode, model: row.model, reason: row.model_selection_reason,
    policyVersion: row.model_policy_version, task: row.model_task as AssistantTask, budgetPolicy: row.model_budget_policy };
}

/** Safe original per-run intent, attached to the user message for recovery. */
export function assistantGenerationForRecovery(request: ResolvedMainModelRequest, selection: AssistantModelSelection) {
  return selection.mode === "auto" ? { model: "auto", task: selection.task } : {
    model: request.requestedModel ?? request.providerModel,
    task: selection.task,
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.reasoningMode ? { reasoning_mode: request.reasoningMode } : {}),
  };
}

/** A relative model/effort budget, not a promise of a dollar spending cap. */
export function assistantBudgetPolicy(raw = process.env.DOCKET_AUTO_BUDGET_POLICY): AssistantBudgetPolicy {
  if (raw === undefined || raw === "" || raw === "balanced") return "balanced";
  if (raw === "economy" || raw === "quality") return raw;
  throw new Error("DOCKET_AUTO_BUDGET_POLICY must be economy, balanced, or quality");
}

export function workflowAssistantTask(title: string): AssistantTask {
  if (/\b(research|case law|citator|authorit(?:y|ies))\b/i.test(title)) return "research";
  if (/\b(draft|drafting|motion|pleading|contract|agreement|brief|letter)\b/i.test(title)) return "drafting";
  return "summary";
}

const MODEL_ORDER: Record<AssistantBudgetPolicy, Record<AssistantTask, readonly string[]>> = {
  economy: {
    drafting: ["gpt-6-luna", "claude-haiku-4-5", "gemini-3-flash-preview"],
    research: ["gpt-6-luna", "claude-haiku-4-5", "gemini-3-flash-preview"],
    summary: ["gpt-6-luna", "claude-haiku-4-5", "gemini-3-flash-preview"],
  },
  balanced: {
    drafting: ["gpt-6-sol", "claude-sonnet-5", "gemini-3.1-pro-preview"],
    research: ["gpt-6-sol", "claude-sonnet-5", "gemini-3.1-pro-preview"],
    summary: ["gpt-6-luna", "claude-haiku-4-5", "gemini-3-flash-preview"],
  },
  quality: {
    drafting: ["gpt-6-astra", "claude-opus-5-5", "gemini-3.1-pro-preview"],
    research: ["gpt-6-astra", "claude-opus-5-5", "gemini-3.1-pro-preview"],
    summary: ["gpt-6-sol", "claude-sonnet-5", "gemini-3.1-pro-preview"],
  },
};

/** Validate manual syntax before any database, key or provider lookup. */
export function validateAssistantModelIntent(body: Record<string, unknown>): { ok: true } | { ok: false; detail: string } {
  if (body.task !== undefined && !(ASSISTANT_TASKS as readonly unknown[]).includes(body.task)) return { ok: false, detail: "task must be drafting, research, or summary" };
  if (body.model === undefined || body.model === "auto") {
    return body.reasoning_effort !== undefined || body.reasoning_mode !== undefined
      ? { ok: false, detail: "Auto sets its own reasoning effort and mode. Choose a manual model to override them." }
      : { ok: true };
  }
  const parsed = parseMainModelRequest(body);
  if (!parsed.ok) return parsed;
  return parsed.value.status === "unknown_fallback"
    ? { ok: false, detail: "Unknown model. Choose Auto or a listed model; Docket will not substitute a manual selection." }
    : { ok: true };
}

export function resolveAssistantModelSelection(input: {
  body: Record<string, unknown>;
  apiKeys: UserApiKeys;
  fileTypes: readonly string[];
  workflowTitle?: string;
  budgetPolicy?: AssistantBudgetPolicy;
}): { ok: true; request: ResolvedMainModelRequest; selection: AssistantModelSelection } |
  { ok: false; detail: string } {
  const { body, apiKeys } = input;
  const intent = validateAssistantModelIntent(body);
  if (!intent.ok) return intent;
  const budgetPolicy = input.budgetPolicy ?? assistantBudgetPolicy();
  if (body.task !== undefined && !(ASSISTANT_TASKS as readonly unknown[]).includes(body.task)) {
    return { ok: false, detail: "task must be drafting, research, or summary" };
  }
  const task = (body.task as AssistantTask | undefined) ?? workflowAssistantTask(input.workflowTitle ?? "");
  const media = [...new Set(input.fileTypes.map((type) => NATIVE_MODEL_MEDIA_MIME_TYPES[type.toLowerCase()]).filter(Boolean))];
  const supportsMedia = (model: string) => media.every((mime) => nativeMediaSupport(model, mime));
  const isAuto = body.model === undefined || body.model === "auto";
  if (!isAuto) {
    const parsed = parseMainModelRequest(body);
    if (!parsed.ok) return parsed;
    if (parsed.value.status === "unknown_fallback") {
      return { ok: false, detail: "Unknown model. Choose Auto or a listed model; Docket will not substitute a manual selection." };
    }
    if (!apiKeys[parsed.value.provider]?.trim()) {
      return { ok: false, detail: "The selected model's provider is unavailable. Configure its API key or choose Auto." };
    }
    if (!supportsMedia(parsed.value.providerModel)) {
      return { ok: false, detail: "The selected model cannot analyze these audio or video attachments. Choose Auto or Gemini." };
    }
    return { ok: true, request: parsed.value, selection: {
      mode: "manual", model: parsed.value.providerModel,
      reason: parsed.value.status === "legacy_mapped"
        ? `Manual selection mapped from ${parsed.value.requestedModel} to its supported replacement.`
        : "Manual override for this response; Auto budget preferences do not change an explicit selection.",
      policyVersion: ASSISTANT_MODEL_POLICY_VERSION, task, budgetPolicy,
    } };
  }
  if (body.reasoning_effort !== undefined || body.reasoning_mode !== undefined) {
    return { ok: false, detail: "Auto sets its own reasoning effort and mode. Choose a manual model to override them." };
  }
  const effort = task === "summary" || budgetPolicy === "economy" ? "medium" : "high";
  for (const model of MODEL_ORDER[budgetPolicy][task]) {
    const parsed = parseMainModelRequest({ model, reasoning_effort: effort, reasoning_mode: "standard" });
    if (!parsed.ok || !apiKeys[parsed.value.provider]?.trim() || !supportsMedia(model)) continue;
    const nativeMedia = media.some((mime) => mime.startsWith("audio/") || mime.startsWith("video/"));
    return { ok: true, request: { ...parsed.value, requestedModel: "auto" }, selection: {
      mode: "auto", model, policyVersion: ASSISTANT_MODEL_POLICY_VERSION, task, budgetPolicy,
      reason: `Auto: ${task}${body.task === undefined && input.workflowTitle ? " from selected workflow" : ""}; ${budgetPolicy} firm budget; ${nativeMedia ? "Gemini required for attached audio/video" : "first configured provider in policy order"}; ${effort} effort, Standard mode.`,
    } };
  }
  return { ok: false, detail: media.some((mime) => mime.startsWith("audio/") || mime.startsWith("video/"))
    ? "Auto needs a configured Gemini provider to analyze audio or video attachments. Configure Gemini or remove those attachments."
    : "Auto has no configured provider for this task. Configure a provider in Account → API Keys." };
}
