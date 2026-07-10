import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

test("turn-scoped document reads share an identity and are invalidated by an edit", async () => {
    const {
        clearTurnReadsForDocument,
        duplicateReadDocumentResult,
        getTurnReadIdentity,
    } = await import("../src/lib/chatTools");

    const docStore = new Map([
        [
            "doc-1",
            {
                filename: "Agreement.docx",
                file_type: "docx",
                storage_path: "documents/user/doc-1/current.docx",
            },
        ],
    ]);
    const docIndex = {
        "doc-1": {
            document_id: "document-1",
            filename: "Agreement.docx",
            version_id: "version-1",
        },
    };

    const first = await getTurnReadIdentity({ docLabel: "doc-1", docStore, docIndex });
    const second = await getTurnReadIdentity({ docLabel: "doc-1", docStore, docIndex });

    assert.ok(first);
    assert.ok(second);
    assert.equal(first.key, second.key);
    const reads = new Map([[first.key, first]]);
    assert.equal(reads.has(second.key), true);

    const duplicate = JSON.parse(duplicateReadDocumentResult(second));
    assert.equal(duplicate.already_read, true);
    assert.equal(duplicate.document_id, "document-1");
    assert.match(duplicate.next_required_action, /find_in_document/);

    clearTurnReadsForDocument(reads, "document-1");
    assert.equal(reads.size, 0);
});
