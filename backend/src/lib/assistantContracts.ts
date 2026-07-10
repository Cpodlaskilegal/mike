/**
 * Docket-native contracts shared by the assistant stream, chat routes, and
 * client. This deliberately has no Supabase dependency: Docket persists data
 * through its PostgreSQL adapter and gates every route with Entra auth.
 */

const MAX_ASK_INPUT_ITEMS = 12;
const MAX_ASK_INPUT_OPTIONS = 24;
const MAX_ASK_INPUT_DOCUMENTS = 20;
const MAX_RESPONSE_TEXT = 4_000;
const MAX_FILENAME_LENGTH = 512;
const MAX_CITATION_QUOTES = 3;
const CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;
export const CITATIONS_OPEN_TAG = "<CITATIONS>";
export const CITATIONS_CLOSE_TAG = "</CITATIONS>";

export type AskInputOption = { value: string };

export type AskInputItem =
    | {
          id: string;
          kind: "choice";
          question: string;
          options: AskInputOption[];
          allow_other: boolean;
          other_label: string;
          response_prefix?: string;
      }
    | {
          id: string;
          kind: "documents";
          document_types: string[];
          response_prefix?: string;
      };

/** A tool-emitted prompt that can be persisted and resumed safely. */
export type AskInputsEvent = {
    type: "ask_inputs";
    request_id: string;
    items: AskInputItem[];
};

export type AskInputResponseItem =
    | {
          id: string;
          kind: "choice";
          question?: string;
          answer?: string;
          skipped?: boolean;
      }
    | {
          id: string;
          kind: "documents";
          filenames?: string[];
          skipped?: boolean;
      };

export type AskInputsResponse = {
    request_id: string;
    responses: AskInputResponseItem[];
};

export type AskInputsResponseEvent = AskInputsResponse & {
    type: "ask_inputs_response";
};

type ParseAskInputsResponseResult =
    | { ok: true; provided: false; response: null }
    | { ok: true; provided: true; response: AskInputsResponse }
    | { ok: false; provided: true; detail: string };

type ValidatedAskInputsResponse = {
    response: AskInputsResponse;
    content: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanText(
    value: unknown,
    options: { max?: number; allowEmpty?: boolean } = {},
): string | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!options.allowEmpty && !text) return null;
    if (text.length > (options.max ?? MAX_RESPONSE_TEXT)) return null;
    if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
        return null;
    }
    return text;
}

function cleanIdentifier(value: unknown): string | null {
    const text = cleanText(value, { max: 160 });
    if (!text) return null;
    return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) ? text : null;
}

function cleanFilename(value: unknown): string | null {
    const text = cleanText(value, { max: MAX_FILENAME_LENGTH });
    if (!text) return null;
    // Storage keys are never accepted here. The client submits display names;
    // document IDs are independently access-checked by the chat route.
    return text.includes("\0") ? null : text;
}

/**
 * Strictly validate the wire payload before a response can change a pending
 * assistant input request. The prompt text and permitted choices are checked
 * later against the persisted event; values in this payload are not trusted.
 */
