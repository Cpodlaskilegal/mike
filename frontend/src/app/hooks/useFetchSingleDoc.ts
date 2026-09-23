"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

/**
 * /display returns PDF bytes when a PDF rendition exists, original media or
 * spreadsheet bytes for those files, or raw DOCX bytes otherwise. Reporting
 * the type lets callers select the matching renderer.
 */
export type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "image"; objectUrl: string }
    | { type: "audio"; objectUrl: string }
    | { type: "video"; objectUrl: string }
    | { type: "spreadsheet"; buffer: ArrayBuffer }
    | { type: "docx" }
    | null;

function isSpreadsheetContentType(contentType: string): boolean {
    return (
        contentType.includes("spreadsheetml") ||
        contentType.includes("ms-excel")
    );
}

function previewableMediaType(
    contentType: string,
): "image" | "audio" | "video" | null {
    if (["image/png", "image/jpeg", "image/webp"].includes(contentType))
        return "image";
    if (["audio/mpeg", "audio/wav", "audio/mp4"].includes(contentType))
        return "audio";
    if (["video/mp4", "video/webm"].includes(contentType))
        return "video";
    return null;
}

export function useFetchSingleDoc(
    documentId: string | null | undefined,
    versionId?: string | null,
) {
    const [result, setResult] = useState<DocResult>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const prevKeyRef = useRef<string | null>(null);

    useEffect(() => {
        if (!documentId) return;
        const requestKey = `${documentId}:${versionId ?? "current"}`;
        if (requestKey === prevKeyRef.current) return;
        prevKeyRef.current = requestKey;

        setLoading(true);
        setError(null);
        setResult(null);

        let cancelled = false;
        let mediaObjectUrl: string | null = null;

        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const token = session?.access_token;
                if (cancelled) return;

                const apiBase =
                    process.env.NEXT_PUBLIC_API_BASE_URL ??
                    "http://localhost:3001";
                const qs = versionId
                    ? `?version_id=${encodeURIComponent(versionId)}`
                    : "";
                const response = await fetch(
                    `${apiBase}/single-documents/${documentId}/display${qs}`,
                    {
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : {},
                    },
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                if (cancelled) return;

                const contentType = (response.headers.get("content-type") ?? "")
                    .split(";")[0]
                    .trim()
                    .toLowerCase();
                const mediaType = previewableMediaType(contentType);
                if (contentType.includes("application/pdf")) {
                    const buffer = await response.arrayBuffer();
                    if (!cancelled) setResult({ type: "pdf", buffer });
                } else if (mediaType) {
                    const blob = await response.blob();
                    if (!cancelled) {
                        mediaObjectUrl = URL.createObjectURL(blob);
                        setResult({ type: mediaType, objectUrl: mediaObjectUrl });
                    }
                } else if (isSpreadsheetContentType(contentType)) {
                    const buffer = await response.arrayBuffer();
                    if (!cancelled) setResult({ type: "spreadsheet", buffer });
                } else {
                    // Drain the body so the connection is reusable, but the
                    // bytes are useless to the PDF viewer — the caller will
                    // fall back to DocxView, which fetches `/docx` itself.
                    await response.arrayBuffer().catch(() => {});
                    if (!cancelled) setResult({ type: "docx" });
                }
            } catch {
                if (!cancelled) setError("Failed to load document.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            prevKeyRef.current = null;
            if (mediaObjectUrl) URL.revokeObjectURL(mediaObjectUrl);
        };
    }, [documentId, versionId]);

    return { result, loading, error };
}
