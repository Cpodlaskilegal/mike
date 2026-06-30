import { createServerSupabase } from "./supabase";

const COURTLISTENER_BASE = "https://www.courtlistener.com/api/rest/v4";
const COURTLISTENER_WEB_BASE = "https://www.courtlistener.com";
const COURTLISTENER_STORAGE_BASE = "https://storage.courtlistener.com";

type JsonRecord = Record<string, unknown>;
type ServerSupabase = ReturnType<typeof createServerSupabase>;

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

function courtlistenerHeaders(apiToken?: string | null): HeadersInit {
    const token =
        apiToken?.trim() || process.env.COURTLISTENER_API_TOKEN?.trim();
    if (!token) {
        throw new Error(
            "COURTLISTENER_API_TOKEN must be set to use CourtListener tools.",
        );
    }
    return {
        Accept: "application/json",
        Authorization: `Token ${token}`,
    };
}

function parseCourtlistenerError(status: number, detail: string): string {
    const trimmed = detail.trim();
    let message = trimmed || `CourtListener error (${status})`;
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const record = parsed as JsonRecord;
            message =
                asString(record.detail) ??
                asString(record.message) ??
                message;
        }
    } catch {
        // Non-JSON details are already readable enough.
    }

    if (status === 429) {
        const wait = message.match(/available in\s+(\d+)\s+seconds?/i)?.[1];
        return wait
            ? `CourtListener rate limit exceeded. Try again in ${wait} seconds.`
            : `CourtListener rate limit exceeded. ${message}`;
    }
    return `CourtListener error (${status}): ${message}`;
}

async function courtlistenerFetch<T>(
    pathOrUrl: string,
    init?: RequestInit,
    apiToken?: string | null,
): Promise<T> {
    const url = pathOrUrl.startsWith("http")
        ? pathOrUrl
        : `${COURTLISTENER_BASE}${pathOrUrl}`;
    devLog("[courtlistener/api] request", { path: pathOrUrl, url });
    const response = await fetch(url, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(15_000),
        headers: {
            ...courtlistenerHeaders(apiToken),
            ...(init?.headers ?? {}),
        },
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(parseCourtlistenerError(response.status, detail));
    }
    return response.json() as Promise<T>;
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function absoluteWebUrl(path: unknown): string | null {
    const value = asString(path);
    if (!value) return null;
    return value.startsWith("http")
        ? value
        : `${COURTLISTENER_WEB_BASE}${value}`;
}

function absoluteStorageUrl(path: unknown): string | null {
    const value = asString(path);
    if (!value) return null;
    if (value.startsWith("http")) return value;
    return `${COURTLISTENER_STORAGE_BASE}/${value.replace(/^\/+/, "")}`;
}

function citationLabel(citation: unknown): string | null {
    if (typeof citation === "string") return citation.trim() || null;
    if (!citation || typeof citation !== "object" || Array.isArray(citation)) {
        return null;
    }
    const record = citation as JsonRecord;
    const volume = asString(record.volume) ?? String(record.volume ?? "").trim();
    const reporter = asString(record.reporter);
    const page = asString(record.page) ?? String(record.page ?? "").trim();
    return [volume, reporter, page].filter(Boolean).join(" ") || null;
}

function truncate(value: string | null, maxChars: number): string | null {
    if (!value) return null;
    if (value.length <= maxChars) return value;
    return `${value.slice(0, Math.max(0, maxChars - 1))}...`;
}

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_match, code) =>
            String.fromCharCode(Number.parseInt(code, 10)),
        )
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
            String.fromCharCode(Number.parseInt(code, 16)),
        );
}

function stripOpinionMarkup(value: string | null): string | null {
    if (!value) return null;
    return decodeHtmlEntities(
        value
            .replace(/<page-number[^>]*>(.*?)<\/page-number>/gis, "$1")
            .replace(/<\/p>/gi, "\n\n")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(div|section|opinion|blockquote|li|h[1-6])>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
    );
}