export function parseAskInputsResponsePayload(
    value: unknown,
): ParseAskInputsResponseResult {
    if (value === undefined) return { ok: true, provided: false, response: null };
    if (!isRecord(value)) {
        return {
            ok: false,
            provided: true,
            detail: "ask_inputs_response must be an object",
        };
    }
    const requestId = cleanIdentifier(value.request_id);
    if (!requestId) {
        return {
            ok: false,
            provided: true,
            detail: "ask_inputs_response.request_id is invalid",
        };
    }
    if (!Array.isArray(value.responses) || value.responses.length === 0) {
        return {
            ok: false,
            provided: true,
            detail: "ask_inputs_response.responses must be a non-empty array",
        };
    }
    if (value.responses.length > MAX_ASK_INPUT_ITEMS) {
        return {
            ok: false,
            provided: true,
            detail: `ask_inputs_response.responses may contain at most ${MAX_ASK_INPUT_ITEMS} items`,
        };
    }

    const seen = new Set<string>();
    const responses: AskInputResponseItem[] = [];
    for (let index = 0; index < value.responses.length; index += 1) {
        const raw = value.responses[index];
        if (!isRecord(raw)) {
            return {
                ok: false,
                provided: true,
                detail: `ask_inputs_response.responses[${index}] must be an object`,
            };
        }
        const id = cleanIdentifier(raw.id);
        if (!id || seen.has(id)) {
            return {
                ok: false,
                provided: true,
                detail: `ask_inputs_response.responses[${index}].id is invalid or duplicated`,
            };
        }
        seen.add(id);
        const skipped = raw.skipped === true;

        if (raw.kind === "choice") {
            const answer =
                raw.answer === undefined
                    ? undefined
                    : cleanText(raw.answer, { max: MAX_RESPONSE_TEXT }) ?? undefined;
            if (!skipped && !answer) {
                return {
                    ok: false,
                    provided: true,
                    detail: `ask_inputs_response.responses[${index}].answer is required`,
                };
            }
            responses.push({
                id,
                kind: "choice",
                ...(skipped ? { skipped: true } : { answer }),
            });
            continue;
        }

        if (raw.kind === "documents") {
            const rawFilenames = raw.filenames ?? [];
            if (!Array.isArray(rawFilenames)) {
                return {
                    ok: false,
                    provided: true,
                    detail: `ask_inputs_response.responses[${index}].filenames must be an array`,
                };
            }
            if (rawFilenames.length > MAX_ASK_INPUT_DOCUMENTS) {
                return {
                    ok: false,
                    provided: true,
                    detail: `ask_inputs_response.responses[${index}].filenames may contain at most ${MAX_ASK_INPUT_DOCUMENTS} files`,
                };
            }
            const filenames = rawFilenames.map(cleanFilename);
            if (filenames.some((filename) => !filename)) {
                return {
                    ok: false,
                    provided: true,
                    detail: `ask_inputs_response.responses[${index}].filenames contains an invalid filename`,
                };
            }
            if (!skipped && filenames.length === 0) {
                return {
                    ok: false,
                    provided: true,
                    detail: `ask_inputs_response.responses[${index}].filenames is required`,
                };
            }
            responses.push({
                id,
                kind: "documents",
                ...(skipped
                    ? { skipped: true, filenames: [] }
                    : { filenames: filenames as string[] }),
            });
            continue;
        }

        return {
            ok: false,
            provided: true,
            detail: `ask_inputs_response.responses[${index}].kind is invalid`,
        };
    }

    return {
        ok: true,
        provided: true,
        response: { request_id: requestId, responses },
    };
}

/**
 * Validate answers against the request actually persisted by Docket. This
 * prevents a caller from replacing a prompt, responding to a different input,
 * or claiming a choice that was not offered.
 */
export function validateAskInputsResponse(
    response: AskInputsResponse,
    request: AskInputsEvent,
):
    | { ok: true; response: AskInputsResponse; content: string }
    | { ok: false; detail: string } {
    if (response.request_id !== request.request_id) {
        return { ok: false, detail: "Ask Inputs request does not match this chat" };
    }
    if (response.responses.length !== request.items.length) {
        return {
            ok: false,
            detail: "Every requested input must be answered or skipped",
        };
    }

    const responsesById = new Map(response.responses.map((item) => [item.id, item]));
    if (responsesById.size !== request.items.length) {
        return { ok: false, detail: "Ask Inputs response contains duplicate items" };
    }

    const canonical: AskInputResponseItem[] = [];
    for (const item of request.items) {
        const responseItem = responsesById.get(item.id);
        if (!responseItem || responseItem.kind !== item.kind) {
            return { ok: false, detail: `Input '${item.id}' does not match the request` };
        }
        if (item.kind === "choice" && responseItem.kind === "choice") {
            const answer = responseItem.answer?.trim();
            if (!responseItem.skipped) {
                if (!answer) {
                    return { ok: false, detail: `Input '${item.id}' requires an answer` };
                }
                const permitted = item.options.some(
                    (option) => option.value.trim().toLocaleLowerCase() === answer.toLocaleLowerCase(),
                );
                if (!permitted && !item.allow_other) {
                    return { ok: false, detail: `Input '${item.id}' must use one of the offered choices` };
                }
            }
            canonical.push(
                responseItem.skipped
                    ? { id: item.id, kind: "choice", question: item.question, skipped: true }
                    : { id: item.id, kind: "choice", question: item.question, answer },
            );
            continue;
        }
        if (item.kind === "documents" && responseItem.kind === "documents") {
            const filenames = responseItem.filenames ?? [];
            if (!responseItem.skipped && filenames.length === 0) {
                return { ok: false, detail: `Input '${item.id}' requires a document` };
            }
            canonical.push(
                responseItem.skipped
                    ? { id: item.id, kind: "documents", filenames: [], skipped: true }
                    : { id: item.id, kind: "documents", filenames },
            );
        }
    }

    const normalized = { request_id: request.request_id, responses: canonical };
    return { ok: true, response: normalized, content: formatAskInputsResponse(normalized) };
}

