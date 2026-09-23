import assert from "node:assert/strict";
import test from "node:test";
import {
    EXEMPLAR_LIBRARY_FOLDER_ID,
    hasExemplarIntent,
    runExemplarSearchPreflight,
} from "../src/lib/exemplarSearch";
import type { OpenAIToolSchema } from "../src/lib/llm/types";

const messages = [{ role: "user", content: "Find me a good non compete agreement" }];
const search: OpenAIToolSchema = {
    type: "function",
    function: {
        name: "mcp_firm_documents_search_files_keyword_123",
        description: "Search files",
        parameters: { type: "object", required: ["query"], properties: { query: { type: "string" }, ancestor_folder_id: { type: "string" }, limit: { type: "integer", maximum: 200 }, fields: { type: "array", items: { type: "string" } } } },
    },
};
const list: OpenAIToolSchema = {
    type: "function",
    function: { name: "mcp_box_mcp_list_folder_content_by_f_123", description: "List folder", parameters: { type: "object", required: ["folder_id"], properties: { folder_id: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" }, fields: { type: "array", items: { type: "string" } } } } },
};
const reader: OpenAIToolSchema = {
    type: "function",
    function: { name: "mcp_box_mcp_get_file_content_123", description: "Read file", parameters: { type: "object", required: ["file_id"], properties: { file_id: { type: "string" } } } },
};
function result(value: unknown) {
    return { content: JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(value) }] } }), event: { status: "ok" } };
}
function file(id = "991", ancestor = EXEMPLAR_LIBRARY_FOLDER_ID) {
    return { type: "file", id, name: "Noncompete template.docx", path_collection: { entries: [{ type: "folder", id: "0", name: "All Files" }, { type: "folder", id: ancestor, name: "Docket Exemplar Library" }] }, modified_at: "2026-09-20T00:00:00Z" };
}

test("routes exemplar retrieval and formal drafting, including the actual noncompete conversation", () => {
    for (const request of [
        "Find me a good non compete agreement",
        "Can you give me an example non-compete?",
        "Dont we have some exemplars",
        "Draft an employment agreement",
        "Write a motion to compel",
        "Find a settlement template",
        "Find example briefs",
        "Draft a legal letter",
        "Prepare a legal memorandum",
        "Write a cease and desist",
        "Find example court filings",
        "Find example noncompetes",
        "Find sample motions",
    ]) assert.equal(hasExemplarIntent([{ role: "user", content: request }]), true, request);
    assert.equal(hasExemplarIntent([...messages, { role: "assistant", content: "Here is a law summary" }, { role: "user", content: "Do we have any examples?" }]), true);
});

test("pure legal questions and instructions to use supplied material do not authorize Box retrieval", () => {
    for (const request of [
        "Are noncompetes enforceable in Indiana?",
        "I need to know the law on noncompetes",
        "Find case law about a noncompete agreement",
        "Give an example Python function",
        "Write an email saying I will call tomorrow",
        "Use the provided document to draft the agreement",
        "Use the agreement I uploaded",
        "Use this NDA to draft an employment agreement",
        "Draft a noncompete without Box",
        "Don't search Box for a template",
        "No Box. Draft an agreement from scratch.",
    ]) assert.equal(hasExemplarIntent([...messages, { role: "user", content: request }]), false, request);
});

test("searches known library before reading candidates through caller's authorized executor", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const output = await runExemplarSearchPreflight({
        messages,
        tools: [search, reader],
        execute: async (name, args) => {
            calls.push({ name, args });
            if (name === reader.function.name) return result({ text: "Employee agrees to the following restrictions." });
            assert.equal(args.ancestor_folder_id, EXEMPLAR_LIBRARY_FOLDER_ID);
            assert.deepEqual(args.fields, ["id", "type", "name", "parent", "path_collection", "modified_at"]);
            return result({ entries: [file()], total_count: 1 });
        },
    });
    assert.equal(output.status, "searched");
    assert.equal(calls.length, 3);
    assert.equal(calls[0].name, search.function.name);
    assert.equal(calls[1].name, search.function.name);
    assert.equal(calls[2].name, reader.function.name);
    assert.equal(output.candidates.length, 1);
    assert.equal(output.candidates[0].readStatus, "read");
    assert.equal(output.candidates[0].text, "Employee agrees to the following restrictions.");
    assert.equal(output.candidates[0].membershipEvidence, "ancestor_path");
    assert.match(output.context, /does not prove that the library has no suitable exemplar/);
});

