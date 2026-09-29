"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { readEditResolutionError } from "@/app/lib/editResolutionError";
import type { DocketEditAnnotation } from "../shared/types";


interface Props {
    annotation: DocketEditAnnotation;
    /**
     * External override for this edit's status. When set, takes
     * precedence over the annotation's DB status and the card's own
     * internal state — used so bulk-resolved edits flip their per-card
     * UI the moment the bulk handler calls onResolved.
     */
    resolvedStatus?: "accepted" | "rejected";
    /**
     * True while an accept/reject request for any edit on this document
     * is in flight (from here, DocPanel, or the bulk bar). When true the
     * Accept/Reject buttons disable so the user can't race resolutions.
     */
    isReloading?: boolean;
    onViewClick?: (ann: DocketEditAnnotation) => void;
    /**
     * Fires immediately when the user clicks Accept or Reject, before the
     * backend round-trip. Parents use this to show an in-progress spinner
     * on download cards / editor panels tied to the same document while
     * the version is being mutated.
     */
    onResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    /**
     * Fires when the backend accept/reject call fails. The original
     * displayed bytes are preserved. Parent should surface a
     * warning (e.g. on the DocxView for this document + version) and
     * clear the per-edit in-flight state keyed on `editId`.
     */
    onError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
}

/**
 * Renders a single tracked-change proposal as a card in the assistant
 * message with Accept / Reject / View controls.
 */
export function EditCard({
    annotation,
    resolvedStatus,
    isReloading,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: Props) {
    const [busy, setBusy] = useState(false);
    const [resolutionError, setResolutionError] = useState<string | null>(null);
    const [localStatus, setLocalStatus] = useState<
        "pending" | "accepted" | "rejected"
    >(annotation.status);
    // External override (from a bulk resolve) takes precedence over the
    // card's own click-driven state.
    const status = resolvedStatus ?? localStatus;
    const setStatus = setLocalStatus;

    const resolved = status !== "pending";
    // True while an accept/reject request for any edit on this card's
    // document is in flight — triggered here, in DocPanel, or in the
    // bulk bar. Disables the buttons so the user can't race resolutions.
    const inFlight = busy || !!isReloading;

    const handle = async (verb: "accept" | "reject") => {
        if (busy || resolved) return;
        setBusy(true);
        setResolutionError(null);
        onResolveStart?.({
            editId: annotation.edit_id,
            documentId: annotation.document_id,
            verb,
        });
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const token = session?.access_token;
            const apiBase =
                process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
            const resp = await fetch(
                `${apiBase}/single-documents/${annotation.document_id}/edits/${annotation.edit_id}/${verb}`,
                {
                    method: "POST",
                    headers: token
                        ? { Authorization: `Bearer ${token}` }
                        : undefined,
                },
            );
            if (!resp.ok) throw await readEditResolutionError(resp);
            const data = (await resp.json()) as {
                ok: boolean;
                already_resolved?: boolean;
                status?: "accepted" | "rejected";
                version_id: string | null;
                download_url: string | null;
            };
            const nextStatus =
                data.status ?? (verb === "accept" ? "accepted" : "rejected");
            setStatus(nextStatus);
            onResolved?.({
                editId: annotation.edit_id,
                documentId: annotation.document_id,
                status: nextStatus,
                versionId: data.version_id,
                downloadUrl: data.download_url,
            });
        } catch (e) {
            console.error("EditCard resolve failed", e);
            const message = e instanceof Error ? e.message : "Unable to save the decision. Refresh and retry.";
            setResolutionError(message);
            onError?.({
                editId: annotation.edit_id,
                documentId: annotation.document_id,
                versionId: annotation.version_id ?? null,
                message,
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
            {annotation.reason && (
                <p className="text-xs text-gray-500 mb-2">
                    {annotation.reason}
                </p>
            )}
            <div className="text-sm leading-relaxed font-serif bg-white border border-gray-200 rounded-md px-2 py-2">
                {annotation.inserted_text && (
                    <span className="text-green-700">
                        {annotation.inserted_text}
                    </span>
                )}
                {annotation.deleted_text && (
                    <span className="text-red-600 line-through">
                        {annotation.deleted_text}
                    </span>
                )}
            </div>
            {resolutionError && <p role="alert" className="mt-2 text-xs text-red-700">{resolutionError}</p>}
            <div className="flex gap-2 mt-3">
                <button
                    onClick={() => handle("accept")}
                    disabled={inFlight || resolved}
                    className="px-2 py-1 text-xs rounded border border-gray-900 bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
                >
                    {status === "accepted" ? "Accepted" : "Accept"}
                </button>
                <button
                    onClick={() => handle("reject")}
                    disabled={inFlight || resolved}
                    className="px-2 py-1 text-xs rounded border border-gray-200 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                    {status === "rejected" ? "Rejected" : "Reject"}
                </button>
                {onViewClick && (
                    <button
                        onClick={() => onViewClick(annotation)}
                        disabled={resolved}
                        title={
                            resolved
                                ? "This change has been resolved and is no longer in the document."
                                : undefined
                        }
                        className="ml-auto px-2 py-1 text-xs rounded border border-gray-200 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white"
                    >
                        View
                    </button>
                )}
            </div>
        </div>
    );
}
