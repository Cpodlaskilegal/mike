"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { TABULAR_MODELS } from "@/app/components/assistant/ModelToggle";
import {
    isModelAvailable,
    modelGroupToProvider,
    type ProviderAvailability,
} from "@/app/lib/modelAvailability";

export default function ModelsAndApiKeysPage() {
    const { profile, updateModelPreference, updateApiKey } = useUserProfile();

    return (
        <div className="space-y-4">
            {/* Model Preferences */}
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-4">
                    <h2 className="text-2xl font-medium font-serif">
                        Model Preferences
                    </h2>
                </div>
                <div className="space-y-4 max-w-md">
                    <div>
                        <label className="text-sm text-gray-600 block mb-2">
                            Tabular review model
                        </label>
                        <TabularModelDropdown
                            value={
                                profile?.tabularModel ??
                                "gemini-3-flash-preview"
                            }
                            apiKeys={{
                                claudeApiKey: profile?.claudeApiKey ?? null,
                                geminiApiKey: profile?.geminiApiKey ?? null,
                                openaiEnabled: profile?.openaiEnabled ?? false,
                            }}
                            onChange={(id) =>
                                updateModelPreference("tabularModel", id)
                            }
                        />
                    </div>
                </div>
            </div>

            {/* API Keys */}
            <div className="py-6">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-2xl font-medium font-serif">
                        API Keys
                    </h2>
                </div>
                <p className="text-sm text-gray-500 mb-4 max-w-xl">
                    Add your own Claude or Gemini API keys here. OpenAI models
                    are managed by the Mike server and do not require a user API
                    key.
                </p>
                <p className="text-xs text-gray-400 mb-4 max-w-xl">
                    Title generation automatically routes to the cheapest model
                    of whichever provider is available.
                </p>
                <div className="space-y-4 max-w-xl">
                    <ApiKeyField
                        label="Anthropic (Claude) API Key"
                        placeholder="sk-ant-…"
                        initialValue={profile?.claudeApiKey ?? ""}
                        onSave={(value) =>
                            updateApiKey("claude", value.trim() || null)
                        }
                    />
                    <ApiKeyField
                        label="Google (Gemini) API Key"
                        placeholder="AI…"
                        initialValue={profile?.geminiApiKey ?? ""}
                        onSave={(value) =>
                            updateApiKey("gemini", value.trim() || null)
                        }
                    />
                </div>
            </div>
        </div>
    );
}

function TabularModelDropdown({
    value,
    onChange,
    apiKeys,
}: {
    value: string;
    onChange: (id: string) => Promise<boolean>;
    apiKeys: ProviderAvailability;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const selected = TABULAR_MODELS.find((m) => m.id === value);
    const selectedAvailable = isModelAvailable(value, apiKeys);
    const openaiEnabled = apiKeys.openaiEnabled;
    const visibleModels = TABULAR_MODELS.filter(
        (m) => openaiEnabled || m.group !== "OpenAI",
    );
    const groups: ("OpenAI" | "Anthropic" | "Google")[] = [
        "OpenAI",
        "Anthropic",
        "Google",
    ];

    const handleSelect = async (id: string) => {
        if (pendingId || id === value) return;
        setError(null);
        setSaved(false);
        setPendingId(id);
        try {
            const ok = await onChange(id);
            if (ok) {
                setSaved(true);
                window.setTimeout(() => setSaved(false), 2000);
                return;
            }
            setError("Couldn’t save model preference. Please sign in again or retry.");
        } catch (err) {
            console.error("[models] failed to save tabular model", err);
            setError("Couldn’t save model preference. Please sign in again or retry.");
        } finally {
            setPendingId(null);
        }
    };

    return (
        <div className="space-y-1.5">
            <DropdownMenu onOpenChange={setIsOpen}>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        disabled={!!pendingId}
                        className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm shadow-sm flex items-center justify-between gap-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-black/10 disabled:cursor-wait disabled:opacity-70"
                    >
                        <span className="flex items-center gap-2 min-w-0">
                            {!selectedAvailable && (
                                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                            )}
                            <span className="truncate text-gray-900">
                                {pendingId
                                    ? "Saving..."
                                    : selected?.label ?? "Select a model"}
                            </span>
                        </span>
                        <ChevronDown
                            className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                        />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    className="z-50"
                    style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                    align="start"
                >
                    {groups.filter((group) =>
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
                                    const provider = modelGroupToProvider(m.group);
                                    const available = isModelAvailable(
                                        m.id,
                                        apiKeys,
                                    );
                                    return (
                                        <DropdownMenuItem
                                            key={m.id}
                                            className="cursor-pointer"
                                            disabled={!!pendingId}
                                            onSelect={() => void handleSelect(m.id)}
                                            title={
                                                !available
                                                    ? provider === "openai"
                                                        ? "Ask an administrator to enable OpenAI for this deployment"
                                                        : `Add a ${provider === "claude" ? "Claude" : "Gemini"} API key to use this model`
                                                    : undefined
                                            }
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
                                                <AlertCircle className="h-3.5 w-3.5 text-red-500 ml-1" />
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
            {error && <p className="text-xs text-red-600">{error}</p>}
            {saved && !error && (
                <p className="text-xs text-green-700">Model preference saved.</p>
            )}
        </div>
    );
}

function ApiKeyField({
    label,
    placeholder,
    initialValue,
    onSave,
}: {
    label: string;
    placeholder: string;
    initialValue: string;
    onSave: (value: string) => Promise<boolean>;
}) {
    const [value, setValue] = useState(initialValue);
    const [reveal, setReveal] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        setValue(initialValue);
    }, [initialValue]);

    const dirty = value !== initialValue;

    const handleSave = async () => {
        setIsSaving(true);
        const ok = await onSave(value);
        setIsSaving(false);
        if (ok) {
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            alert(`Failed to save ${label}.`);
        }
    };

    return (
        <div>
            <label className="text-sm text-gray-600 block mb-2">{label}</label>
            <div className="flex gap-2">
                <div className="relative flex-1">
                    <Input
                        type={reveal ? "text" : "password"}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={placeholder}
                        className="pr-10"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <button
                        type="button"
                        onClick={() => setReveal((r) => !r)}
                        className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600"
                        aria-label={reveal ? "Hide key" : "Show key"}
                    >
                        {reveal ? (
                            <EyeOff className="h-4 w-4" />
                        ) : (
                            <Eye className="h-4 w-4" />
                        )}
                    </button>
                </div>
                <Button
                    onClick={handleSave}
                    disabled={isSaving || !dirty || saved}
                    className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
                >
                    {isSaving ? (
                        "Saving..."
                    ) : saved ? (
                        <>
                            <Check className="h-4 w-3" />
                            Saved
                        </>
                    ) : (
                        "Save"
                    )}
                </Button>
            </div>
        </div>
    );
}