/** Canonical content for the continuation turn, derived from trusted prompt IDs. */
export function formatAskInputsResponse(response: AskInputsResponse): string {
    const lines = response.responses.map((item, index) => {
        if (item.kind === "choice") {
            if (item.skipped) return `${index + 1}. Skipped: ${item.question ?? "Question"}`;
            return `${index + 1}. ${item.question ?? "Question"}\n${item.answer ?? ""}`;
        }
        if (item.skipped) return `${index + 1}. Skipped document request.`;
        return `${index + 1}. Documents attached: ${(item.filenames ?? []).join(", ")}`;
    });
    return `Responses to Docket's questions:\n${lines.join("\n\n")}`;
}

/**
 * Normalize tool arguments before sending `ask_inputs` over SSE. Supplying an
 * explicit request ID permits the route to persist exactly the same event.
 */
export function normalizeAskInputsEvent(
    value: unknown,
    requestId?: string,
): AskInputsEvent | null {
    if (!isRecord(value) || !Array.isArray(value.items)) return null;
    const id = cleanIdentifier(requestId ?? value.request_id);
    if (!id) return null;
    const usedIds = new Set<string>();
    const items = value.items
        .map((raw, index): AskInputItem | null => {
            if (!isRecord(raw)) return null;
            const kind = raw.kind;
            const itemId = cleanIdentifier(raw.id) ?? `${kind === "documents" ? "documents" : "choice"}-${index + 1}`;
            if (usedIds.has(itemId)) return null;
            usedIds.add(itemId);
            const responsePrefix = cleanText(raw.response_prefix, { max: 200 });
            if (kind === "choice") {
                const question = cleanText(raw.question, { max: 1_000 });
                const rawOptions = Array.isArray(raw.options) ? raw.options : [];
                const options = rawOptions
                    .map((option) => cleanText(isRecord(option) ? option.value : option, { max: 500 }))
                    .filter((option): option is string => !!option)
                    .slice(0, MAX_ASK_INPUT_OPTIONS)
                    .map((option) => ({ value: option }));
                if (!question || options.length === 0) return null;
                const otherLabel = cleanText(raw.other_label, { max: 200 }) ?? "Other";
                return {
                    id: itemId,
                    kind,
                    question,
                    options,
                    allow_other: raw.allow_other === true,
                    other_label: otherLabel,
                    ...(responsePrefix ? { response_prefix: responsePrefix } : {}),
                };
            }
            if (kind === "documents") {
                const rawTypes = Array.isArray(raw.document_types) ? raw.document_types : [];
                const documentTypes = rawTypes
                    .map((documentType) => cleanText(documentType, { max: 120 }))
                    .filter((documentType): documentType is string => !!documentType)
                    .slice(0, MAX_ASK_INPUT_OPTIONS);
                return {
                    id: itemId,
                    kind,
                    document_types: documentTypes,
                    ...(responsePrefix ? { response_prefix: responsePrefix } : {}),
                };
            }
            return null;
        })
        .filter((item): item is AskInputItem => !!item)
        .slice(0, MAX_ASK_INPUT_ITEMS);
    return items.length ? { type: "ask_inputs", request_id: id, items } : null;
}

