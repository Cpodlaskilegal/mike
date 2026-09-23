"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
    getUserInstructions,
    updateFirmInstructions,
    updatePersonalInstructions,
} from "@/app/lib/docketApi";

const MAX_INSTRUCTIONS_LENGTH = 5000;

type InstructionEditorProps = {
    id: string;
    label: string;
    description: string;
    draft: string;
    saved: string;
    onChange: (value: string) => void;
    onSave: (value: string) => Promise<void>;
};

function InstructionEditor({
    id,
    label,
    description,
    draft,
    saved,
    onChange,
    onSave,
}: InstructionEditorProps) {
    const [busy, setBusy] = useState<"save" | "clear" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const hasChanges = draft !== saved;

    const persist = async (value: string, action: "save" | "clear") => {
        setBusy(action);
        setError(null);
        setNotice(null);
        try {
            await onSave(value);
            setNotice(action === "clear" ? "Instructions cleared." : "Instructions saved.");
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : "Could not save instructions. Please try again.",
            );
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="space-y-3">
            <div>
                <label htmlFor={id} className="block text-sm font-medium text-gray-800">
                    {label}
                </label>
                <p id={`${id}-description`} className="mt-1 text-sm text-gray-500">
                    {description}
                </p>
            </div>
            <textarea
                id={id}
                aria-describedby={`${id}-description ${id}-count`}
                value={draft}
                onChange={(event) => {
                    onChange(event.target.value);
                    setError(null);
                    setNotice(null);
                }}
                disabled={busy !== null}
                maxLength={MAX_INSTRUCTIONS_LENGTH}
                rows={8}
                placeholder="Add instructions for how Docket should respond."
                className="block w-full resize-y rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200 disabled:cursor-wait disabled:bg-gray-50"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
                <span id={`${id}-count`} className="text-xs text-gray-500">
                    {draft.length.toLocaleString()} / {MAX_INSTRUCTIONS_LENGTH.toLocaleString()} characters
                </span>
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={busy !== null || (!draft && !saved)}
                        onClick={() => void persist("", "clear")}
                    >
                        {busy === "clear" ? "Clearing..." : "Clear"}
                    </Button>
                    <Button
                        type="button"
                        disabled={busy !== null || !hasChanges}
                        onClick={() => void persist(draft, "save")}
                        className="bg-black text-white hover:bg-gray-900"
                    >
                        {busy === "save" ? "Saving..." : "Save changes"}
                    </Button>
                </div>
            </div>
            {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        </div>
    );
}

export default function InstructionsPage() {
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [personalDraft, setPersonalDraft] = useState("");
    const [personalSaved, setPersonalSaved] = useState("");
    const [firmDraft, setFirmDraft] = useState("");
    const [firmSaved, setFirmSaved] = useState("");
    const [canEditFirm, setCanEditFirm] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const instructions = await getUserInstructions();
            setPersonalDraft(instructions.personalInstructions ?? "");
            setPersonalSaved(instructions.personalInstructions ?? "");
            setFirmDraft(instructions.firmInstructions ?? "");
            setFirmSaved(instructions.firmInstructions ?? "");
            setCanEditFirm(instructions.canEditFirmInstructions);
        } catch (cause) {
            setLoadError(
                cause instanceof Error
                    ? cause.message
                    : "Could not load instructions. Please try again.",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const savePersonal = async (value: string) => {
        const { personalInstructions } = await updatePersonalInstructions(value);
        setPersonalDraft(personalInstructions);
        setPersonalSaved(personalInstructions);
    };

    const saveFirm = async (value: string) => {
        const { firmInstructions } = await updateFirmInstructions(value);
        setFirmDraft(firmInstructions);
        setFirmSaved(firmInstructions);
    };

    return (
        <div className="space-y-10">
            <div>
                <h2 className="text-2xl font-medium font-serif">Custom Instructions</h2>
                <p className="mt-2 max-w-2xl text-sm text-gray-500">
                    These instructions guide replies in Assistant, Project Assistant,
                    and Tabular Review chats. Firm-wide instructions apply to everyone
                    and take priority over personal preferences.
                </p>
            </div>

            {loading ? (
                <p role="status" className="text-sm text-gray-500">Loading instructions...</p>
            ) : loadError ? (
                <div className="space-y-3">
                    <p role="alert" className="text-sm text-red-600">{loadError}</p>
                    <Button type="button" variant="outline" onClick={() => void load()}>
                        Retry
                    </Button>
                </div>
            ) : (
                <>
                    <section aria-labelledby="personal-instructions-heading" className="space-y-4">
                        <h3 id="personal-instructions-heading" className="text-xl font-medium font-serif">
                            Personal instructions
                        </h3>
                        <InstructionEditor
                            id="personal-instructions"
                            label="Your instructions"
                            description="Only you can edit these. They guide your future replies in Assistant, Project Assistant, and Tabular Review chats."
                            draft={personalDraft}
                            saved={personalSaved}
                            onChange={setPersonalDraft}
                            onSave={savePersonal}
                        />
                    </section>

                    <section aria-labelledby="firm-instructions-heading" className="space-y-4 border-t border-gray-100 pt-8">
                        <h3 id="firm-instructions-heading" className="text-xl font-medium font-serif">
                            Firm-wide instructions
                        </h3>
                        {canEditFirm ? (
                            <InstructionEditor
                                id="firm-instructions"
                                label="Instructions for everyone"
                                description="Only administrators can edit these. Changes guide everyone&apos;s future replies in Assistant, Project Assistant, and Tabular Review chats."
                                draft={firmDraft}
                                saved={firmSaved}
                                onChange={setFirmDraft}
                                onSave={saveFirm}
                            />
                        ) : (
                            <div>
                                <p className="mb-3 text-sm text-gray-500">
                                    An administrator manages these instructions.
                                </p>
                                <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-800 whitespace-pre-wrap break-words">
                                    {firmSaved || "No firm-wide instructions have been set."}
                                </div>
                            </div>
                        )}
                    </section>
                </>
            )}
        </div>
    );
}