function compactOpinion(opinion: JsonRecord, maxChars: number) {
    const rawHtml =
        asString(opinion.html_with_citations) ??
        asString(opinion.html) ??
        asString(opinion.xml_harvard) ??
        null;
    const rawText = asString(opinion.plain_text) ?? rawHtml;
    return {
        opinionId: asNumber(opinion.id),
        type: asString(opinion.type),
        author:
            asString(opinion.author_str) ??
            asString((opinion.author as JsonRecord | undefined)?.name),
        per_curiam: asString(opinion.per_curiam),
        joined_by_str: asString(opinion.joined_by_str),
        url: absoluteWebUrl(opinion.absolute_url),
        text: truncate(stripOpinionMarkup(rawText), maxChars),
    };
}

function compactSearchResult(raw: unknown) {
    const r = raw && typeof raw === "object" ? (raw as JsonRecord) : {};
    return {
        clusterId:
            asNumber(r.cluster_id) ??
            asNumber((r.cluster as JsonRecord | undefined)?.id),
        caseName:
            asString(r.caseName) ??
            asString(r.case_name) ??
            asString(r.caseNameFull),
        citation:
            asString(r.citation) ??
            (Array.isArray(r.citation)
                ? r.citation.map(citationLabel).filter(Boolean).join("; ")
                : null),
        court:
            asString(r.court) ??
            asString(r.court_id) ??
            asString(r.court_citation_string),
        dateFiled: asString(r.dateFiled) ?? asString(r.date_filed),
        snippet: asString(r.snippet),
        url: absoluteWebUrl(r.absolute_url),
    };
}

function normalizeCitationLookupRow(raw: unknown) {
    const row = raw && typeof raw === "object" ? (raw as JsonRecord) : {};
    const cluster =
        row.cluster && typeof row.cluster === "object"
            ? (row.cluster as JsonRecord)
            : {};
    const citation =
        asString(row.citation) ??
        citationLabel(row.citation) ??
        citationLabel(row.citations);
    const status =
        asString(row.status) ??
        (asNumber(row.cluster_id) || asNumber(cluster.id) ? "found" : "not_found");
    return {
        citation,
        status,
        clusterId: asNumber(row.cluster_id) ?? asNumber(cluster.id),
        caseName:
            asString(row.case_name) ??
            asString(row.caseName) ??
            asString(cluster.case_name) ??
            asString(cluster.caseName),
        url:
            absoluteWebUrl(row.absolute_url) ??
            absoluteWebUrl(cluster.absolute_url),
        pdfUrl:
            absoluteStorageUrl(row.filepath_pdf_harvard) ??
            absoluteStorageUrl(cluster.filepath_pdf_harvard) ??
            absoluteStorageUrl(cluster.filepath_pdf_scan),
        dateFiled:
            asString(row.date_filed) ??
            asString(row.dateFiled) ??
            asString(cluster.date_filed) ??
            asString(cluster.dateFiled),
    };
}

function buildCitationLinks(results: ReturnType<typeof normalizeCitationLookupRow>[]) {
    return results
        .filter((result) => result.clusterId && result.url)
        .map((result) => ({
            clusterId: result.clusterId,
            citation: result.citation,
            caseName: result.caseName,
            url: result.url,
            pdfUrl: result.pdfUrl,
            dateFiled: result.dateFiled,
        }));
}

export function courtlistenerApiTokenAvailable(apiToken?: string | null) {
    return !!(apiToken?.trim() || process.env.COURTLISTENER_API_TOKEN?.trim());
}

export async function verifyCourtlistenerCitations(args: {
    citations?: string[];
    db?: ServerSupabase;
    apiToken?: string | null;
}) {
    void args.db;
    const citations = Array.isArray(args.citations)
        ? args.citations
              .map((citation) =>
                  typeof citation === "string" ? citation.trim() : "",
              )
              .filter(Boolean)
              .slice(0, 250)
        : [];
    if (!citations.length) {
        return { error: "Provide at least one citation." };
    }

    const data = await courtlistenerFetch<JsonRecord>(
        "/citation-lookup/",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: citations.join("\n") }),
        },
        args.apiToken,
    );
    const rawResults =
        (Array.isArray(data.results) && data.results) ||
        (Array.isArray(data.citations) && data.citations) ||
        (Array.isArray(data) && data) ||
        [];
    const results = rawResults.map(normalizeCitationLookupRow);
    return {
        citationsSubmitted: citations.length,
        citationLinks: buildCitationLinks(results),
        results,
        source: "api",
    };
}

