import assert from "node:assert/strict";
import test from "node:test";
import { followResolvedProjectDocumentVersion } from "../src/app/lib/projectResolvedDocumentTabs";

test("project current/edit tabs follow successive immutable versions while history and citations stay pinned", () => {
  const tabs = [
    { documentId: "doc-1", versionId: null, view: "current" as const },
    { documentId: "doc-1", versionId: "track-v1", view: "edit" as const },
    { documentId: "doc-1", versionId: "history-v1", view: "historical" as const },
    { documentId: "doc-1", versionId: "quote-v1", view: "citation" as const },
    { documentId: "other", versionId: "other-v1", view: "current" as const },
  ];
  const first = followResolvedProjectDocumentVersion(tabs, { documentId: "doc-1", versionId: "resolved-v2" });
  const second = followResolvedProjectDocumentVersion(first, { documentId: "doc-1", versionId: "resolved-v3" });
  assert.equal(second[0].versionId, "resolved-v3");
  assert.equal(second[1].versionId, "resolved-v3");
  assert.equal(second[2], tabs[2]);
  assert.equal(second[3], tabs[3]);
  assert.equal(second[4], tabs[4]);
  assert.equal(tabs[0].versionId, null);
  assert.equal((second[0] as { refetchKey?: number }).refetchKey, 2);
});
