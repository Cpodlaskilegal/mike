import { createHash } from "node:crypto";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";

export const LEGAL_OUTPUT_GATE_VERSION = "docket-legal-gate-v1";
export type LegalSource = {
    id: string;
    label: string;
    text: string;
    completeness: "complete" | "partial" | "unavailable";
    authorityName?: string | null;
    citations?: string[];
    /** Locators must come from retrieval, never from model assertions. */
    locators?: Record<string, string>;
    /** Only a trusted benchmark/attorney input may require discussion. */
    requiredDiscussion?: boolean;
};
export type LegalClaim = {
    id: string;
    sourceId?: string;
    text?: string;
    authorityName?: string;
    citation?: string;
    quote?: string;
    pinpoint?: string;
    kind?: "fact" | "authority";
};
export type LegalCheck = {
    claimId: string;
    field: string;
    status: "verified" | "error" | "unchecked";
    detail: string;
};
export type LegalQualityReport = {
    version: string;
    outputHash: string;
    decision: "blocked" | "attorney_review";
    checks: LegalCheck[];
    coverage: {
        claims: number;
        verified: number;
        errors: number;
        unchecked: number;
        sources: { id: string; label: string; completeness: LegalSource["completeness"]; textHash: string; characters: number }[];
    };
    limitations: string[];
};
export type LegalQualityEvent = { type: "legal_quality"; target: string; report: LegalQualityReport };
export type LegalQualityState = { sources: Map<string, LegalSource>; manifests: Map<string, LegalClaim[]> };
export function createLegalQualityState(): LegalQualityState {
    return { sources: new Map(), manifests: new Map() };
}
export const legalTextHash = (text: string) => createHash("sha256").update(text).digest("hex");
const normalized = (text: string) => text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
const key = (text: string) => normalized(text).toLowerCase();

/** This is a lexical evidence gate, not a legal-reasoning/citator verdict. */
export function evaluateLegalOutput(input: {
    text: string;
    claims?: LegalClaim[];
    sources: Iterable<LegalSource>;
    artifactChecks?: LegalCheck[];
}): LegalQualityReport {
    const sources = [...input.sources];
    const byId = new Map(sources.map((source) => [source.id, source]));
    const claims = input.claims ?? [];
    const checks: LegalCheck[] = [...(input.artifactChecks ?? [])];
    const check = (claimId: string, field: string, status: LegalCheck["status"], detail: string) => checks.push({ claimId, field, status, detail });
    for (const claim of claims) {
        const source = claim.sourceId ? byId.get(claim.sourceId) : undefined;
        if (!source || source.completeness === "unavailable") {
            check(claim.id, "source", "unchecked", `Source ${claim.sourceId ?? "not identified"} was not retrieved in this turn.`);
            continue;
        }
        if (claim.authorityName || claim.citation) {
            if (claim.authorityName && source.authorityName) {
                const matches = key(claim.authorityName) === key(source.authorityName);
                check(claim.id, "authority_identity", matches ? "verified" : "error", matches ? "Authority name matches retrieved metadata." : `Authority name conflicts with retrieved ${source.authorityName}.`);
            } else if (claim.authorityName) {
                check(claim.id, "authority_identity", "unchecked", "No retrieved authority-name metadata is available.");
            }
            if (claim.citation && source.citations?.length) {
                const matches = source.citations.some((citation) => key(citation) === key(claim.citation!));
                check(claim.id, "citation", matches ? "verified" : "error", matches ? "Citation matches retrieved authority metadata." : `Citation does not identify retrieved authority ${source.label}.`);
            } else if (claim.citation) {
                check(claim.id, "citation", "unchecked", "No retrieved citation metadata is available.");
            }
        }
        if (claim.quote) {
            const quote = normalized(claim.quote);
            const exists = quote.length > 0 && normalized(source.text).includes(quote);
            const edited = /\.{3}|…|\[[^\]]+\]/.test(quote);
            check(claim.id, "quotation", exists ? "verified" : quote.length > 0 && !edited && source.completeness === "complete" ? "error" : "unchecked", exists ? "Exact quotation occurs in retrieved text (whitespace and typographic quotes normalized)." : !quote ? "Empty quotation does not establish source support." : edited ? "Quotation uses editorial brackets or omissions; its accuracy requires attorney review." : source.completeness === "complete" ? "Quotation is absent from the complete retrieved text." : "Quotation was not found in a partial source; missing text remains unchecked.");
        }
        if (claim.pinpoint) {
            const passage = source.locators?.[claim.pinpoint];
            if (passage === undefined) {
                check(claim.id, "pinpoint", "unchecked", "This locator is not mapped in the retrieved text; reporter pagination is not inferred.");
            } else if (!claim.quote || !normalized(claim.quote)) {
                check(claim.id, "pinpoint", "unchecked", "Locator exists, but no exact supporting quotation was supplied.");
            } else {
                const matches = normalized(passage).includes(normalized(claim.quote));
                const edited = /\.{3}|…|\[[^\]]+\]/.test(claim.quote);
                check(claim.id, "pinpoint", matches ? "verified" : edited ? "unchecked" : "error", matches ? "Quotation occurs at the retrieved locator." : edited ? "Edited or abridged quotation requires manual locator verification." : "Quotation does not occur at the stated retrieved locator.");
            }
        }
        if (claim.kind === "fact") {
            // Even verbatim text does not prove factual truth or entailment.
            check(claim.id, "factual_support", "unchecked", claim.text && normalized(source.text).includes(normalized(claim.text)) ? "Wording occurs in the source; factual truth, context and evidentiary support require attorney review." : "The factual assertion is not established by an exact source passage; attorney review is required.");
        }
        if (source.completeness === "partial") check(claim.id, "source_coverage", "unchecked", "Source was truncated or only an excerpt was retrieved.");
        if (!claim.quote && !claim.citation && !claim.authorityName && claim.kind !== "fact") check(claim.id, "support", "unchecked", "No verifiable support fields were supplied.");
    }
    for (const source of sources.filter((source) => source.requiredDiscussion)) {
        const included = [source.authorityName, ...(source.citations ?? [])].filter(Boolean).some((identity) => key(input.text).includes(key(identity!)));
        check(source.id, "adverse_authority", included ? "verified" : "error", included ? "Required authority is mentioned; adequacy of treatment requires attorney review." : `Required adverse authority ${source.label} is omitted.`);
    }
    if (!claims.length) check("output", "claim_inventory", "unchecked", "No structured claim inventory was available. Unidentified citations, quotations and factual claims remain unchecked.");
    check("output", "unlisted_claims", "unchecked", "Automatic extraction is limited. Claims outside this inventory are not certified.");
    for (const field of ["holding_and_application", "precedential_weight", "current_law_and_treatment", "adverse_authority_search"]) {
        check("output", field, "unchecked", "This deterministic gate does not perform this legal judgment or comprehensive research check.");
    }
    const counts = (status: LegalCheck["status"]) => checks.filter((item) => item.status === status).length;
    return {
        version: LEGAL_OUTPUT_GATE_VERSION,
        outputHash: legalTextHash(input.text),
        decision: counts("error") ? "blocked" : "attorney_review",
        checks,
        coverage: { claims: claims.length, verified: counts("verified"), errors: counts("error"), unchecked: counts("unchecked"), sources: sources.map((source) => ({ id: source.id, label: source.label, completeness: source.completeness, textHash: legalTextHash(source.text), characters: source.text.length })) },
        limitations: ["For attorney review. Passing means no demonstrated mismatch in the checks performed, not legal correctness.", "No commercial citator, comprehensive adverse-authority search, semantic fact verification, Word rendering or full OOXML schema validation is performed."],
    };
}