test("advertised tools without folder scoping cannot become unscoped searches", async () => {
    const unscoped: OpenAIToolSchema = { ...search, function: { ...search.function, parameters: { required: ["query"], properties: { query: { type: "string" } } } } };
    let calls = 0;
    const output = await runExemplarSearchPreflight({ messages, tools: [unscoped, reader], execute: async () => { calls++; return result({ entries: [] }); } });
    assert.equal(calls, 0);
    assert.equal(output.status, "unavailable");
    assert.match(output.context, /No supported folder-scoped/);
});

test("permission errors never become an empty-library conclusion or broad search", async () => {
    const invoked: Record<string, unknown>[] = [];
    const output = await runExemplarSearchPreflight({
        messages, tools: [search, list, reader],
        execute: async (_name, args) => {
            invoked.push(args);
            return { content: JSON.stringify({ ok: false, error: "Access denied" }), event: { status: "error" } };
        },
    });
    assert.equal(output.status, "unavailable");
    assert.equal(invoked.length, 3);
    assert.ok(invoked.every((args) => args.ancestor_folder_id === EXEMPLAR_LIBRARY_FOLDER_ID || args.folder_id === EXEMPLAR_LIBRARY_FOLDER_ID));
    assert.equal(output.candidates.length, 0);
    assert.match(output.context, /failed.*does not establish absence/i);
    assert.match(output.context, /access or coverage is unverified/);
});

test("partial folder listing supplies navigation and does not read arbitrary root files", async () => {
    const output = await runExemplarSearchPreflight({
        messages,
        tools: [search, list, reader],
        execute: async (name) => {
            assert.notEqual(name, reader.function.name);
            return name === search.function.name ? result({ entries: [], total_count: 0 }) : result({ entries: [file(), { type: "folder", id: "777", name: "Employment" }], total_count: 200 });
        },
    });
    assert.equal(output.status, "partial");
    assert.equal(output.candidates[0].readStatus, "not_read");
    assert.match(output.context, /subfolders have not been traversed/);
    assert.match(output.context, /Employment/);
});

test("scoped searches reject files with contradictory returned ancestry", async () => {
    const output = await runExemplarSearchPreflight({ messages, tools: [search, reader], execute: async (name) => {
        assert.equal(name, search.function.name);
        return result({ entries: [file("1991", "old-matter-folder")], total_count: 1 });
    } });
    assert.equal(output.status, "partial");
    assert.equal(output.candidates.length, 0);
    assert.match(output.context, /outside the exemplar library/);
});

test("truncation, pagination and candidate reading failures retain explicit limitations", async () => {
    const output = await runExemplarSearchPreflight({ messages, tools: [search, reader], execute: async (name) => {
        if (name === reader.function.name) return result({ isError: true, error: "Text representation is not available" });
        return result({ entries: [file()], total_count: 85, next_marker: "next" });
    } });
    assert.equal(output.status, "partial");
    assert.equal(output.candidates[0].readStatus, "failed");
    assert.equal(output.candidates[0].text, undefined);
    assert.match(output.context, /additional library results may exist/);
    assert.match(output.context, /has not been verified as a suitable exemplar/);
});

test("unknown required arguments prevent preflight from guessing API parameters", async () => {
    const changed: OpenAIToolSchema = { ...search, function: { ...search.function, parameters: { ...search.function.parameters, required: ["query", "tenant_id"] } } };
    const output = await runExemplarSearchPreflight({ messages, tools: [changed], execute: async () => { throw new Error("must not execute"); } });
    assert.equal(output.calls.length, 0);
    assert.equal(output.status, "unavailable");
});

test("cancellation stops before reads and opt-outs cause no calls", async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(runExemplarSearchPreflight({ messages, tools: [search, reader], signal: controller.signal, execute: async () => {
        calls++;
        controller.abort();
        return result({ entries: [file()] });
    } }), { name: "AbortError" });
    assert.equal(calls, 1);
    const output = await runExemplarSearchPreflight({ messages: [{ role: "user", content: "Use the attached document to draft this agreement" }], tools: [search, reader], execute: async () => { throw new Error("must not execute"); } });
    assert.equal(output.status, "not_required");
    assert.equal(output.context, "");
});

