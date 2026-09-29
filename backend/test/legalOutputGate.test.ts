import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createLegalQualityState, evaluateLegalOutput, extractLegalDocumentClaims, finalizeLegalOutput, legalTextHash, parseLegalClaims, recordLegalDocumentSource } from "../src/lib/legalOutputGate";
import { runLegalOutputBenchmark, type LegalBenchmarkCorpus } from "../src/lib/legalOutputBenchmark";

const corpus = JSON.parse(readFileSync(new URL("./fixtures/legal-output-benchmark.json", import.meta.url), "utf8")) as LegalBenchmarkCorpus;

test("synthetic legal release benchmark covers all seven risks and both valid/invalid drafts", async () => {
    const report = await runLegalOutputBenchmark(corpus);
    assert.equal(report.passed, true, JSON.stringify(report.failures));
    assert.equal(report.metrics.cases, 18);
    assert.equal(report.metrics.passed, 18);
    assert.equal(report.metrics.demonstratedErrorsBlocked, report.metrics.demonstratedErrors);
    assert.equal(report.metrics.controlsIncorrectlyBlocked, 0);
    for (const result of report.results) {
        assert.ok(result.report.checks.some((check) => check.field === "adverse_authority_search" && check.status === "unchecked"));
        assert.ok(result.report.checks.some((check) => check.field === "current_law_and_treatment" && check.status === "unchecked"));
    }
});

test("release gate fails measured regressions and missing corpus coverage", async () => {
    const changed = structuredClone(corpus);
    changed.cases.find((scenario) => scenario.id === "quotation-false")!.claims[0].quote = "Notice must be served before judgment.";
    const failed = await runLegalOutputBenchmark(changed);
    assert.equal(failed.passed, false);
    assert.ok(failed.failures.includes("Scenario failed: quotation-false"));
    assert.equal((await runLegalOutputBenchmark({ ...corpus, cases: corpus.cases.filter((scenario) => scenario.category !== "false_quote") })).passed, false);
});

test("a failing fixture cannot evade release thresholds by relabeling its expected error unchecked", async () => {
    const changed = structuredClone(corpus);
    const falseQuote = changed.cases.find((scenario) => scenario.id === "quotation-false")!;
    falseQuote.sources[0].completeness = "partial";
    falseQuote.sources[0].locators = {};
    falseQuote.expectedDecision = "attorney_review";
    falseQuote.expectedStatus = "unchecked";
    const report = await runLegalOutputBenchmark(changed);
    assert.equal(report.results.find((result) => result.id === "quotation-false")?.passed, true, "local fixture expectation now agrees with an unchecked result");
    assert.equal(report.passed, false, "code-owned demonstrated-error contract must still fail release");
    assert.ok(report.failures.includes("Required demonstrated error was weakened or missed: quotation-false"));
});

test("a model cannot mark its own source, false quotation, or coverage verified", () => {
    const source = corpus.cases[0].sources[0];
    const claims = parseLegalClaims([{ id: "false", sourceId: source.id, quote: "Notice is never required.", verified: true, source: "Notice is never required.", completeness: "complete" }]);
    const report = evaluateLegalOutput({ text: "Notice is never required.", claims, sources: [source] });
    assert.equal(report.decision, "blocked");
    assert.equal("verified" in claims[0], false);
    assert.equal("source" in claims[0], false);
});

test("source/page coverage comes from the server read, and truncation cannot be certified complete", () => {
    const state = createLegalQualityState();
    recordLegalDocumentSource(state, "doc-0", "Synthetic record.pdf", "[Page 1]Notice required.\n[Page 2]A waiver excuses notice.", 10);
    const report = evaluateLegalOutput({ text: "Notice required.", claims: [{ id: "page", sourceId: "doc-0", quote: "Notice required.", pinpoint: "2" }], sources: state.sources.values() });
    assert.equal(report.decision, "blocked");
    assert.equal(report.coverage.sources[0].completeness, "partial");
    assert.ok(report.checks.some((check) => check.field === "source_coverage" && check.status === "unchecked"));
    assert.match(report.coverage.sources[0].textHash, /^[0-9a-f]{64}$/);
});

