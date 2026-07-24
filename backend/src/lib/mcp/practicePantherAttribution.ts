export type McpActionKind = "read" | "mutation";

export type PracticePantherTargetRefs = {
    resourceType?: string;
    resourceId?: string;
    matterId?: string;
    accountId?: string;
};

export type PracticePantherAuditPhase =
    | "attempting"
    | "succeeded"
    | "failed"
    | "indeterminate";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MUTATION_NAME_RE =
    /(^|[_-])(post|put|patch|delete|create|update|upsert|send|write|remove|add|upload|move|copy|rename|share|invite|assign|link|unlink|archive|restore|approve|reject|cancel|submit|execute|run|trigger)/i;
const READ_NAME_RE =
    /(^|[_-])(get|list|search|find|read|retrieve|lookup|query|download|fetch|check|verify|view|status|describe|inspect|preview)/i;
const MAX_CONTEXT_VALUE_LENGTH = 500;
const MAX_RESULT_WALK_NODES = 500;

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function nonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function contextValue(value: unknown): string | null {
    const text = nonEmptyString(value);
    if (!text) return null;
    return text.replace(/[\r\n]+/g, " ").slice(0, MAX_CONTEXT_VALUE_LENGTH);
}

export function normalizeDocketActorEmail(value: unknown): string | null {
    const email = nonEmptyString(value)?.toLowerCase() ?? null;
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
        return null;
    }
    return email;
}

export function docketActorTag(actorEmail: string): string {
    return `Docket actor: ${actorEmail}`;
}

export function classifyMcpAction(
    toolName: string,
    args: Record<string, unknown>,
    annotations?: Record<string, unknown> | null,
): McpActionKind {
    if (toolName.toLowerCase() === "pp_api_request") {
        const method = nonEmptyString(args.method)?.toUpperCase();
        return method && READ_METHODS.has(method) ? "read" : "mutation";
    }
    if (
        annotations?.destructiveHint === true ||
        annotations?.readOnlyHint === false ||
        MUTATION_NAME_RE.test(toolName)
    ) {
        return "mutation";
    }
    if (annotations?.readOnlyHint === true || READ_NAME_RE.test(toolName)) {
        return "read";
    }
    // Unknown tools fail safe as mutations. A false "read" classification is
    // the only outcome that could bypass actor attribution.
    return "mutation";
}

function schemaHasTags(
    inputSchema: Record<string, unknown> | null | undefined,
) {
    const properties = record(inputSchema?.properties);
    return (
        !!properties && Object.prototype.hasOwnProperty.call(properties, "tags")
    );
}

function withActorTag(value: unknown, actorTag: string): string[] | null {
    if (!Array.isArray(value)) return null;
    const tags = value.filter((tag): tag is string => typeof tag === "string");
    if (!tags.some((tag) => tag.toLowerCase() === actorTag.toLowerCase())) {
        tags.push(actorTag);
    }
    return tags;
}

/**
 * Add actor attribution only where doing so cannot discard existing tags.
 * Creates can safely receive a new tags array; updates receive the actor tag
 * only when the caller already supplied tags. Every mutation is separately
 * recorded in a PracticePanther audit note, including untaggable resources.
 */
export function tagPracticePantherMutationArgs(
    toolName: string,
    args: Record<string, unknown>,
    inputSchema: Record<string, unknown> | null | undefined,
    actorEmail: string,
): Record<string, unknown> {
    const tagged: Record<string, unknown> = { ...args };
    const actorTag = docketActorTag(actorEmail);
    const suppliedTags = withActorTag(args.tags, actorTag);
    const isCreate = /(^|[_-])(post|create)/i.test(toolName);

    if (suppliedTags) tagged.tags = suppliedTags;
    else if (isCreate && schemaHasTags(inputSchema)) tagged.tags = [actorTag];

    if (toolName.toLowerCase() === "pp_api_request") {
        const body = record(args.body);
        if (body) {
            const bodyTags = withActorTag(body.tags, actorTag);
            if (bodyTags) tagged.body = { ...body, tags: bodyTags };
        }
    }
    return tagged;
}

function idFromRef(value: unknown): string | null {
    const ref = record(value);
    return ref ? nonEmptyString(ref.id) : null;
}

