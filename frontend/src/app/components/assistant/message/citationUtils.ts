import type { DocketCitation } from "../../shared/types";

/**
 * Replaces human-facing `[1]` markers with inert tokens consumed by the
 * Markdown renderer. Keeping this separate from Markdown rendering prevents
 * a partially streamed marker from being split into an interactive citation.
 */
export function preprocessCitations(
    text: string,
    citations: DocketCitation[],
    inlineCitationTargets: DocketCitation[],
): string {
    return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (full, refsString) => {
        const tokens = (refsString as string)
            .split(",")
            .map((value) => Number.parseInt(value.trim(), 10))
            .flatMap((ref) => {
                const citation = citations.find((entry) => entry.ref === ref);
                if (!citation) return [];
                const index = inlineCitationTargets.length;
                inlineCitationTargets.push(citation);
                return [`\`§${index}§\`\u200B`];
            });

        return tokens.length > 0 ? tokens.join("") : full;
    });
}

/** CourtListener URLs are the only external URLs accepted for event links. */
export function safeCourtlistenerHref(
    value: string | null | undefined,
): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "www.courtlistener.com"
            ? url.toString()
            : null;
    } catch {
        return null;
    }
}
