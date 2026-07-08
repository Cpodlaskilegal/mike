"use client";

import { useEffect, useMemo, useState } from "react";
import { MessageSquare, Table2 } from "lucide-react";
import { createWorkflow, updateWorkflow } from "@/app/lib/docketApi";
import type { DocketWorkflow } from "../shared/types";
import { Modal } from "../modals/Modal";
import { ModalFieldLabel } from "../modals/ModalFieldLabel";
import { ModalSegmentedToggle } from "../modals/ModalSegmentedToggle";
import { ModalSelect } from "../modals/ModalSelect";
import { ModalTextInput } from "../modals/ModalTextInput";
import { PRACTICE_OPTIONS } from "./practices";

const DEFAULT_LANGUAGE = "English";
const DEFAULT_PRACTICE = "General Transactions";
const DEFAULT_JURISDICTION = "General";

const LANGUAGE_OPTIONS = [
    "English",
    "Spanish",
    "French",
    "German",
    "Chinese",
    "Japanese",
    "Korean",
    "Portuguese",
    "Other",
] as const;

const JURISDICTION_OPTIONS = [
    "General",
    "United States",
    "Indiana",
    "Illinois",
    "Michigan",
    "Ohio",
    "Federal",
    "England and Wales",
    "European Union",
    "Canada",
    "Other",
] as const;

interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (workflow: DocketWorkflow) => void;
    editWorkflow?: DocketWorkflow;
    onUpdated?: (workflow: DocketWorkflow) => void;
}

function isKnown(options: readonly string[], value: string) {
    return options.includes(value);
}