/** Return the latest request with no matching response event after it. */
export function findPendingAskInputsEvent(events: unknown): AskInputsEvent | null {
    if (!Array.isArray(events)) return null;
    let pending: AskInputsEvent | null = null;
    for (const raw of events) {
        if (!isRecord(raw)) continue;
        if (raw.type === "ask_inputs") {
            const event = normalizeAskInputsEvent(raw, cleanIdentifier(raw.request_id) ?? undefined);
            if (event) pending = event;
        } else if (
            raw.type === "ask_inputs_response" &&
            pending &&
            cleanIdentifier(raw.request_id) === pending.request_id
        ) {
            pending = null;
        }
    }
    return pending;
}

/** Minimal surface shared by Docket's PostgreSQL query adapter and tests. */
export type DocketAssistantContractsDb = {
    from(table: string): any;
};

type PersistAskInputsRequestParams = {
    chatId: string;
    assistantMessageId: string;
    createdByUserId: string;
    event: AskInputsEvent;
};

type AssistantContractsFailure = {
    ok: false;
    status: 400 | 404 | 409 | 500;
    detail: string;
};

type PersistAskInputsRequestResult =
    | { ok: true; event: AskInputsEvent }
    | AssistantContractsFailure;

/**
 * Persist an emitted `ask_inputs` event before the stream pauses. The stream
 * dispatcher calls this after it has allocated the assistant placeholder row.
 */
export async function persistAskInputsRequest(
    db: DocketAssistantContractsDb,
    params: PersistAskInputsRequestParams,
): Promise<PersistAskInputsRequestResult> {
    const event = normalizeAskInputsEvent(params.event, params.event.request_id);
    if (!event) {
        return { ok: false, status: 400, detail: "Invalid Ask Inputs request" };
    }
    try {
        const { error } = await db.from("assistant_input_requests").insert({
            id: event.request_id,
            chat_id: params.chatId,
            assistant_message_id: params.assistantMessageId,
            created_by_user_id: params.createdByUserId,
            request: event,
            status: "pending",
        });
        if (error) {
            return {
                ok: false,
                status: 500,
                detail: "Failed to persist Ask Inputs request",
            };
        }
        return { ok: true, event };
    } catch {
        return {
            ok: false,
            status: 500,
            detail: "Failed to persist Ask Inputs request",
        };
    }
}

type ConsumeAskInputsResponseParams = {
    chatId: string;
    submittedByUserId: string;
    response: AskInputsResponse;
};

type ConsumeAskInputsResponseResult =
    | {
          ok: true;
          request: AskInputsEvent;
          response: AskInputsResponse;
          event: AskInputsResponseEvent;
          content: string;
      }
    | AssistantContractsFailure;

/**
 * Resolve a pending request and append its canonical response to the original
 * assistant event for replay. Route-level Entra/project authorization is
 * intentionally performed before this function is called.
 */
