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
    try {
        const url = new URL(value, COURTLISTENER_WEB_BASE);
        if (url.protocol !== "https:" || url.origin !== COURTLISTENER_WEB_BASE) {
            return null;
        }
        return url.toString();
    } catch {
        return null;
    }
}

function absoluteStorageUrl(path: unknown): string | null {
    const value = asString(path);
    if (!value) return null;
    try {
        const url = new URL(
            value.startsWith("http")
                ? value
                : `${COURTLISTENER_STORAGE_BASE}/${value.replace(/^\/+/, "")}`,
        );
        if (
            url.protocol !== "https:" ||
            url.origin !== COURTLISTENER_STORAGE_BASE
        ) {
            return null;
        }
        return url.toString();
    } catch {
        return null;
    }
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
    return `${value.slice(0, Math.max(0, maxChars - 1))}\u2026`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
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

/**
 * CourtListener opinions include publisher-provided HTML. This compact,
 * server-side allowlist means the API never sends executable or off-origin
 * markup to the browser. The UI may render the returned `html` directly.
 */
function safeCourtlistenerHref(rawHref: string | null): string | null {
    if (!rawHref) return null;
    const href = decodeHtmlEntities(rawHref.trim());
    if (!href) return null;
    if (href.startsWith("#")) return href;
    return absoluteWebUrl(href);
}

const SAFE_OPINION_HTML_TAGS = new Set([
    "a",
    "blockquote",
    "br",
    "code",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
]);

const SAFE_OPINION_ATTRS = new Set([
    "aria-label",
    "class",
    "colspan",
    "href",
    "id",
    "rowspan",
    "title",
]);

const VOID_OPINION_TAGS = new Set(["br"]);

function sanitizeOpinionClassList(value: string): string | null {
    const classes = decodeHtmlEntities(value)
        .split(/\s+/)
        .filter((className) => /^[a-z0-9_-]{1,80}$/i.test(className));
    return classes.length ? classes.join(" ") : null;
}

function sanitizeOpinionHtmlAttrs(tagName: string, attrs: string): string {
    const output: string[] = [];
    const attrPattern =
        /([^\s"'<>/=`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let match: RegExpExecArray | null;

    while ((match = attrPattern.exec(attrs))) {
        const name = (match[1] ?? "").toLowerCase();
        const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
        if (!SAFE_OPINION_ATTRS.has(name) || name.startsWith("on")) continue;

        if (name === "href") {
            if (tagName !== "a") continue;
            const href = safeCourtlistenerHref(rawValue);
            if (href) output.push(`href="${escapeHtml(href)}"`);
            continue;
        }

        if (name === "class") {
            const classList = sanitizeOpinionClassList(rawValue);
            if (classList) output.push(`class="${escapeHtml(classList)}"`);
            continue;
        }

        if (name === "id") {
            const id = decodeHtmlEntities(rawValue).trim();
            if (/^[a-z0-9_-]{1,120}$/i.test(id)) {
                output.push(`id="${escapeHtml(id)}"`);
            }
            continue;
        }

        if (name === "colspan" || name === "rowspan") {
            const value = Number.parseInt(rawValue, 10);
            if (Number.isFinite(value) && value > 0 && value <= 100) {
                output.push(`${name}="${value}"`);
            }
            continue;
        }

        const value = decodeHtmlEntities(rawValue).trim();
        if (value) output.push(`${name}="${escapeHtml(value.slice(0, 300))}"`);
    }

    if (tagName === "a") {
        output.push('target="_blank"', 'rel="noopener noreferrer"');
    }

    return output.length ? ` ${output.join(" ")}` : "";
}

export function sanitizeCourtlistenerOpinionHtml(value: string | null): string | null {
    if (!value) return null;
    const normalized = value
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(
            /<(script|style|iframe|object|embed|form|svg|math)\b[\s\S]*?<\/\1>/gi,
            "",
        )
        .replace(
            /<(script|style|iframe|object|embed|form|svg|math)\b[^>]*\/?>/gi,
            "",
        )
        .replace(
            /<page-number\b[^>]*>([\s\S]*?)<\/page-number>/gi,
            (_match, inner) =>
                `<span class="case-page-number">${escapeHtml(stripOpinionMarkup(inner) ?? "")}</span>`,
        );

    const sanitized = normalized.replace(
        /<\/?([a-z0-9-]+)\b([^>]*)>/gi,
        (match, tag, attrs) => {
            const name = String(tag).toLowerCase();
            const closing = match.startsWith("</");
            if (!SAFE_OPINION_HTML_TAGS.has(name)) return "";
            if (closing) return VOID_OPINION_TAGS.has(name) ? "" : `</${name}>`;
            if (VOID_OPINION_TAGS.has(name)) return `<${name}>`;
            return `<${name}${sanitizeOpinionHtmlAttrs(name, String(attrs))}>`;
        },
    );

    return sanitized.replace(/\n{3,}/g, "\n\n").trim();
}

function compactOpinion(
    opinion: JsonRecord,
    maxChars: number,
    includeHtml = false,
) {
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
        html: includeHtml
            ? truncate(sanitizeCourtlistenerOpinionHtml(rawHtml), maxChars)
            : null,
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

function clusterUrl(cluster: JsonRecord): string | null {
    const id = asNumber(cluster.id) ?? asNumber(cluster.cluster_id);
    if (!id) return null;
    const slug = asString(cluster.slug);
    return slug
        ? `${COURTLISTENER_WEB_BASE}/opinion/${id}/${encodeURIComponent(slug)}/`
        : `${COURTLISTENER_WEB_BASE}/opinion/${id}/`;
}

type CitationCluster = {
    clusterId: number | null;
    caseName: string | null;
    court: string | null;
    dateFiled: string | null;
    url: string | null;
    pdfUrl: string | null;
};

type CitationLookupResult = {
    citation: string | null;
    status: string;
    message: string | null;
    clusters: CitationCluster[];
};

function compactCitationCluster(raw: unknown): CitationCluster {
    const cluster =
        raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as JsonRecord)
            : {};
    return {
        clusterId: asNumber(cluster.id) ?? asNumber(cluster.cluster_id),
        caseName:
            asString(cluster.case_name) ??
            asString(cluster.caseName) ??
            asString(cluster.case_name_full) ??
            asString(cluster.caseNameFull),
        court:
            asString((cluster.docket as JsonRecord | undefined)?.court_id) ??
            asString(cluster.court) ??
            asString(cluster.court_id) ??
            null,
        dateFiled:
            asString(cluster.date_filed) ?? asString(cluster.dateFiled),
        url: absoluteWebUrl(cluster.absolute_url) ?? clusterUrl(cluster),
        pdfUrl:
            absoluteStorageUrl(cluster.filepath_pdf_harvard) ??
            absoluteStorageUrl(cluster.filepath_pdf_scan),
    };
}

function citationTextFromRow(row: JsonRecord): string | null {
    const normalized = Array.isArray(row.normalized_citations)
        ? row.normalized_citations
              .map((citation) => citationLabel(citation))
              .filter((citation): citation is string => !!citation)
        : [];
    return (
        asString(row.citation) ??
        citationLabel(row.citation) ??
        citationLabel(row.citations) ??
        normalized[0] ??
        null
    );
}

function citationStatus(row: JsonRecord, clusters: CitationCluster[]): string {
    const status = row.status;
    if (typeof status === "number" && Number.isFinite(status)) {
        return status >= 200 && status < 300 && clusters.length > 0
            ? "found"
            : status === 404
              ? "not_found"
              : String(status);
    }
    const named = asString(status);
    if (named) return named;
    return clusters.length > 0 ? "found" : "not_found";
}

function normalizeCitationLookupResult(raw: unknown): CitationLookupResult | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as JsonRecord;
    const rawClusters = Array.isArray(row.clusters)
        ? row.clusters
        : row.cluster && typeof row.cluster === "object"
          ? [row.cluster]
          : row.cluster_id
            ? [row]
            : [];
    const clusters = rawClusters
        .map(compactCitationCluster)
        .filter((cluster) => cluster.clusterId !== null || cluster.url !== null);
    return {
        citation: citationTextFromRow(row),
        status: citationStatus(row, clusters),
        message:
            asString(row.error_message) ??
            asString(row.message) ??
            asString(row.detail),
        clusters,
    };
}

function buildCitationLinks(results: CitationLookupResult[]) {
    return results.flatMap((result) =>
        result.clusters
            .filter((cluster) => cluster.clusterId && cluster.url)
            .map((cluster) => ({
                clusterId: cluster.clusterId,
                citation: result.citation,
                caseName: cluster.caseName,
                court: cluster.court,
                url: cluster.url,
                pdfUrl: cluster.pdfUrl,
                dateFiled: cluster.dateFiled,
                markdown: `[${[cluster.caseName, result.citation].filter(Boolean).join(", ") || cluster.url}](${cluster.url})`,
            })),
    );
}

function citationLookupRows(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    const record = data as JsonRecord;
    if (Array.isArray(record.results)) return record.results;
    if (Array.isArray(record.citations)) return record.citations;
    return [];
}

async function fetchCourtlistenerCitationLookup(args: {
    text: string;
    citationsSubmitted: number;
    apiToken?: string | null;
}) {
    // CourtListener documents this endpoint as form data (`text=...`), not a
    // JSON payload. Its response is normally an array but older deployments
    // have wrapped it, so citationLookupRows accepts both forms.
    const body = new URLSearchParams();
    body.set("text", args.text.slice(0, 64_000));
    const data = await courtlistenerFetch<unknown>(
        "/citation-lookup/",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body,
        },
        args.apiToken,
    );
    const results = citationLookupRows(data)
        .map(normalizeCitationLookupResult)
        .filter((result): result is CitationLookupResult => !!result);
    return {
        citationsSubmitted: args.citationsSubmitted,
        citationLinks: buildCitationLinks(results),
        results,
        source: "api",
    };
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

    return fetchCourtlistenerCitationLookup({
        text: citations.join("\n"),
        citationsSubmitted: citations.length,
        apiToken: args.apiToken,
    });
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
    const rawOpinions: JsonRecord[] = [];
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
            ? Math.max(
                  500,
                  Math.floor(
                      remainingChars / Math.max(1, pageOpinions.length * 2),
                  ),
              )
            : Math.min(3000, remainingChars);
        for (const opinion of pageOpinions) {
            if (remainingChars <= 0) break;
            const compacted = compactOpinion(
                opinion,
                Math.max(1, Math.min(opinionMaxChars, remainingChars)),
                !!args.includeFullText,
            );
            rawOpinions.push(opinion);
            opinions.push(compacted);
            // The panel receives both plain text and safe HTML. Count both so
            // one request cannot balloon its server-to-browser payload.
            remainingChars -=
                (compacted.text?.length ?? 0) + (compacted.html?.length ?? 0);
        }
        nextUrl = asString(data.next);
    }

    return {
        id: clusterId,
        url:
            absoluteWebUrl(rawOpinions[0]?.absolute_url) ??
            `${COURTLISTENER_WEB_BASE}/opinion/${clusterId}/`,
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