/** Model-provided 'verified', source text and coverage flags are deliberately ignored. */
export function parseLegalClaims(raw: unknown): LegalClaim[] {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 200).flatMap((value, index) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const record = value as Record<string, unknown>;
        const claim: LegalClaim = { id: typeof record.id === "string" ? record.id.slice(0, 100) : `claim-${index + 1}` };
        for (const field of ["sourceId", "text", "authorityName", "citation", "quote", "pinpoint"] as const) {
            if (typeof record[field] === "string" && record[field].trim()) claim[field] = record[field].slice(0, 20_000);
        }
        if (record.kind === "fact" || record.kind === "authority") claim.kind = record.kind;
        return [claim];
    });
}

export function recordLegalDocumentSource(state: LegalQualityState | undefined, id: string, label: string, text: string, maxVisibleChars: number) {
    if (!state) return;
    const unavailable = !text.replace(/\[Page \d+\]/g, "").trim() || /^(Document (?:not found|could not be read)\.|This image, audio, or video file has no text extraction\.)/.test(text);
    const locators: Record<string, string> = {};
    for (const match of text.matchAll(/\[Page (\d+)\]([\s\S]*?)(?=\[Page \d+\]|$)/g)) locators[match[1]] = match[2];
    if (state.sources.get(id)?.completeness === "complete" && state.sources.get(id)?.text === text) return;
    state.sources.set(id, { id, label, text: unavailable ? "" : text, completeness: unavailable ? "unavailable" : text.length > maxVisibleChars ? "partial" : "complete", locators });
}