function applyRefKeys(
    value: Record<string, unknown>,
    refs: PracticePantherTargetRefs,
) {
    const matterId =
        nonEmptyString(value.matter_id) ??
        nonEmptyString(value.matterId) ??
        idFromRef(value.matter_ref) ??
        idFromRef(value.matterRef);
    const accountId =
        nonEmptyString(value.account_id) ??
        nonEmptyString(value.accountId) ??
        idFromRef(value.account_ref) ??
        idFromRef(value.accountRef);
    if (!refs.matterId && matterId) refs.matterId = matterId;
    if (!refs.accountId && accountId) refs.accountId = accountId;
}

function parseTextContent(result: unknown): unknown[] {
    const out: unknown[] = [];
    const resultRecord = record(result);
    const content = Array.isArray(resultRecord?.content)
        ? resultRecord.content
        : [];
    for (const block of content) {
        const blockRecord = record(block);
        const text = blockRecord ? nonEmptyString(blockRecord.text) : null;
        if (!text) continue;
        try {
            out.push(JSON.parse(text));
        } catch {
            // Non-JSON text does not contain reliable PracticePanther locators.
        }
    }
    return out;
}

function resultCandidates(result: unknown): unknown[] {
    const resultRecord = record(result);
    return [
        resultRecord?.structuredContent,
        resultRecord?.result,
        ...parseTextContent(result),
    ].filter((value) => value !== undefined && value !== null);
}

function walkForRefs(value: unknown, refs: PracticePantherTargetRefs) {
    const queue: Array<{ value: unknown; depth: number }> = [
        { value, depth: 0 },
    ];
    const seen = new Set<object>();
    let visited = 0;
    while (queue.length && visited < MAX_RESULT_WALK_NODES) {
        const next = queue.shift()!;
        visited += 1;
        if (next.depth > 6 || !next.value || typeof next.value !== "object") {
            continue;
        }
        if (seen.has(next.value as object)) continue;
        seen.add(next.value as object);
        if (Array.isArray(next.value)) {
            for (const child of next.value) {
                queue.push({ value: child, depth: next.depth + 1 });
            }
            continue;
        }
        const objectValue = next.value as Record<string, unknown>;
        applyRefKeys(objectValue, refs);
        for (const child of Object.values(objectValue)) {
            queue.push({ value: child, depth: next.depth + 1 });
        }
    }
}

function pathRefs(path: string | null, refs: PracticePantherTargetRefs) {
    if (!path) return;
    const match = path.match(
        /\/(accounts|matters)\/([0-9a-f-]{8,})(?:\/|\?|$)/i,
    );
    if (!match) return;
    if (match[1].toLowerCase() === "matters") refs.matterId ??= match[2];
    else refs.accountId ??= match[2];
}

export function extractPracticePantherTargetRefs(
    toolName: string,
    args: Record<string, unknown>,
    result?: unknown,
): PracticePantherTargetRefs {
    const refs: PracticePantherTargetRefs = {};
    const resourceType = nonEmptyString(toolName.split("_")[0]);
    if (resourceType && toolName.toLowerCase() !== "pp_api_request") {
        refs.resourceType = resourceType;
    }
    applyRefKeys(args, refs);
    const body = record(args.body);
    if (body) applyRefKeys(body, refs);
    const query = record(args.query);
    if (query) applyRefKeys(query, refs);

    const directId =
        nonEmptyString(args.id__query) ??
        nonEmptyString(args.id) ??
        (body ? nonEmptyString(body.id) : null);
    if (directId) refs.resourceId = directId;

    const resourceKey = resourceType?.toLowerCase();
    if (directId && resourceKey === "matters") refs.matterId ??= directId;
    if (directId && resourceKey === "accounts") refs.accountId ??= directId;

    if (toolName.toLowerCase() === "pp_api_request") {
        const path = nonEmptyString(args.path);
        pathRefs(path, refs);
        const pathType =
            path?.match(/\/api\/v2\/([^/?]+)/i)?.[1] ??
            path?.match(/^\/?([^/?]+)/)?.[1];
        if (pathType) refs.resourceType = pathType;
    }

    for (const candidate of resultCandidates(result)) {
        const candidateRecord = record(candidate);
        if (!refs.resourceId && candidateRecord) {
            refs.resourceId = nonEmptyString(candidateRecord.id) ?? undefined;
        }
        walkForRefs(candidate, refs);
    }
    return refs;
}