export async function consumeAskInputsResponse(
    db: DocketAssistantContractsDb,
    params: ConsumeAskInputsResponseParams,
): Promise<ConsumeAskInputsResponseResult> {
    try {
        const { data: rawRequest, error: requestError } = await db
            .from("assistant_input_requests")
            .select("id, chat_id, assistant_message_id, request, status")
            .eq("id", params.response.request_id)
            .eq("chat_id", params.chatId)
            .maybeSingle();
        if (requestError) {
            return {
                ok: false,
                status: 500,
                detail: "Failed to load Ask Inputs request",
            };
        }
        if (!rawRequest) {
            return { ok: false, status: 404, detail: "Ask Inputs request not found" };
        }
        const stored = rawRequest as {
            id?: unknown;
            assistant_message_id?: unknown;
            request?: unknown;
            status?: unknown;
        };
        if (stored.status !== "pending") {
            return {
                ok: false,
                status: 409,
                detail: "Ask Inputs request has already been resolved",
            };
        }
        const requestId = cleanIdentifier(stored.id);
        const assistantMessageId = cleanText(stored.assistant_message_id, { max: 200 });
        const request = normalizeAskInputsEvent(stored.request, requestId ?? undefined);
        if (!requestId || !assistantMessageId || !request) {
            return {
                ok: false,
                status: 500,
                detail: "Stored Ask Inputs request is invalid",
            };
        }
        const validated = validateAskInputsResponse(params.response, request);
        if (!validated.ok) {
            return { ok: false, status: 400, detail: validated.detail };
        }

        const { data: message, error: messageError } = await db
            .from("chat_messages")
            .select("id, content")
            .eq("id", assistantMessageId)
            .maybeSingle();
        if (messageError) {
            return {
                ok: false,
                status: 500,
                detail: "Failed to load Ask Inputs message",
            };
        }
        const events = (message as { content?: unknown } | null)?.content;
        const pending = findPendingAskInputsEvent(events);
        if (!message || !pending || pending.request_id !== request.request_id) {
            return {
                ok: false,
                status: 409,
                detail: "Ask Inputs request is no longer pending in this chat",
            };
        }

        // The unique request_id constraint makes a replayed browser submit
        // safe: a second request cannot create a second answer row.
        const { error: responseError } = await db
            .from("assistant_input_responses")
            .insert({
                request_id: request.request_id,
                submitted_by_user_id: params.submittedByUserId,
                response: validated.response,
            });
        if (responseError) {
            return {
                ok: false,
                status: 409,
                detail: "Ask Inputs response has already been submitted",
            };
        }

        const event: AskInputsResponseEvent = {
            type: "ask_inputs_response",
            ...validated.response,
        };
        const nextEvents = Array.isArray(events) ? [...events, event] : [event];
        const { error: messageUpdateError } = await db
            .from("chat_messages")
            .update({ content: nextEvents })
            .eq("id", assistantMessageId);
        if (messageUpdateError) {
            return {
                ok: false,
                status: 500,
                detail: "Failed to record Ask Inputs response",
            };
        }
        const { error: statusError } = await db
            .from("assistant_input_requests")
            .update({ status: "resolved", resolved_at: new Date().toISOString() })
            .eq("id", request.request_id)
            .eq("status", "pending");
        if (statusError) {
            return {
                ok: false,
                status: 500,
                detail: "Failed to resolve Ask Inputs request",
            };
        }
        return {
            ok: true,
            request,
            response: validated.response,
            event,
            content: validated.content,
        };
    } catch {
        return {
            ok: false,
            status: 500,
            detail: "Failed to resolve Ask Inputs request",
        };
    }
}

// ---------------------------------------------------------------------------
// Rich citations: document quotes, spreadsheet cells, and CourtListener cases
// ---------------------------------------------------------------------------

export type DocumentCitationQuote = {
    page: number | string;
    quote: string;
    sheet?: string;
    cell?: string;
};

export type CaseCitationQuote = {
    opinionId: number | null;
    type: string | null;
    author: string | null;
    quote: string;
};

export type ParsedDocumentCitation = {
    kind: "document";
    ref: number;
    doc_id: string;
    page: number | string;
    quote: string;
    sheet?: string;
    cell?: string;
    quotes: DocumentCitationQuote[];
};

export type ParsedCaseCitation = {
    kind: "case";
    ref: number;
    cluster_id: number;
    quotes: CaseCitationQuote[];
};

export type ParsedRichCitation = ParsedDocumentCitation | ParsedCaseCitation;

export type RichDocumentCitation = {
    type: "citation_data";
    kind: "document";
    ref: number;
    doc_id: string;
    document_id?: string;
    version_id?: string | null;
    version_number?: number | null;
    filename: string;
    page: number | string;
    quote: string;
    sheet?: string;
    cell?: string;
    quotes: DocumentCitationQuote[];
};

export type RichCaseCitation = {
    type: "citation_data";
    kind: "case";
    ref: number;
    cluster_id: number;
    case_name: string | null;
    citation: string | null;
    url: string | null;
    pdfUrl: string | null;
    dateFiled: string | null;
    quotes: CaseCitationQuote[];
};

export type RichCitation = RichDocumentCitation | RichCaseCitation;

export type CitationDocIndex = Record<
    string,
    {
        document_id: string;
        filename: string;
        version_id?: string | null;
        version_number?: number | null;
    }
