import assert from "node:assert/strict";
import test from "node:test";
import { followResolvedDocumentVersion } from "../src/app/lib/resolvedDocumentTabs";
import { readEditResolutionError } from "../src/app/lib/editResolutionError";
import type { AssistantSidePanelTab } from "../src/app/components/assistant/AssistantSidePanel";

test("resolved edits advance live edit views while citation/historical views remain pinned", () => {
    const tabs = [
        { kind: "document", id: "current", documentId: "doc", versionId: null, versionNumber: null },
        { kind: "document", id: "historical", documentId: "doc", versionId: "history", versionNumber: 1 },
        { kind: "citation", id: "citation", documentId: "doc", versionId: "source", versionNumber: 2 },
        { kind: "edit", id: "edit", documentId: "doc", versionId: "source", versionNumber: 2, edit: { edit_id: "e1", status: "pending", version_id: "source" } },
        { kind: "edit", id: "pending", documentId: "doc", versionId: "source", versionNumber: 2, edit: { edit_id: "e2", status: "pending", version_id: "source" } },
        { kind: "document", id: "unrelated", documentId: "other", versionId: null, versionNumber: null },
        { kind: "case", id: "case" },
    ] as unknown as AssistantSidePanelTab[];
    const updated = followResolvedDocumentVersion(tabs, { documentId: "doc", editId: "e1", status: "accepted", versionId: "resolved" });
    assert.equal((updated[0] as { versionId: string }).versionId, "resolved");
    assert.equal(updated[1], tabs[1]);
    assert.equal(updated[2], tabs[2]);
    assert.equal(updated[5], tabs[5]);
    assert.equal(updated[6], tabs[6]);
    assert.ok(updated[3].kind === "edit" && updated[3].edit.status === "accepted" && updated[3].versionId === "resolved");
    assert.ok(updated[4].kind === "edit" && updated[4].edit.status === "pending" && updated[4].versionId === "resolved");
    assert.ok(tabs[3].kind === "edit" && tabs[3].edit.status === "pending" && tabs[3].versionId === "source");
    const next = followResolvedDocumentVersion(updated, { documentId: "doc", editId: "e2", status: "rejected", versionId: "resolved-next" });
    assert.ok(next[0].kind === "document" && next[0].versionId === "resolved-next");
    assert.equal(next[1], tabs[1]);
});

test("edit failures expose actionable server recovery and handle proxy/non-JSON errors", async () => {
    const api = await readEditResolutionError(new Response(JSON.stringify({ detail: "Refresh, then retry the same decision." }), { status: 503 }));
    assert.equal(api.message, "Refresh, then retry the same decision.");
    const proxy = await readEditResolutionError(new Response("<h1>Service unavailable</h1>", { status: 503 }));
    assert.match(proxy.message, /Refresh the document/);
    assert.doesNotMatch(proxy.message, /<h1>/);
});