function auditStatusLabel(phase: PracticePantherAuditPhase) {
    if (phase === "succeeded") return "SUCCEEDED";
    if (phase === "failed") return "FAILED";
    if (phase === "indeterminate") return "OUTCOME UNCERTAIN";
    return "ATTEMPTING";
}

export function buildPracticePantherAuditNote(params: {
    actionId: string;
    actorEmail: string;
    toolName: string;
    phase: PracticePantherAuditPhase;
    timestamp: string;
    refs: PracticePantherTargetRefs;
    attachToTarget: boolean;
    context?: {
        chatId?: string | null;
        assistantMessageId?: string | null;
        assistantRunId?: string | null;
        traceId?: string | null;
        projectId?: string | null;
        toolCallId?: string | null;
    };
    error?: string | null;
}): Record<string, unknown> {
    const status = auditStatusLabel(params.phase);
    const lines = [
        "Docket assistant action audit",
        `Actor email: ${params.actorEmail}`,
        `Status: ${status}`,
        `Action: ${params.toolName}`,
        `Action ID: ${params.actionId}`,
        `UTC timestamp: ${params.timestamp}`,
    ];
    const values: Array<[string, unknown]> = [
        ["Resource type", params.refs.resourceType],
        ["Resource ID", params.refs.resourceId],
        ["Matter ID", params.refs.matterId],
        ["Account ID", params.refs.accountId],
        ["Docket project ID", params.context?.projectId],
        ["Docket chat ID", params.context?.chatId],
        ["Docket assistant message ID", params.context?.assistantMessageId],
        ["Docket assistant run ID", params.context?.assistantRunId],
        ["Docket tool call ID", params.context?.toolCallId],
        ["Docket trace ID", params.context?.traceId],
    ];
    for (const [label, rawValue] of values) {
        const value = contextValue(rawValue);
        if (value) lines.push(`${label}: ${value}`);
    }
    const error = contextValue(params.error);
    if (error) lines.push(`Error: ${error}`);
    lines.push(
        "PracticePanther uses a shared API identity. The actor email above is the authenticated Docket session user responsible for this assistant action.",
    );

    const note: Record<string, unknown> = {
        subject: `[Docket] ${status}: ${params.toolName}`.slice(0, 255),
        note: lines.join("\n"),
        date: params.timestamp,
        tags: ["Docket", "Docket Assistant", docketActorTag(params.actorEmail)],
    };
    if (params.attachToTarget && params.refs.accountId) {
        note.account_ref = { id: params.refs.accountId };
    }
    if (params.attachToTarget && params.refs.matterId) {
        note.matter_ref = { id: params.refs.matterId };
    }
    return note;
}

export function mcpCallFailed(result: unknown): boolean {
    return record(result)?.isError === true;
}

export function mcpCallErrorMessage(result: unknown): string {
    const resultRecord = record(result);
    const blocks = Array.isArray(resultRecord?.content)
        ? resultRecord.content
        : [];
    const messages = blocks
        .map((block) => contextValue(record(block)?.text))
        .filter((value): value is string => !!value);
    return (
        messages.join(" ").slice(0, MAX_CONTEXT_VALUE_LENGTH) ||
        "MCP tool call failed."
    );
}

export function extractPracticePantherNoteId(result: unknown): string | null {
    const envelopeId = (value: unknown, depth = 0): string | null => {
        if (depth > 4) return null;
        if (Array.isArray(value)) {
            return value.length === 1 ? envelopeId(value[0], depth + 1) : null;
        }
        const valueRecord = record(value);
        if (!valueRecord) return null;
        const direct = nonEmptyString(valueRecord.id);
        if (direct) return direct;
        for (const key of ["result", "data", "value", "note", "item"]) {
            const nested = envelopeId(valueRecord[key], depth + 1);
            if (nested) return nested;
        }
        return null;
    };

    for (const candidate of resultCandidates(result)) {
        const id = envelopeId(candidate);
        if (id) return id;
    }
    return null;
}
