"use client";

import { useState } from "react";
import { ChevronDown, Check, AlertCircle } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    isModelAvailable,
    type ProviderAvailability,
} from "@/app/lib/modelAvailability";

export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI";
}

export const MODELS: ModelOption[] = [
    { id: "gpt-5.5-pro", label: "GPT-5.5 Pro", group: "OpenAI" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
    { id: "gpt-5.4", label: "GPT-5.4", group: "OpenAI" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", group: "OpenAI" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
];

export const TABULAR_MODELS: ModelOption[] = [
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", group: "OpenAI" },
    { id: "gpt-5.4-nano", label: "GPT-5.4 Nano", group: "OpenAI" },
    { id: "gpt-5.4", label: "GPT-5.4", group: "OpenAI" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    {
        id: "gemini-3.1-flash-lite-preview",
        label: "Gemini 3.1 Flash Lite",
        group: "Google",
    },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
];

export const DEFAULT_MODEL_ID = "gemini-3-flash-preview";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

const GROUP_ORDER: ModelOption["group"][] = ["OpenAI", "Anthropic", "Google"];

interface Props {
    value: string;
    onChange: (id: string) => void | Promise<boolean>;
    apiKeys?: ProviderAvailability;
    models?: ModelOption[];
}

export function ModelToggle({ value, onChange, apiKeys, models = MODELS }: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const selected = models.find((m) => m.id === value);
    const selectedLabel = selected?.label ?? "Model";
    const openaiEnabled = apiKeys?.openaiEnabled === true;
    const visibleModels = models.filter(
        (m) => openaiEnabled || m.group !== "OpenAI",
    );
    const selectedAvailable = apiKeys
        ? isModelAvailable(value, apiKeys)
        : true;

    async function handleSelect(id: string) {
        if (pendingId || id === value) return;
        setError(false);
        setPendingId(id);
        try {
            const result = await onChange(id);
            if (result === false) setError(true);
        } catch (err) {
            console.error("[model-toggle] failed to change model", err);
            setError(true);
        } finally {
            setPendingId(null);
        }
    }

    return (
        <DropdownMenu onOpenChange={(open) => {
            setIsOpen(open);
            if (open) setError(false);
        }}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    disabled={!!pendingId}
                    className={`flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors cursor-pointer text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-wait disabled:opacity-70 ${isOpen ? "bg-gray-100 text-gray-700" : ""}`}
                    title={
                        error
                            ? "Could not save model preference"
                            : !selectedAvailable
                            ? "API key missing for selected model"
                            : "Choose model"
                    }
                >
                    {(error || !selectedAvailable) && (
                        <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
                    )}
                    <span className="max-w-[140px] truncate">
                        {pendingId ? "Saving..." : selectedLabel}
                    </span>
                    <ChevronDown
                        className={`h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56 z-50" side="top" align="start">
                {GROUP_ORDER.filter((group) =>
                    visibleModels.some((m) => m.group === group),
                ).map((group, gi) => {
                    const items = visibleModels.filter((m) => m.group === group);
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const available = apiKeys
                                    ? isModelAvailable(m.id, apiKeys)
                                    : true;
                                return (
                                    <DropdownMenuItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        disabled={!!pendingId}
                                        onSelect={() => void handleSelect(m.id)}
                                    >
                                        <span
                                            className={`flex-1 ${available ? "" : "text-gray-400"}`}
                                        >
                                            {m.label}
                                        </span>
                                        {pendingId === m.id && (
                                            <span className="ml-1 text-xs text-gray-500">
                                                Saving
                                            </span>
                                        )}
                                        {!available && (
                                            <AlertCircle
                                                className="h-3.5 w-3.5 text-red-500 ml-1"
                                                aria-label="API key missing"
                                            />
                                        )}
                                        {m.id === value && (
                                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                                        )}
                                    </DropdownMenuItem>
                                );
                            })}
                        </div>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