function splitJurisdictions(value: string) {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

export function NewWorkflowModal({
    open,
    onClose,
    onCreated,
    editWorkflow,
    onUpdated,
}: Props) {
    const [title, setTitle] = useState("");
    const [type, setType] = useState<"assistant" | "tabular">("assistant");
    const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
    const [customLanguage, setCustomLanguage] = useState("");
    const [practice, setPractice] = useState(DEFAULT_PRACTICE);
    const [customPractice, setCustomPractice] = useState("");
    const [jurisdiction, setJurisdiction] = useState(DEFAULT_JURISDICTION);
    const [customJurisdiction, setCustomJurisdiction] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const isEditing = !!editWorkflow;
    const effectiveLanguage =
        language === "Other" ? customLanguage.trim() : language;
    const effectivePractice =
        practice === "Others" ? customPractice.trim() : practice;
    const jurisdictionText =
        jurisdiction === "Other" ? customJurisdiction.trim() : jurisdiction;
    const effectiveJurisdictions = useMemo(
        () => splitJurisdictions(jurisdictionText || DEFAULT_JURISDICTION),
        [jurisdictionText],
    );

    useEffect(() => {
        if (!open) return;
        if (editWorkflow) {
            setTitle(editWorkflow.title);
            setType(editWorkflow.type);

            const savedLanguage = editWorkflow.language || DEFAULT_LANGUAGE;
            if (isKnown(LANGUAGE_OPTIONS, savedLanguage)) {
                setLanguage(savedLanguage);
                setCustomLanguage("");
            } else {
                setLanguage("Other");
                setCustomLanguage(savedLanguage);
            }

            const savedPractice = editWorkflow.practice || DEFAULT_PRACTICE;
            if (isKnown(PRACTICE_OPTIONS, savedPractice)) {
                setPractice(savedPractice);
                setCustomPractice("");
            } else {
                setPractice("Others");
                setCustomPractice(savedPractice);
            }

            const savedJurisdiction =
                editWorkflow.jurisdictions?.join(", ") || DEFAULT_JURISDICTION;
            if (isKnown(JURISDICTION_OPTIONS, savedJurisdiction)) {
                setJurisdiction(savedJurisdiction);
                setCustomJurisdiction("");
            } else {
                setJurisdiction("Other");
                setCustomJurisdiction(savedJurisdiction);
            }
        } else {
            resetForm();
        }
        setError("");
    }, [open, editWorkflow]);

    function resetForm() {
        setTitle("");
        setType("assistant");
        setLanguage(DEFAULT_LANGUAGE);
        setCustomLanguage("");
        setPractice(DEFAULT_PRACTICE);
        setCustomPractice("");
        setJurisdiction(DEFAULT_JURISDICTION);
        setCustomJurisdiction("");
        setError("");
    }

    function handleClose() {
        resetForm();
        onClose();
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!title.trim() || loading) return;
        setLoading(true);
        setError("");
        try {
            const payload = {
                title: title.trim(),
                language: effectiveLanguage || DEFAULT_LANGUAGE,
                practice: effectivePractice || DEFAULT_PRACTICE,
                jurisdictions: effectiveJurisdictions.length
                    ? effectiveJurisdictions
                    : [DEFAULT_JURISDICTION],
            };
            if (isEditing && editWorkflow) {
                const updated = await updateWorkflow(editWorkflow.id, payload);
                onUpdated?.(updated);
            } else {
                const workflow = await createWorkflow({ ...payload, type });
                onCreated(workflow);
            }
            resetForm();
            onClose();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : `Failed to ${isEditing ? "update" : "create"} workflow`,
            );
        } finally {
            setLoading(false);
        }
    }

    return (
        <Modal
            open={open}
            title={isEditing ? "Edit workflow" : "New workflow"}
            eyebrow="Workflows"
            onClose={handleClose}
            footer={
                <div className="flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={handleClose}
                        className="rounded-lg px-4 py-2 text-sm text-gray-500 transition-colors hover:bg-gray-100"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        form="workflow-modal-form"
                        disabled={!title.trim() || loading}
                        className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:opacity-40"
                    >
                        {loading
                            ? isEditing
                                ? "Saving..."
                                : "Creating..."
                            : isEditing
                              ? "Save changes"
                              : "Create workflow"}
                    </button>
                </div>
            }
        >
            <form
                id="workflow-modal-form"
                onSubmit={handleSubmit}
                className="space-y-5"
            >
                <div>
                    <ModalTextInput
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder="Workflow name"
                        autoFocus
                        className="border-0 px-0 py-0 text-2xl font-serif placeholder-gray-300 focus:border-0"
                    />
                </div>

                {!isEditing && (
                    <div>
                        <ModalFieldLabel>Type</ModalFieldLabel>
                        <ModalSegmentedToggle
                            value={type}
                            onChange={setType}
                            options={[
                                {
                                    value: "assistant",
                                    label: "Assistant",
                                    icon: <MessageSquare className="h-3 w-3" />,
                                },
                                {
                                    value: "tabular",
                                    label: "Tabular",
                                    icon: <Table2 className="h-3 w-3" />,
                                },
                            ]}
                        />
                    </div>
                )}

                <div className="grid gap-4 md:grid-cols-3">
                    <div>
                        <ModalFieldLabel>Language</ModalFieldLabel>
                        <ModalSelect
                            value={language}
                            options={LANGUAGE_OPTIONS}
                            onChange={setLanguage}
                        />
                        {language === "Other" && (
                            <ModalTextInput
                                value={customLanguage}
                                onChange={(event) =>
                                    setCustomLanguage(event.target.value)
                                }
                                placeholder="Language"
                                className="mt-2"
                            />
                        )}
                    </div>

                    <div>
                        <ModalFieldLabel>Practice</ModalFieldLabel>
                        <ModalSelect
                            value={practice}
                            options={PRACTICE_OPTIONS}
                            onChange={setPractice}
                        />
                        {practice === "Others" && (
                            <ModalTextInput
                                value={customPractice}
                                onChange={(event) =>
                                    setCustomPractice(event.target.value)
                                }
                                placeholder="Practice area"
                                className="mt-2"
                            />
                        )}
                    </div>

                    <div>
                        <ModalFieldLabel>Jurisdiction</ModalFieldLabel>
                        <ModalSelect
                            value={jurisdiction}
                            options={JURISDICTION_OPTIONS}
                            onChange={setJurisdiction}
                        />
                        {jurisdiction === "Other" && (
                            <ModalTextInput
                                value={customJurisdiction}
                                onChange={(event) =>
                                    setCustomJurisdiction(event.target.value)
                                }
                                placeholder="Comma-separated jurisdictions"
                                className="mt-2"
                            />
                        )}
                    </div>
                </div>

                {error && <p className="text-sm text-red-500">{error}</p>}
            </form>
        </Modal>
    );
}
