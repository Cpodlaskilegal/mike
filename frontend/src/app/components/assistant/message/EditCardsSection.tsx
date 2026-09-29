"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { readEditResolutionError } from "@/app/lib/editResolutionError";
import type { DocketEditAnnotation } from "../../shared/types";

type PendingEdit = {
    annotation: DocketEditAnnotation;
    filename: string;
};

type ResolveStart = (args: {
    editId: string;
    documentId: string;
    verb: "accept" | "reject";
}) => void;

type Resolved = (args: {
    editId: string;
    documentId: string;
    status: "accepted" | "rejected";
    versionId: string | null;
    downloadUrl: string | null;
}) => void;

type ResolveError = (args: {
    editId: string;
    documentId: string;
    versionId: string | null;
    message: string;
}) => void;

function BulkEditActions({
    pending,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: {
    pending: PendingEdit[];
    onViewClick?: (annotation: DocketEditAnnotation, filename: string) => void;
    onResolveStart?: ResolveStart;
    onResolved?: Resolved;
    onError?: ResolveError;
}) {
    const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
    const [resolutionError, setResolutionError] = useState<string | null>(null);
    const [progress, setProgress] = useState<{
        done: number;
        total: number;
    } | null>(null);

    if (pending.length === 0) return null;

    const handleAll = async (verb: "accept" | "reject") => {
        if (busy) return;
        setBusy(verb);
        setResolutionError(null);
        setProgress({ done: 0, total: pending.length });
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const token = session?.access_token;
            const apiBase =
                process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

            // Sequential requests preserve version order. Displayed bytes
            // change only after the API confirms the immutable new version.
            let done = 0;
            for (const { annotation } of pending) {
                onResolveStart?.({
                    editId: annotation.edit_id,
                    documentId: annotation.document_id,
                    verb,
                });
                try {
                    const response = await fetch(
                        `${apiBase}/single-documents/${annotation.document_id}/edits/${annotation.edit_id}/${verb}`,
                        {
                            method: "POST",
                            headers: token
                                ? { Authorization: `Bearer ${token}` }
                                : undefined,
                        },
                    );
                    if (!response.ok) {
                        throw await readEditResolutionError(response);
                    }
                    const data = (await response.json()) as {
                        status?: "accepted" | "rejected";
                        version_id: string | null;
                        download_url: string | null;
                    };
                    onResolved?.({
                        editId: annotation.edit_id,
                        documentId: annotation.document_id,
                        status:
                            data.status ??
                            (verb === "accept" ? "accepted" : "rejected"),
                        versionId: data.version_id,
                        downloadUrl: data.download_url,
                    });
                } catch (error) {
                    console.error("[BulkEditActions] resolve failed", error);
                    const message = error instanceof Error ? error.message : "Unable to save the decision. Refresh and retry.";
                    setResolutionError(message);
                    onError?.({
                        editId: annotation.edit_id,
                        documentId: annotation.document_id,
                        versionId: annotation.version_id ?? null,
                        message,
                    });
                    break;
                }
                done += 1;
                setProgress({ done, total: pending.length });
            }
        } finally {
            setBusy(null);
            setProgress(null);
        }
    };

    const first = pending[0];
    return (
        <div className="flex flex-wrap items-center gap-2">
            {resolutionError && <p role="alert" className="w-full text-xs text-red-700">{resolutionError}</p>}
            <button
                type="button"
                onClick={() => handleAll("accept")}
                disabled={!!busy}
                className="inline-flex min-h-8 items-center gap-1 rounded border border-gray-900 bg-gray-900 px-2 py-1 text-xs text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            >
                {busy === "accept" && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Accept all
            </button>
            <button
                type="button"
                onClick={() => handleAll("reject")}
                disabled={!!busy}
                className="inline-flex min-h-8 items-center gap-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
            >
                {busy === "reject" && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                )}
                Reject all
            </button>
            {progress && (
                <span className="text-xs font-serif text-gray-500" aria-live="polite">
                    {progress.done}/{progress.total}
                </span>
            )}
            {onViewClick && first && (
                <button
                    type="button"
                    onClick={() => onViewClick(first.annotation, first.filename)}
                    disabled={!!busy}
                    className="ml-auto min-h-8 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-50"
                >
                    View
                </button>
            )}
        </div>
    );
}

/** Groups multiple tracked-change cards without changing their resolution API. */
export function EditCardsSection({
    pending,
    filenameByDocId,
    cards,
    resolvedCount,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: {
    pending: PendingEdit[];
    filenameByDocId: Map<string, string>;
    cards: ReactNode[];
    resolvedCount: number;
    onViewClick?: (annotation: DocketEditAnnotation, filename: string) => void;
    onResolveStart?: ResolveStart;
    onResolved?: Resolved;
    onError?: ResolveError;
}) {
    const [isOpen, setIsOpen] = useState(true);
    if (cards.length === 0) return null;

    const documentCount = filenameByDocId.size;
    const summary =
        pending.length > 0
            ? documentCount > 1
                ? `${pending.length} tracked changes across ${documentCount} documents`
                : `${pending.length} tracked ${pending.length === 1 ? "change" : "changes"}`
            : documentCount > 1
              ? `${resolvedCount} resolved tracked changes across ${documentCount} documents`
              : `${resolvedCount} resolved tracked ${resolvedCount === 1 ? "change" : "changes"}`;

    return (
        <section className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <div className="flex items-center gap-2 px-3 pt-3">
                <p className="min-w-0 flex-1 truncate text-sm font-serif text-gray-700">
                    {summary}
                </p>
                <button
                    type="button"
                    onClick={() => setIsOpen((open) => !open)}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? "Collapse edits" : "Expand edits"}
                    className="shrink-0 rounded p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
                >
                    <ChevronDown
                        className={`h-4 w-4 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                    />
                </button>
            </div>
            {pending.length > 0 && (
                <div className="px-3 pt-3">
                    <BulkEditActions
                        pending={pending}
                        onViewClick={onViewClick}
                        onResolveStart={onResolveStart}
                        onResolved={onResolved}
                        onError={onError}
                    />
                </div>
            )}
            {isOpen && (
                <div className="flex flex-col gap-2 px-3 pb-3 pt-3">{cards}</div>
            )}
            {!isOpen && <div className="pb-3" />}
        </section>
    );
}