test("native case and document citations are checked even without the optional manifest tool", () => {
    const state = createLegalQualityState();
    state.sources.set("case-101:201", corpus.cases[0].sources[0]);
    const draft = 'Notice is never required. [1]<CITATIONS>[{"ref":1,"cluster_id":101,"quotes":[{"opinion_id":201,"quote":"Notice is never required."}]}]</CITATIONS>';
    const result = finalizeLegalOutput(draft, state);
    assert.equal(result.report.decision, "blocked");
    assert.doesNotMatch(result.text, /Notice is never required/);
    assert.equal(extractLegalDocumentClaims(draft)[0].sourceId, "case-101:201");
});

test("a successful manifest cannot be reused after the proposed text changes", () => {
    const state = createLegalQualityState();
    const text = "Original draft";
    state.sources.set("case-101:201", corpus.cases[0].sources[0]);
    state.manifests.set(legalTextHash(text), corpus.cases[0].claims);
    assert.ok(finalizeLegalOutput(text, state).report.coverage.verified > 0);
    const changed = finalizeLegalOutput("Changed draft", state);
    assert.equal(changed.report.coverage.verified, 0);
    assert.ok(changed.report.checks.some((check) => check.field === "claim_inventory" && check.status === "unchecked"));
});

test("a valid quotation spanning PDF pages is checked as two mapped passages", () => {
    const state = createLegalQualityState();
    recordLegalDocumentSource(state, "doc-0", "Synthetic pages.pdf", "[Page 41]Notice must be\n[Page 42]served before judgment.", 1000);
    const text = 'Notice must be served before judgment.[1]<CITATIONS>[{"ref":1,"doc_id":"doc-0","page":"41-42","quote":"Notice must be[[PAGE_BREAK]]served before judgment."}]</CITATIONS>';
    const report = finalizeLegalOutput(text, state).report;
    assert.equal(report.decision, "attorney_review");
    assert.equal(report.coverage.claims, 2);
    assert.equal(report.checks.filter((check) => check.field === "pinpoint" && check.status === "verified").length, 2);
});

test("unknown source and unsupported facts remain explicit attorney-review items", () => {
    const report = evaluateLegalOutput({ text: "The package arrived May 1.", claims: [{ id: "fact", kind: "fact", sourceId: "not-retrieved", text: "The package arrived May 1." }], sources: [] });
    assert.equal(report.decision, "attorney_review");
    assert.equal(report.coverage.errors, 0);
    assert.ok(report.checks.some((check) => check.field === "source" && check.status === "unchecked"));
});

test("empty quotations and unreadable text do not manufacture verified source support", () => {
    const source = corpus.cases[0].sources[0];
    const report = evaluateLegalOutput({ text: "Draft", claims: [{ id: "empty", sourceId: source.id, quote: "   ", pinpoint: "10" }], sources: [source] });
    assert.equal(report.coverage.verified, 0);
    assert.equal(report.decision, "attorney_review");
    assert.ok(report.checks.some((check) => check.field === "quotation" && check.status === "unchecked"));
    assert.deepEqual(extractLegalDocumentClaims('<CITATIONS>[{"doc_id":"doc-0","quote":"   "}]</CITATIONS>'), []);
    const state = createLegalQualityState();
    recordLegalDocumentSource(state, "doc-0", "Scanned synthetic.pdf", "[Page 1] \n[Page 2] ", 1000);
    assert.equal(state.sources.get("doc-0")?.completeness, "unavailable");
});

test("edited or abridged legal quotations remain unchecked instead of creating a false positive", () => {
    const source = corpus.cases[0].sources[0];
    const report = evaluateLegalOutput({ text: "Notice ... judgment.", claims: [{ id: "abridged", sourceId: source.id, quote: "Notice ... judgment.", pinpoint: "10" }], sources: [source] });
    assert.equal(report.decision, "attorney_review");
    assert.ok(report.checks.some((check) => check.field === "quotation" && check.status === "unchecked"));
    assert.ok(report.checks.some((check) => check.field === "pinpoint" && check.status === "unchecked"));
});

test("release CLI exits nonzero on an actual fixture expectation regression", () => {
    const temp = mkdtempSync(resolve(tmpdir(), "docket-legal-gate-"));
    try {
        const fixture = resolve(temp, "bad-corpus.json");
        const changed = structuredClone(corpus);
        changed.cases[0].expectedDecision = "blocked";
        writeFileSync(fixture, JSON.stringify(changed));
        const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/legal-quality-gate.ts", "--corpus", fixture], { cwd: resolve(__dirname, ".."), encoding: "utf8", timeout: 30_000 });
        assert.equal(cli.status, 1, cli.stderr);
        assert.match(cli.stdout, /"passed": false/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
});
