import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildSyntheticLegalDocx } from "../src/lib/legalOutputBenchmark";
import type { StreamChatParams } from "../src/lib/llm";

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

async function streamFixture(provider: (params: StreamChatParams, lines: string[], store: import("../src/lib/chatTools").DocStore) => Promise<unknown>, emptyTurn = false) {
    const sourcePath = fileURLToPath(new URL("../src/lib/chatTools.ts", import.meta.url));
    const moduleRequire = createRequire(sourcePath);
    const lines: string[] = [];
    const syntheticDocx = await buildSyntheticLegalDocx("valid");
    const docStore: import("../src/lib/chatTools").DocStore = emptyTurn ? new Map() : new Map([["doc-0", { filename: "Synthetic record.docx", file_type: "docx", storage_path: "synthetic.docx" }]]);
    let writes = 0;
    const isolatedRequire = Object.assign((id: string) => {
        if (id === "./storage") return { ...moduleRequire(id), downloadFile: async () => Uint8Array.from(syntheticDocx).buffer, uploadFile: async () => { writes++; throw new Error("Artifact write must be blocked."); } };
        if (id === "./mcpConnectors") return { ...moduleRequire(id), buildUserMcpTools: async () => [] };
        if (id === "./llm") return { ...moduleRequire(id), streamChatWithTools: (params: StreamChatParams) => provider(params, lines, docStore) };
        return moduleRequire(id);
    }, { resolve: moduleRequire.resolve });
    const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
    const isolatedModule = { exports: {} };
    new Function("require", "module", "exports", "__dirname", "__filename", compiled.outputText)(isolatedRequire, isolatedModule, isolatedModule.exports, dirname(sourcePath), sourcePath);
    const api = isolatedModule.exports as typeof import("../src/lib/chatTools");
    const execute = () => api.runLLMStream({ apiMessages: [{ role: "system", content: "" }, { role: "user", content: emptyTurn ? "Please help me." : "Draft from this synthetic record." }], docStore, docIndex: {}, userId: "synthetic-user", db: { from() { throw new Error("No database calls allowed."); } } as any, write: (line) => lines.push(line), model: "test-provider" });
    return { api, execute, lines, getWrites: () => writes };
}

test("pre-tool contradictory text cannot escape before a late source retrieval activates the gate", async () => {
    const fixture = await streamFixture(async (params, lines, store) => {
        params.callbacks.onContentDelta("Invented quotation [1]");
        params.callbacks.onToolCallStart?.({ name: "read_document", id: "late-read" });
        assert.equal(lines.some((line) => line.includes("Invented quotation")), false);
        // Simulate a newly discovered/created document becoming available
        // after the original prompt; the real reader extracts its bytes.
        store.set("doc-0", { filename: "Synthetic record.docx", file_type: "docx", storage_path: "synthetic.docx" });
        await params.runTools!([{ id: "late-read", name: "read_document", input: { doc_id: "doc-0" } }]);
        params.callbacks.onContentDelta('<CITATIONS>[{"ref":1,"doc_id":"doc-0","quote":"Invented quotation"}]</CITATIONS>');
        return { fullText: "", toolCalls: [] };
    }, true);
    const result = await fixture.execute();
    assert.doesNotMatch(result.fullText, /Invented quotation/);
    assert.equal(fixture.lines.some((line) => line.includes("Invented quotation")), false);
    assert.ok(result.events.some((event) => event.type === "legal_quality" && event.report.decision === "blocked"));
});

test("ordinary partial work remains recoverable without an unrelated legal report", async () => {
    const fixture = await streamFixture(async (params, lines) => {
        params.callbacks.onContentDelta("A useful partial answer.");
        assert.equal(lines.some((line) => line.includes("partial answer")), false);
        throw new Error("Synthetic provider interruption");
    }, true);
    await assert.rejects(fixture.execute(), (error: unknown) => {
        assert.ok(error instanceof fixture.api.AssistantStreamFailureError);
        assert.equal(error.fullText, "A useful partial answer.");
        assert.equal(error.events.some((event) => event.type === "legal_quality"), false);
        return true;
    });
    assert.ok(fixture.lines.some((line) => line.includes("A useful partial answer.")));
});