>;

export type CitationStreamStatus = "started" | "partial" | "final";
export type CitationSseEvent = {
    type: "citations";
    status: CitationStreamStatus;
    citations: RichCitation[];
};

export function citationSseEvent(
    status: CitationStreamStatus,
    citations: RichCitation[],
): CitationSseEvent {
    return { type: "citations", status, citations };
}

/**
 * Let a route adopt rich citations without breaking an older streaming engine.
 * It forwards started/partial snapshots, suppresses the engine's legacy final
 * `{ type: "citations" }` and its DONE marker, then emits one canonical final
 * snapshot after the route has resolved document and CourtListener metadata.
 */
export function createCitationSseBridge(write: (line: string) => void) {
    const parseSseData = (line: string): Record<string, unknown> | null => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return null;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") return null;
        try {
            const parsed = JSON.parse(payload);
            return isRecord(parsed) ? parsed : null;
        } catch {
            return null;
        }
    };

    return {
        write(line: string) {
            const trimmed = line.trim();
            if (trimmed === "data: [DONE]") return;
            const event = parseSseData(line);
            if (event?.type === "citations") {
                // Only partial snapshots can be trusted before routes enrich
                // the final document/case metadata.
                if (event.status === "started" || event.status === "partial") {
                    write(line);
                }
                return;
            }
            write(line);
        },
        finish(citations: RichCitation[]) {
            write(`data: ${JSON.stringify(citationSseEvent("final", citations))}\n\n`);
            write("data: [DONE]\n\n");
        },
    };
}

function normalizeCitationPage(value: unknown): number | string {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value === "string" && /^\d+\s*-\s*\d+$/.test(value.trim())) {
        return value.trim().replace(/\s*/g, "");
    }
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeCellLocator(row: Record<string, unknown>): { sheet?: string; cell?: string } {
    const sheet = cleanText(row.sheet, { max: 240 });
    const cell = cleanText(row.cell, { max: 240 });
    return {
        ...(sheet ? { sheet } : {}),
        ...(cell ? { cell } : {}),
    };
}

function citationRef(row: Record<string, unknown>): number | null {
    const marker =
        typeof row.marker === "string"
            ? Number(row.marker.match(/^\[(\d+)\]$/)?.[1])
            : NaN;
    const ref = typeof row.ref === "number" ? row.ref : marker;
    if (!Number.isFinite(ref) || ref <= 0) return null;
    return Math.floor(ref);
}

function normalizeDocumentQuotes(row: Record<string, unknown>): DocumentCitationQuote[] {
    if (!Array.isArray(row.quotes)) return [];
    return row.quotes
        .slice(0, MAX_CITATION_QUOTES)
        .flatMap((raw): DocumentCitationQuote[] => {
            if (!isRecord(raw)) return [];
            const quote = cleanText(raw.quote ?? raw.text, { max: 12_000 });
            if (!quote) return [];
            return [
                {
                    page: normalizeCitationPage(raw.page ?? row.page),
                    quote,
                    ...normalizeCellLocator({
                        sheet: raw.sheet ?? row.sheet,
                        cell: raw.cell ?? row.cell,
                    }),
                },
            ];
        });
}

function normalizeCaseQuotes(row: Record<string, unknown>): CaseCitationQuote[] {
    if (!Array.isArray(row.quotes)) return [];
    return row.quotes
        .slice(0, MAX_CITATION_QUOTES)
        .flatMap((raw): CaseCitationQuote[] => {
            if (!isRecord(raw)) return [];
            const quote = cleanText(raw.quote ?? raw.text, { max: 12_000 });
            if (!quote) return [];
            const opinionId =
                typeof raw.opinion_id === "number" && Number.isFinite(raw.opinion_id)
                    ? Math.floor(raw.opinion_id)
                    : typeof raw.opinionId === "number" && Number.isFinite(raw.opinionId)
                      ? Math.floor(raw.opinionId)
                      : null;
            return [
                {
                    opinionId,
                    type: cleanText(raw.type, { max: 300 }) ?? null,
                    author: cleanText(raw.author, { max: 300 }) ?? null,
                    quote,
                },
            ];
        });
}