/** Recognizes Docket's document citation payload even when no manifest tool was called. */
export function extractLegalDocumentClaims(text: string): LegalClaim[] {
    const match = text.match(/<CITATIONS>([\s\S]*?)<\/CITATIONS>/i);
    if (!match) return [];
    try {
        const payload: unknown = JSON.parse(match[1]);
        if (!Array.isArray(payload)) return [];
        return payload.flatMap((value, index) => {
            const row = value as Record<string, unknown>;
            if (row && typeof row.cluster_id === "number" && Array.isArray(row.quotes)) {
                return row.quotes.flatMap((value, quoteIndex) => {
                    const entry = value as Record<string, unknown>;
                    if (!entry || typeof entry.quote !== "string" || !entry.quote.trim()) return [];
                    return [{ id: `case-citation-${index + 1}-${quoteIndex + 1}`, sourceId: `case-${row.cluster_id}:${entry.opinion_id ?? "unknown"}`, quote: entry.quote }];
                });
            }
            if (!row || typeof row !== "object" || typeof row.doc_id !== "string") return [];
            const quote = typeof row.quote === "string" ? row.quote : typeof row.text === "string" ? row.text : undefined;
            if (!quote?.trim()) return [];
            const range = typeof row.page === "string" ? row.page.match(/^(\d+)\s*-\s*(\d+)$/) : null;
            if (range && quote.includes("[[PAGE_BREAK]]")) return quote.split("[[PAGE_BREAK]]").slice(0, 2).map((part, quoteIndex) => ({ id: `citation-${index + 1}-${quoteIndex + 1}`, sourceId: row.doc_id as string, quote: part.trim(), pinpoint: range[quoteIndex + 1] }));
            return [{ id: `citation-${index + 1}`, sourceId: row.doc_id, quote, pinpoint: typeof row.page === "number" || typeof row.page === "string" ? String(row.page) : undefined }];
        });
    } catch { return []; }
}

export function finalizeLegalOutput(text: string, state: LegalQualityState): { text: string; report: LegalQualityReport } {
    const claims = [...(state.manifests.get(legalTextHash(text)) ?? []), ...extractLegalDocumentClaims(text)];
    const report = evaluateLegalOutput({ text, claims, sources: state.sources.values() });
    return { text: report.decision === "blocked" ? "Docket withheld this response because a citation or quotation conflicts with retrieved evidence. Review the legal evidence check for the errors and correct them before relying on a draft." : text, report };
}

export async function inspectLegalDocx(buffer: Buffer): Promise<LegalCheck[]> {
    const checks: LegalCheck[] = [];
    const add = (status: LegalCheck["status"], detail: string) => checks.push({ claimId: "artifact", field: "docx_structure", status, detail });
    try {
        const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
        for (const part of ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]) {
            const entry = zip.file(part);
            if (!entry) { add("error", `DOCX is missing ${part}.`); continue; }
            const xml = await entry.async("string");
            if (XMLValidator.validate(xml) !== true) add("error", `${part} is malformed XML.`);
            else add("verified", `${part} is present and well-formed XML.`);
            if (part === "word/document.xml" && !/<w:body(?:\s|>)/.test(xml)) add("error", "DOCX document has no Word body.");
            if (part === "word/document.xml") {
                const sizes = [...xml.matchAll(/<w:(?:sz|szCs)\b[^>]*\bw:val="([^"]+)"/g), ...[...xml.matchAll(/<w:pgSz\b[^>]*>/g)].flatMap((tag) => [...tag[0].matchAll(/\bw:[wh]="([^"]+)"/g)])];
                for (const size of sizes) if (!/^\d+$/.test(size[1]) || Number(size[1]) <= 0) checks.push({ claimId: "artifact", field: "docx_formatting", status: "error", detail: "DOCX contains a nonpositive or invalid explicit font/page size." });
            }
        }
    } catch { add("error", "DOCX is not a readable ZIP package with valid CRCs."); }
    checks.push({ claimId: "artifact", field: "docx_visual_formatting", status: "unchecked", detail: "Page layout, typography, clipping, signatures and exemplar fidelity require rendered attorney review." });
    return checks;
}

export const LEGAL_CLAIM_PARAMETERS = {
    type: "array", description: "Claim inventory for the exact proposed text. Source IDs are retrieved doc-N or case-CLUSTER:OPINION. Do not supply source text or verification assertions.",
    items: { type: "object", properties: { id: { type: "string" }, sourceId: { type: "string" }, text: { type: "string" }, authorityName: { type: "string" }, citation: { type: "string" }, quote: { type: "string" }, pinpoint: { type: "string" }, kind: { type: "string", enum: ["fact", "authority"] } }, required: ["id", "sourceId"] },
};
export const LEGAL_QUALITY_TOOL = {
    type: "function", function: { name: "check_legal_output", description: "Check the exact proposed draft against sources actually retrieved this turn. Known citation, authority, quote or locator mismatches block release. Unknown checks are listed for attorney review. This is not a citator or a legal-correctness certification.", parameters: { type: "object", properties: { text: { type: "string" }, claims: LEGAL_CLAIM_PARAMETERS }, required: ["text", "claims"] } },
};
export const LEGAL_QUALITY_PROMPT = "Before completing a legal draft, research memo or citation audit, use check_legal_output with the exact proposed text and a claim inventory. Sources must be actually retrieved in this turn: doc-N for documents, case-CLUSTER:OPINION for read opinions. The server checks evidence, not your verification assertions. Add legal_claims to generate_docx/edit_document for the proposed text. Correct or remove demonstrated mismatches; never describe an attorney_review decision as verified legal correctness. Unchecked holding/application, adverse search, currency/treatment, factual support and visual Word formatting need attorney review.";