test("final stream with a false native source quotation publishes no contradictory content or citation", async () => {
    const wrong = 'The source says an invented thing. [1]<CITATIONS>[{"ref":1,"doc_id":"doc-0","page":1,"quote":"an invented thing"}]</CITATIONS>';
    const fixture = await streamFixture(async (params, lines) => {
        await params.runTools!([{ id: "read-1", name: "read_document", input: { doc_id: "doc-0" } }]);
        params.callbacks.onContentDelta(wrong.slice(0, 33));
        params.callbacks.onContentDelta(wrong.slice(33));
        assert.equal(lines.some((line) => line.includes('"type":"content_delta"')), false, "legal content must wait for server evidence checks");
        return { fullText: wrong, toolCalls: [] };
    });
    const result = await fixture.execute();
    assert.doesNotMatch(result.fullText, /invented thing/);
    assert.ok(result.events.some((event) => event.type === "legal_quality" && event.report.decision === "blocked"));
    assert.equal(fixture.lines.some((line) => line.includes("invented thing")), false);
    assert.ok(fixture.lines.some((line) => line.includes('"type":"citations","citations":[]')));
});

test("a Word tool refuses wrong evidence before writing the package or database", async () => {
    const fixture = await streamFixture(async (params) => {
        await params.runTools!([{ id: "read-1", name: "read_document", input: { doc_id: "doc-0" } }]);
        const result = await params.runTools!([{ id: "docx-1", name: "generate_docx", input: { title: "Synthetic pleading", sections: [{ content: "Invented quotation" }], legal_claims: [{ id: "q1", sourceId: "doc-0", quote: "Invented quotation" }] } }]);
        const payload = JSON.parse(result[0].content);
        assert.equal(payload.legal_quality.decision, "blocked");
        assert.match(payload.error, /blocked/);
        params.callbacks.onContentDelta("The draft requires a corrected quotation.");
        return { fullText: "The draft requires a corrected quotation.", toolCalls: [] };
    });
    const result = await fixture.execute();
    assert.equal(fixture.getWrites(), 0);
    assert.equal(result.events.some((event) => event.type === "doc_created"), false);
    assert.ok(result.events.some((event) => event.type === "legal_quality" && event.target === "Synthetic pleading" && event.report.decision === "blocked"));
});

test("safe partial source-backed work survives provider failure with coverage and durable events", async () => {
    const safe = "The retrieved source is a synthetic draft. Further analysis is incomplete.";
    const fixture = await streamFixture(async (params) => {
        await params.runTools!([{ id: "read-1", name: "read_document", input: { doc_id: "doc-0" } }]);
        params.callbacks.onContentDelta(safe);
        throw new Error("Synthetic provider interruption");
    });
    await assert.rejects(fixture.execute(), (error: unknown) => {
        assert.ok(error instanceof fixture.api.AssistantStreamFailureError);
        assert.equal(error.fullText, safe);
        assert.ok(error.events.some((event) => event.type === "content" && event.text === safe));
        assert.ok(error.events.some((event) => event.type === "doc_read"));
        assert.ok(error.events.some((event) => event.type === "legal_quality" && event.report.checks.some((check) => check.field === "response_completion" && check.status === "unchecked")));
        return true;
    });
    assert.ok(fixture.lines.some((line) => line.includes(safe)));
});

test("contradictory partial work is withheld on provider failure while retrieved activity remains", async () => {
    const wrong = 'Invented quotation [1]<CITATIONS>[{"ref":1,"doc_id":"doc-0","quote":"Invented quotation"}]</CITATIONS>';
    const fixture = await streamFixture(async (params) => {
        await params.runTools!([{ id: "read-1", name: "read_document", input: { doc_id: "doc-0" } }]);
        params.callbacks.onContentDelta(wrong);
        throw new Error("Synthetic provider interruption");
    });
    await assert.rejects(fixture.execute(), (error: unknown) => {
        assert.ok(error instanceof fixture.api.AssistantStreamFailureError);
        assert.doesNotMatch(error.fullText, /Invented quotation/);
        assert.ok(error.events.some((event) => event.type === "doc_read"));
        assert.ok(error.events.some((event) => event.type === "legal_quality" && event.report.decision === "blocked"));
        return true;
    });
    assert.equal(fixture.lines.some((line) => line.includes("Invented quotation")), false);
});