export async function searchCourtlistenerCaseLaw(args: {
    query?: string;
    court?: string;
    filedAfter?: string;
    filedBefore?: string;
    limit?: number;
    apiToken?: string | null;
}) {
    const query = args.query?.trim();
    if (!query) return { error: "query is required." };
    const limit = Math.max(1, Math.min(20, Math.floor(args.limit ?? 10)));
    const params = new URLSearchParams({
        type: "o",
        q: query,
    });
    if (args.court?.trim()) params.set("court", args.court.trim());
    if (args.filedAfter?.trim())
        params.set("filed_after", args.filedAfter.trim());
    if (args.filedBefore?.trim())
        params.set("filed_before", args.filedBefore.trim());

    const data = await courtlistenerFetch<JsonRecord>(
        `/search/?${params}`,
        undefined,
        args.apiToken,
    );
    const rawResults = Array.isArray(data.results) ? data.results : [];
    return {
        query,
        results: rawResults.slice(0, limit).map(compactSearchResult),
    };
}

export async function getCourtlistenerCaseOpinions(args: {
    clusterId?: number;
    includeFullText?: boolean;
    maxChars?: number;
    db?: ServerSupabase;
    apiToken?: string | null;
}) {
    void args.db;
    if (!args.clusterId || !Number.isFinite(args.clusterId)) {
        return { error: "clusterId is required." };
    }
    const clusterId = Math.floor(args.clusterId);
    const maxChars = Math.max(1000, Math.min(50000, args.maxChars ?? 12000));
    const opinions: ReturnType<typeof compactOpinion>[] = [];
    let nextUrl: string | null = `/opinions/?cluster=${clusterId}`;
    let pages = 0;
    let remainingChars = maxChars;

    while (nextUrl && pages < 10 && remainingChars > 0) {
        pages += 1;
        const data = await courtlistenerFetch<JsonRecord>(
            nextUrl,
            undefined,
            args.apiToken,
        );
        const results = Array.isArray(data.results) ? data.results : [];
        const pageOpinions = results.filter(
            (opinion): opinion is JsonRecord =>
                !!opinion &&
                typeof opinion === "object" &&
                !Array.isArray(opinion),
        );
        const opinionMaxChars = args.includeFullText
            ? Math.max(500, Math.floor(remainingChars / Math.max(1, pageOpinions.length)))
            : Math.min(3000, remainingChars);
        for (const opinion of pageOpinions) {
            if (remainingChars <= 0) break;
            const compacted = compactOpinion(
                opinion,
                Math.max(1, Math.min(opinionMaxChars, remainingChars)),
            );
            opinions.push(compacted);
            remainingChars -= compacted.text?.length ?? 0;
        }
        nextUrl = asString(data.next);
    }

    return {
        id: clusterId,
        url: `${COURTLISTENER_WEB_BASE}/opinion/${clusterId}/`,
        opinions,
        source: "api",
    };
}

export async function getCourtlistenerCases(args: {
    clusterIds?: number[];
    includeFullText?: boolean;
    maxChars?: number;
    db?: ServerSupabase;
    apiToken?: string | null;
}) {
    const clusterIds = Array.from(
        new Set(
            (args.clusterIds ?? [])
                .filter((value) => Number.isFinite(value) && value > 0)
                .map((value) => Math.floor(value)),
        ),
    );
    if (!clusterIds.length) {
        return { error: "clusterIds is required.", cases: [] };
    }

    const cases = await Promise.all(
        clusterIds.map(async (clusterId) => {
            try {
                const result = await getCourtlistenerCaseOpinions({
                    clusterId,
                    includeFullText: args.includeFullText,
                    maxChars: args.maxChars,
                    db: args.db,
                    apiToken: args.apiToken,
                });
                return {
                    clusterId,
                    ...(result && typeof result === "object"
                        ? (result as JsonRecord)
                        : { result }),
                };
            } catch (err) {
                return {
                    clusterId,
                    id: clusterId,
                    opinions: [],
                    error:
                        err instanceof Error
                            ? err.message
                            : "CourtListener case fetch failed.",
                };
            }
        }),
    );

    return { cases };
}
