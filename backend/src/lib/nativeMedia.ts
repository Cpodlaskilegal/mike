import { NATIVE_MODEL_MEDIA_MIME_TYPES } from "./documentTypes";
import { providerForModel } from "./llm/models";
import type { LlmMedia } from "./llm/types";

const MAX_NATIVE_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_NATIVE_MEDIA_FILES = 4;

export type NativeMediaSource = {
    documentId: string;
    filename: string;
    fileType: string;
    storagePath: string;
    sizeBytes?: number | null;
};

export function nativeMediaSupport(model: string, mimeType: string): boolean {
    const provider = providerForModel(model);
    if (mimeType === "application/pdf" || mimeType.startsWith("image/")) {
        return true;
    }
    return provider === "gemini" &&
        (mimeType.startsWith("audio/") || mimeType.startsWith("video/"));
}

/**
 * Load only the files the user attached on this turn, after the caller has
 * resolved their IDs against the accessible document index. Never persist the
 * base64 payload in a chat row or an observability event.
 */
export async function loadNativeMedia(params: {
    model: string;
    sources: NativeMediaSource[];
    download: (storagePath: string) => Promise<ArrayBuffer | null>;
}): Promise<{ media: LlmMedia[]; oversizedPdfs: string[] }> {
    const media: LlmMedia[] = [];
    const oversizedPdfs: string[] = [];
    let totalBytes = 0;
    const seen = new Set<string>();

    for (const source of params.sources) {
        if (seen.has(source.documentId)) continue;
        seen.add(source.documentId);
        const mimeType = NATIVE_MODEL_MEDIA_MIME_TYPES[source.fileType.toLowerCase()];
        if (!mimeType) continue;
        if (!nativeMediaSupport(params.model, mimeType)) {
            throw new Error(
                `${source.filename} requires a Gemini model for native audio or video analysis.`,
            );
        }
        if (media.length >= MAX_NATIVE_MEDIA_FILES) {
            throw new Error(`At most ${MAX_NATIVE_MEDIA_FILES} media files can be analyzed in one Assistant turn.`);
        }
        const estimatedSize = source.sizeBytes ?? 0;
        if (estimatedSize > MAX_NATIVE_MEDIA_BYTES ||
            totalBytes + estimatedSize > MAX_NATIVE_MEDIA_BYTES) {
            if (mimeType === "application/pdf") {
                oversizedPdfs.push(source.filename);
                continue;
            }
            throw new Error("Native media attachments are limited to 20 MB total per Assistant turn.");
        }

        const raw = await params.download(source.storagePath);
        if (!raw) throw new Error(`Could not load attached media: ${source.filename}`);
        if (raw.byteLength > MAX_NATIVE_MEDIA_BYTES ||
            totalBytes + raw.byteLength > MAX_NATIVE_MEDIA_BYTES) {
            if (mimeType === "application/pdf") {
                oversizedPdfs.push(source.filename);
                continue;
            }
            throw new Error("Native media attachments are limited to 20 MB total per Assistant turn.");
        }
        media.push({
            filename: source.filename,
            mimeType,
            base64Data: Buffer.from(raw).toString("base64"),
        });
        totalBytes += raw.byteLength;
    }
    return { media, oversizedPdfs };
}
