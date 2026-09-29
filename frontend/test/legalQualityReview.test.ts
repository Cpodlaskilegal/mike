import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LegalQualityBlock } from "../src/app/components/assistant/message/EventBlocks";
import type { AssistantEvent } from "../src/app/components/shared/types";

const event: Extract<AssistantEvent, { type: "legal_quality" }> = {
    type: "legal_quality", target: "Synthetic draft", report: {
        version: "docket-legal-gate-v1", outputHash: "a".repeat(64), decision: "attorney_review",
        coverage: { claims: 1, verified: 1, errors: 0, unchecked: 2, sources: [{ id: "doc-0", label: "Synthetic record.pdf", completeness: "partial", textHash: "b".repeat(64), characters: 25 }] },
        checks: [{ claimId: "a1", field: "quotation", status: "verified", detail: "Quoted words occur in source." }, { claimId: "a1", field: "source_coverage", status: "unchecked", detail: "Source was truncated." }, { claimId: "output", field: "current_law_and_treatment", status: "unchecked", detail: "No citator was queried." }],
        limitations: ["For attorney review. No general legal correctness certification."],
    },
};

test("legal review card exposes incomplete coverage and unchecked law without claiming full verification", () => {
    const html = renderToStaticMarkup(createElement(LegalQualityBlock, { event }));
    assert.match(html, /Attorney review required/);
    assert.match(html, /1 checked fields, 0 errors, 2 unchecked/);
    assert.match(html, /current law and treatment/);
    assert.match(html, /Source was truncated/);
    assert.match(html, /Synthetic record.pdf/);
    assert.match(html, /partial/);
    assert.match(html, /does not establish legal correctness/);
    assert.doesNotMatch(html, /All citations verified/);
});

test("demonstrated errors open the report and escape source-supplied markup", () => {
    const blocked = structuredClone(event);
    blocked.report.decision = "blocked";
    blocked.report.coverage.errors = 1;
    blocked.report.checks.push({ claimId: "bad", field: "quotation", status: "error", detail: '<script>alert("source")</script>' });
    const html = renderToStaticMarkup(createElement(LegalQualityBlock, { event: blocked }));
    assert.match(html, /<details open=""/);
    assert.match(html, /blocked release/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});