export function normalizeRichCitation(value: unknown): ParsedRichCitation | null {
    if (!isRecord(value)) return null;
    const ref = citationRef(value);
    if (!ref) return null;
    const rawClusterId =
        typeof value.cluster_id === "number"
            ? value.cluster_id
            : typeof value.clusterId === "number"
              ? value.clusterId
              : Number.parseInt(String(value.cluster_id ?? value.clusterId ?? ""), 10);
    if (Number.isFinite(rawClusterId) && rawClusterId > 0) {
        const quotes = normalizeCaseQuotes(value);
        const fallbackQuote = cleanText(value.quote ?? value.text, { max: 12_000 });
        if (!quotes.length && !fallbackQuote) return null;
        return {
            kind: "case",
            ref,
            cluster_id: Math.floor(rawClusterId),
            quotes: quotes.length
                ? quotes
                : [{ opinionId: null, type: null, author: null, quote: fallbackQuote! }],
        };
    }

    const docId = cleanText(value.doc_id, { max: 300 });
    if (!docId) return null;
    const quotes = normalizeDocumentQuotes(value);
    const fallbackQuote = cleanText(value.quote ?? value.text, { max: 12_000 });
    if (!quotes.length && !fallbackQuote) return null;
    const primary = quotes[0] ?? {
        page: normalizeCitationPage(value.page),
        quote: fallbackQuote!,
        ...normalizeCellLocator(value),
    };
    return {
        kind: "document",
        ref,
        doc_id: docId,
        page: primary.page,
        quote: primary.quote,
        ...(primary.sheet ? { sheet: primary.sheet } : {}),
        ...(primary.cell ? { cell: primary.cell } : {}),
        quotes: quotes.length ? quotes : [primary],
    };
}

export function parseRichCitationsWithDiagnostics(text: string): {
    citations: ParsedRichCitation[];
    diagnostics: { hasBlock: boolean; rawLength: number; error: string | null };
} {
    const match = text.match(CITATIONS_BLOCK_RE);
    if (!match) {
        return { citations: [], diagnostics: { hasBlock: false, rawLength: 0, error: null } };
    }
    const raw = match[1] ?? "";
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return {
                citations: [],
                diagnostics: { hasBlock: true, rawLength: raw.length, error: "CITATIONS block JSON was not an array." },
            };
        }
        return {
            citations: parsed.map(normalizeRichCitation).filter((citation): citation is ParsedRichCitation => !!citation),
            diagnostics: { hasBlock: true, rawLength: raw.length, error: null },
        };
    } catch (error) {
        return {
            citations: [],
            diagnostics: {
                hasBlock: true,
                rawLength: raw.length,
                error: error instanceof Error ? error.message : String(error),
            },
        };
    }
}

