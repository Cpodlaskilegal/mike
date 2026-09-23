import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorRow, Db, ToolCacheRow } from "../src/lib/mcp/types";

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.PGSSLMODE = "disable";
process.env.NODE_ENV = "test";

const connector = {
    id: "box-1", user_id: "user-1", name: "Box MCP", enabled: true,
    server_url: "https://mcp.box.com", tool_policy: { managedConnector: "box" },
} as ConnectorRow;
const tool = {
    id: "read-1", connector_id: "box-1", tool_name: "get_file_content",
    openai_tool_name: "mcp_box_get_file_content", enabled: true,
    requires_confirmation: false, annotations: { readOnlyHint: true },
} as ToolCacheRow;
const missingText = { isError: true, content: [{ type: "text", text: "Markdown or text representation is not available for this file" }] };

async function run(input: {
    upstream?: unknown;
    upstreamError?: Error;
    fallback?: unknown;
    toolName?: string;
    args?: Record<string, unknown>;
}) {
    const rows: Record<string, unknown>[] = [];
    const db = { from: () => ({ insert: (row: Record<string, unknown>) => {
        rows.push(row); return { error: null };
    } }) } as unknown as Db;
    let fallbackCalls = 0;
    const { executeResolvedMcpToolCall } = await import("../src/lib/mcp/servers");
    const result = await executeResolvedMcpToolCall({
        userId: "user-1", connector,
        tool: { ...tool, tool_name: input.toolName ?? tool.tool_name },
        args: input.args ?? { file_id: "12345678901" }, db,
        callTool: async () => {
            if (input.upstreamError) throw input.upstreamError;
            return input.upstream ?? missingText;
        },
        boxContentFallback: async (id) => {
            assert.equal(id, "12345678901"); fallbackCalls++;
            return input.fallback ?? { isError: false, source: "box_download_fallback", content: [{ type: "text", text: "Extracted agreement clauses" }] };
        },
    });
    return { result, rows, fallbackCalls };
}

test("missing Box text is recovered and audited against the exact file", async () => {
    const { result, rows, fallbackCalls } = await run({});
    assert.equal(fallbackCalls, 1);
    assert.equal(result.event.status, "ok");
    assert.match(result.content, /Extracted agreement clauses/);
    assert.deepEqual(rows[0].target_refs, { file_id: "12345678901", read_method: "download_fallback" });
    assert.match(result.event.result_summary!, /12345678901/);
});

test("Box access denials and successful content are never overridden", async () => {
    for (const upstream of [
        { isError: true, content: [{ type: "text", text: "Access denied (403)" }] },
        { isError: false, content: [{ type: "text", text: "Existing text" }] },
    ]) {
        const result = await run({ upstream });
        assert.equal(result.fallbackCalls, 0);
    }
});

test("a thrown missing-representation error uses the same bounded fallback", async () => {
    const { result, fallbackCalls } = await run({ upstreamError: new Error("Markdown or text representation is not available for this file") });
    assert.equal(fallbackCalls, 1);
    assert.equal(result.event.status, "ok");
});

test("failed extraction remains a failed read and does not become a recommendation", async () => {
    const { result } = await run({ fallback: { isError: true, content: [{ type: "text", text: "Unsupported format; document has not been read." }] } });
    assert.equal(result.event.status, "error");
    assert.match(result.content, /has not been read/);
});

test("scoped Box search audit retains the ancestor, without storing search text", async () => {
    const { rows, fallbackCalls } = await run({ toolName: "search_files_keyword", args: { query: "a confidential client query", ancestor_folder_id: "404340697581" }, upstream: { isError: false, content: [] } });
    assert.equal(fallbackCalls, 0);
    assert.deepEqual(rows[0].target_refs, { ancestor_folder_id: "404340697581" });
    assert.doesNotMatch(JSON.stringify(rows), /confidential client query/);
});