test("live Box SDK camelCase metadata and numeric IDs preserve ancestry, candidates and pagination", async () => {
    const output = await runExemplarSearchPreflight({ messages, tools: [search, reader], execute: async (name, args) => {
        if (name === reader.function.name) {
            assert.equal(args.file_id, "743588051504");
            return result({ text: "Employee promises to protect confidential information.", status: "partial", truncated: false, coverage: "PDF embedded text from 1 of 3 pages; scanned pages were not OCR-read." });
        }
        return result({ totalCount: 85, entries: [{ type: "file", id: 743588051504, name: "Employment agreement.pdf", pathCollection: { entries: [{ type: "folder", id: 0, name: "All Files" }, { type: "folder", id: 404340697581, name: "Docket Exemplar Library" }] }, modifiedAt: { value: "2026-09-20T00:00:00Z" } }] });
    } });
    assert.equal(output.status, "partial");
    assert.equal(output.candidates[0].id, "743588051504");
    assert.equal(output.candidates[0].membershipEvidence, "ancestor_path");
    assert.equal(output.candidates[0].modifiedAt, "2026-09-20T00:00:00Z");
    assert.equal(output.candidates[0].readPartial, true);
    assert.equal(output.candidates[0].textTruncated, false);
    assert.match(output.context, /scanned pages were not OCR-read/);
});

test("numeric folder references are retained without treating the root listing as exhaustive", async () => {
    const output = await runExemplarSearchPreflight({ messages, tools: [list], execute: async () => result({ totalCount: 1, entries: [{ type: "folder", id: 123456789, name: "Employment forms" }] }) });
    assert.equal(output.status, "partial");
    assert.match(output.context, /123456789/);
    assert.match(output.context, /Employment forms/);
});

test("returned collection size determines incomplete coverage even when the server lowers the requested limit", async () => {
    const output = await runExemplarSearchPreflight({ messages, tools: [search], execute: async () => result({ totalCount: 25, limit: 1, entries: [file()] }) });
    assert.equal(output.status, "partial");
    assert.match(output.context, /additional library results may exist/);
});

test("malformed successful responses are unverified rather than empty searches", async () => {
    const output = await runExemplarSearchPreflight({ messages, tools: [search], execute: async () => ({ content: "Unexpected response", event: { status: "ok" } }) });
    assert.equal(output.status, "partial");
    assert.match(output.context, /no inspectable result collection/);
});

test("noncompete preflight uses exact phrases and reads relevant titles ahead of noisy full-text results", async () => {
    const queries: unknown[] = [];
    const reads: unknown[] = [];
    const output = await runExemplarSearchPreflight({ messages, tools: [search, reader], execute: async (name, args) => {
        if (name === reader.function.name) {
            reads.push(args.file_id);
            return result({ text: "The parties agree to these employment restrictions." });
        }
        queries.push(args.query);
        return result({ totalCount: 5, entries: [
            { ...file("100"), name: "Non-Profit Conflict of Interest Policy.docx" },
            { ...file("101"), name: "Motion to Determine Competence.docx" },
            { ...file("102"), name: "Employment Agreement.docx" },
            { ...file("103"), name: "Executive Noncompetition Agreement.docx" },
            { ...file("104"), name: "Agreement.docx" },
        ] });
    } });
    assert.deepEqual(queries, ['"non-compete" OR "noncompete" OR "noncompetition"', '"restrictive covenant" OR "covenant not to compete"']);
    assert.deepEqual(reads, ["103", "102"]);
    assert.equal(output.candidates.length, 5);
    assert.equal(output.candidates[0].titleRelevance, "direct");
    assert.equal(output.candidates.find((candidate) => candidate.id === "100")?.readStatus, "not_read");
    assert.equal(output.candidates.find((candidate) => candidate.id === "104")?.readStatus, "not_read");
    assert.match(output.context, /retained as leads/);
});

test("irrelevant titles are retained without consuming automatic reading calls", async () => {
    const output = await runExemplarSearchPreflight({ messages, tools: [search, reader], execute: async (name) => {
        assert.equal(name, search.function.name);
        return result({ totalCount: 1, entries: [{ ...file(), name: "Non-Profit Bylaws.docx" }] });
    } });
    assert.equal(output.calls.length, 2);
    assert.equal(output.candidates.length, 1);
    assert.equal(output.candidates[0].readStatus, "not_read");
    assert.equal(output.candidates[0].titleRelevance, "unverified");
});
