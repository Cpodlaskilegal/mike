"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { getProjectInstructions, getProjectPeople, saveProjectInstructions, type ProjectInstructions } from "@/app/lib/docketApi";

export function ProjectInstructionsModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
    const [state, setState] = useState<ProjectInstructions | null>(null);
    const [draft, setDraft] = useState("");
    const [owner, setOwner] = useState("the project owner");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [instructions, people] = await Promise.all([getProjectInstructions(projectId), getProjectPeople(projectId)]);
            setState(instructions);
            setDraft(instructions.instructions);
            setOwner(people.owner.display_name || people.owner.email || "the project owner");
        } catch {
            setError("Project instructions could not load. Try again.");
        } finally { setLoading(false); }
    }, [projectId]);
    useEffect(() => { void load(); }, [load]);

    async function save() {
        if (!state?.can_edit || saving) return;
        setSaving(true);
        setError(null);
        try {
            const next = await saveProjectInstructions(projectId, draft, state.version);
            const history = await getProjectInstructions(projectId);
            setState(history);
            setDraft(next.instructions);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : "Instructions could not be saved. Reload before retrying.");
        } finally { setSaving(false); }
    }

    return createPortal(
        <div className="fixed inset-0 z-100 flex items-center justify-center bg-black/40 p-4" onClick={saving ? undefined : onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby="project-instructions-title"
                className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl" onClick={(event) => event.stopPropagation()}>
                <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
                    <h2 id="project-instructions-title" className="text-lg font-medium">Project instructions</h2>
                    <button onClick={onClose} disabled={saving} aria-label="Close project instructions" className="p-1 text-gray-500"><X className="h-5 w-5" /></button>
                </div>
                <div className="overflow-y-auto px-6 py-4 space-y-4">
                    <p className="text-sm text-gray-600">Only {owner} may edit. Current project members can read these instructions and their history; removing a member removes that access. Administrators retain existing project read access.</p>
                    <p className="text-xs text-gray-500">Order of priority: Docket rules → firm instructions → project instructions → personal preferences. The current request and workflow may refine the task within those rules. Instructions never grant data access or authorize external actions.</p>
                    {error && <div role="alert" className="text-sm text-red-700">{error} <button onClick={() => void load()} disabled={saving} className="underline">Reload</button></div>}
                    {loading ? <Loader2 className="h-5 w-5 animate-spin text-gray-500" /> : state && <>
                        <label htmlFor="project-instructions" className="block text-sm font-medium">Standing instructions · Version {state.version}</label>
                        <textarea id="project-instructions" value={draft} onChange={(event) => setDraft(event.target.value)}
                            readOnly={!state.can_edit} disabled={saving} maxLength={5000} rows={8}
                            placeholder="For example: Use the same case-summary sections in every project chat."
                            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm read-only:bg-gray-50" />
                        <div className="flex items-center justify-between text-xs text-gray-500">
                            <span>{draft.length}/5000 · {state.can_edit ? "You can edit" : "Read only"}</span>
                            {state.can_edit && <button onClick={() => void save()} disabled={saving || draft.trim() === state.instructions}
                                className="rounded-md bg-gray-900 px-3 py-2 text-white disabled:opacity-40">{saving ? "Saving…" : "Save instructions"}</button>}
                        </div>
                        <div className="border-t border-gray-100 pt-3">
                            <h3 className="text-sm font-medium">History · latest 50 changes</h3>
                            {!state.history?.length && <p className="mt-2 text-xs text-gray-500">No saved changes yet.</p>}
                            {state.history?.map((entry) => <details key={entry.version} className="mt-3 text-xs text-gray-600">
                                <summary className="cursor-pointer">V{entry.version} · {entry.editor_email} · {new Date(entry.created_at).toLocaleString()}</summary>
                                <p className="mt-2 whitespace-pre-wrap rounded bg-gray-50 p-3">{entry.instructions || "Instructions cleared"}</p>
                            </details>)}
                        </div>
                    </>}
                </div>
            </div>
        </div>, document.body,
    );
}