/** Parse completed objects from an otherwise incomplete hidden citation stream. */
export function parsePartialRichCitationObjects(text: string): ParsedRichCitation[] {
    const afterOpen = text.includes(CITATIONS_OPEN_TAG)
        ? text.split(CITATIONS_OPEN_TAG).slice(1).join(CITATIONS_OPEN_TAG)
        : text;
    const beforeClose = afterOpen.split(CITATIONS_CLOSE_TAG)[0] ?? afterOpen;
    const arrayStart = beforeClose.indexOf("[");
    if (arrayStart < 0) return [];

    const parsed: ParsedRichCitation[] = [];
    let inString = false;
    let escaped = false;
    let depth = 0;
    let objectStart = -1;
    for (let index = arrayStart + 1; index < beforeClose.length; index += 1) {
        const character = beforeClose[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === "\\") {
            escaped = inString;
            continue;
        }
        if (character === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (character === "{") {
            if (depth === 0) objectStart = index;
            depth += 1;
        } else if (character === "}") {
            if (depth === 0) continue;
            depth -= 1;
            if (depth === 0 && objectStart >= 0) {
                try {
                    const citation = normalizeRichCitation(
                        JSON.parse(beforeClose.slice(objectStart, index + 1)),
                    );
                    if (citation) parsed.push(citation);
                } catch {
                    // A partially streamed or malformed object is intentionally ignored.
                }
                objectStart = -1;
            }
        } else if (character === "]" && depth === 0) {
            break;
        }
    }
    return parsed;
}

type CaseMetadata = {
    case_name: string | null;
    citation: string | null;
    url: string | null;
    pdfUrl: string | null;
    dateFiled: string | null;
};

function optionalText(value: unknown, max = 1_000): string | null {
    return cleanText(value, { max }) ?? null;
}

function recordCaseMetadata(
    metadata: Map<number, CaseMetadata>,
    raw: Record<string, unknown>,
) {
    const clusterRaw = raw.cluster_id ?? raw.clusterId;
    const clusterId =
        typeof clusterRaw === "number"
            ? clusterRaw
            : Number.parseInt(String(clusterRaw ?? ""), 10);
    if (!Number.isFinite(clusterId) || clusterId <= 0) return;
    const id = Math.floor(clusterId);
    const current = metadata.get(id) ?? {
        case_name: null,
        citation: null,
        url: null,
        pdfUrl: null,
        dateFiled: null,
    };
    metadata.set(id, {
        case_name: current.case_name ?? optionalText(raw.case_name ?? raw.caseName),
        citation: current.citation ?? optionalText(raw.citation),
        url: current.url ?? optionalText(raw.url, 2_000),
        pdfUrl: current.pdfUrl ?? optionalText(raw.pdfUrl ?? raw.pdf_url, 2_000),
        dateFiled: current.dateFiled ?? optionalText(raw.dateFiled ?? raw.date_filed, 100),
    });
}

function casesFromEvents(events: unknown): Map<number, CaseMetadata> {
    const metadata = new Map<number, CaseMetadata>();
    if (!Array.isArray(events)) return metadata;
    for (const raw of events) {
        if (!isRecord(raw)) continue;
        if (raw.type === "case_citation") recordCaseMetadata(metadata, raw);
        if (raw.type === "courtlistener_get_cases" && Array.isArray(raw.cases)) {
            for (const caseRow of raw.cases) {
                if (isRecord(caseRow)) recordCaseMetadata(metadata, caseRow);
            }
        }
        if (raw.type === "case_opinions" && isRecord(raw.case)) {
            recordCaseMetadata(metadata, {
                ...raw.case,
                cluster_id: raw.cluster_id,
            });
        }
    }
    return metadata;
}

export function createRichCitation(
    citation: ParsedRichCitation,
    docIndex: CitationDocIndex,
    caseMetadata: Map<number, CaseMetadata> = new Map(),
): RichCitation {
    if (citation.kind === "case") {
        const metadata = caseMetadata.get(citation.cluster_id) ?? {
            case_name: null,
            citation: null,
            url: null,
            pdfUrl: null,
            dateFiled: null,
        };
        return {
            type: "citation_data",
            kind: "case",
            ref: citation.ref,
            cluster_id: citation.cluster_id,
            ...metadata,
            quotes: citation.quotes,
        };
    }
    const info = docIndex[citation.doc_id];
    return {
        type: "citation_data",
        kind: "document",
        ref: citation.ref,
        doc_id: citation.doc_id,
        ...(info?.document_id ? { document_id: info.document_id } : {}),
        version_id: info?.version_id ?? null,
        version_number: info?.version_number ?? null,
        filename: info?.filename ?? citation.doc_id,
        page: citation.page,
        quote: citation.quote,
        ...(citation.sheet ? { sheet: citation.sheet } : {}),
        ...(citation.cell ? { cell: citation.cell } : {}),
        quotes: citation.quotes,
    };
}

export function extractRichCitations(
    fullText: string,
    docIndex: CitationDocIndex,
    events?: unknown,
): RichCitation[] {
    const { citations } = parseRichCitationsWithDiagnostics(fullText);
    const cases = casesFromEvents(events);
    const parsed = citations.length
        ? citations
        : parsePartialRichCitationObjects(fullText);
    return parsed.map((citation) => createRichCitation(citation, docIndex, cases));
}
