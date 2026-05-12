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
import type { ApiKeyState } from "@/app/lib/mikeApi";
import { TABULAR_MODELS } from "@/app/components/assistant/ModelToggle";
import {
    isModelAvailable,
    modelGroupToProvider,
    providerLabel,
} from "@/app/lib/modelAvailability";

const API_KEY_FIELDS = [
    {
        provider: "claude",
        label: "Anthropic (Claude) API Key",
        placeholder: "sk-ant-...",
    },
    {
        provider: "gemini",
        label: "Google (Gemini) API Key",
        placeholder: "AI...",
    },
    {
        provider: "openai",
        label: "OpenAI API Key",
        placeholder: "sk-...",
    },
] as const;

export default function ModelsAndApiKeysPage() {
    const { profile, updateModelPreference, updateApiKey } = useUserProfile();

    return (
        <div className="space-y-4">
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
                        <p className="text-xs text-gray-400 mb-2">
                            We recommend using a smaller model for tabular
                            reviews to reduce token costs.
                        </p>
                        <TabularModelDropdown
                            value={profile?.tabularModel ?? "gpt-5.4-mini"}
                            apiKeys={profile?.apiKeys}
                            onChange={(id) =>
                                updateModelPreference("tabularModel", id)
                            }
                        />
                    </div>
                </div>
            </div>

            <div className="py-6">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-2xl font-medium font-serif">
                        API Keys
                    </h2>
                </div>
                <p className="text-sm text-gray-500 mb-4 max-w-xl">
                    Add provider API keys here, or configure provider keys in
                    the backend environment for the whole deployment.
                </p>
                <p className="text-xs text-gray-400 mb-4 max-w-xl">
                    Title generation automatically routes to the cheapest
                    configured provider model.
                </p>
                <div className="space-y-4 max-w-xl">
                    {API_KEY_FIELDS.map((field) => (
                        <ApiKeyField
                            key={field.provider}
                            label={field.label}
                            placeholder={field.placeholder}
                            hasSavedKey={
                                !!profile?.apiKeys[field.provider].configured
                            }
                            isServerConfigured={
                                profile?.apiKeys[field.provider].source ===
                                "env"
                            }
                            onSave={(value) =>
                                updateApiKey(
                                    field.provider,
                                    value.trim() || null,
                                )
                            }
                            onRemove={() => updateApiKey(field.provider, null)}
                        />
                    ))}
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
    apiKeys?: ApiKeyState;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const selected = TABULAR_MODELS.find((m) => m.id === value);
    const selectedAvailable = apiKeys ? isModelAvailable(value, apiKeys) : true;
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
            setError("Could not save model preference. Please sign in again or retry.");
        } catch (err) {
            console.error("[models] failed to save tabular model", err);
            setError("Could not save model preference. Please sign in again or retry.");
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
                        TABULAR_MODELS.some((m) => m.group === group),
                    ).map((group, gi) => {
                        const items = TABULAR_MODELS.filter(
                            (m) => m.group === group,
                        );
                        return (
                            <div key={group}>
                                {gi > 0 && <DropdownMenuSeparator />}
                                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                    {group}
                                </DropdownMenuLabel>
                                {items.map((m) => {
                                    const provider = modelGroupToProvider(m.group);
                                    const available = apiKeys
                                        ? isModelAvailable(m.id, apiKeys)
                                        : true;
                                    return (
                                        <DropdownMenuItem
                                            key={m.id}
                                            className="cursor-pointer"
                                            disabled={!!pendingId}
                                            onSelect={() => void handleSelect(m.id)}
                                            title={
                                                !available
                                                    ? `Add a ${providerLabel(provider)} API key to use this model`
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
    hasSavedKey,
    isServerConfigured,
    onSave,
    onRemove,
}: {
    label: string;
    placeholder: string;
    hasSavedKey: boolean;
    isServerConfigured: boolean;
    onSave: (value: string) => Promise<boolean>;
    onRemove: () => Promise<boolean>;
}) {
    const [value, setValue] = useState("");
    const [reveal, setReveal] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        setValue("");
    }, [hasSavedKey]);

    const dirty = value.trim().length > 0;

    const handleSave = async () => {
        setIsSaving(true);
        const ok = await onSave(value);
        setIsSaving(false);
        if (ok) {
            setValue("");
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            alert(`Failed to save ${label}.`);
        }
    };

    const handleRemove = async () => {
        setIsSaving(true);
        const ok = await onRemove();
        setIsSaving(false);
        if (!ok) alert(`Failed to remove ${label}.`);
    };

    return (
        <div>
            <label className="text-sm text-gray-600 block mb-2">{label}</label>
            {isServerConfigured && (
                <div className="mb-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2">
                    <p className="text-xs text-blue-800">
                        A server .env key is configured for this provider.
                        Browser API-key edits are disabled.
                    </p>
                    {hasSavedKey && (
                        <p className="mt-1 text-xs text-blue-800">
                            The server key will be used for this provider.
                        </p>
                    )}
                </div>
            )}
            {hasSavedKey && !isServerConfigured && (
                <p className="text-xs text-gray-500 mb-2">
                    A key is saved. Paste a new key to replace it.
                </p>
            )}
            <div className="flex gap-2">
                <div className="relative flex-1">
                    <Input
                        type={reveal ? "text" : "password"}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={
                            isServerConfigured
                                ? "Server .env key configured"
                                : hasSavedKey
                                  ? "Saved key hidden"
                                  : placeholder
                        }
                        className="pr-10"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={isServerConfigured}
                    />
                    <button
                        type="button"
                        onClick={() => setReveal((r) => !r)}
                        disabled={isServerConfigured}
                        className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
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
                    disabled={isServerConfigured || isSaving || !dirty || saved}
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
                {hasSavedKey && !isServerConfigured && (
                    <Button
                        type="button"
                        variant="outline"
                        onClick={handleRemove}
                        disabled={isSaving}
                    >
                        Remove
                    </Button>
                )}
            </div>
        </div>
    );
}
