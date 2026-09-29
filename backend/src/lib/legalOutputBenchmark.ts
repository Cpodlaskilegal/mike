import JSZip from "jszip";
import { evaluateLegalOutput, inspectLegalDocx, legalTextHash, LEGAL_OUTPUT_GATE_VERSION, type LegalClaim, type LegalSource, type LegalQualityReport, type LegalCheck } from "./legalOutputGate";

export type LegalBenchmarkCorpus = { version: string; synthetic: true; cases: { id: string; category: string; text: string; claims: LegalClaim[]; sources: LegalSource[]; expectedDecision: LegalQualityReport["decision"]; expectedField: string; expectedStatus: LegalCheck["status"]; docx?: "valid" | "malformed" | "missing" | "illegible" }[] };
export const LEGAL_BENCHMARK_CATEGORIES = ["wrong_authority", "false_quote", "bad_pinpoint", "missing_adverse_authority", "unsupported_fact", "truncated_source", "broken_docx_formatting"];
const REQUIRED_BLOCKING_CASES: Record<string, string> = {
    "authority-wrong": "authority_identity", "citation-wrong": "citation", "quotation-false": "quotation", "pinpoint-wrong": "pinpoint", "adverse-missing": "adverse_authority", "docx-malformed": "docx_structure", "docx-missing": "docx_structure", "docx-illegible": "docx_formatting",
};
const REQUIRED_CONTROL_CASES = ["authority-clean", "quotation-clean", "pinpoint-clean", "pinpoint-unmapped", "adverse-included", "fact-source-present", "fact-unsupported", "source-complete", "source-truncated", "docx-clean"];

export async function buildSyntheticLegalDocx(kind: "valid" | "malformed" | "missing" | "illegible"): Promise<Buffer> {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    if (kind !== "missing") zip.file("word/document.xml", kind === "malformed" ? '<w:document><w:body><w:p></w:body>' : `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r>${kind === "illegible" ? '<w:rPr><w:sz w:val="0"/></w:rPr>' : ""}<w:t>Synthetic draft.</w:t></w:r></w:p></w:body></w:document>`);
    return zip.generateAsync({ type: "nodebuffer" });
}

export async function runLegalOutputBenchmark(corpus: LegalBenchmarkCorpus) {
    const results: { id: string; category: string; passed: boolean; expectedDecision: LegalQualityReport["decision"]; report: LegalQualityReport }[] = [];
    for (const scenario of corpus.cases) {
        const artifactChecks = scenario.docx ? await inspectLegalDocx(await buildSyntheticLegalDocx(scenario.docx)) : undefined;
        const report = evaluateLegalOutput({ text: scenario.text, claims: scenario.claims, sources: scenario.sources, artifactChecks });
        const passed = report.decision === scenario.expectedDecision && report.checks.some((check) => check.field === scenario.expectedField && check.status === scenario.expectedStatus) && report.coverage.unchecked > 0;
        results.push({ id: scenario.id, category: scenario.category, passed, expectedDecision: scenario.expectedDecision, report });
    }
    const missingCategories = LEGAL_BENCHMARK_CATEGORIES.filter((category) => !results.some((result) => result.category === category));
    const duplicateIds = results.filter((result, index) => results.findIndex((other) => other.id === result.id) !== index).map((result) => result.id);
    const blockers = results.filter((result) => result.expectedDecision === "blocked");
    const controls = results.filter((result) => result.expectedDecision === "attorney_review");
    const metrics = {
        cases: results.length, passed: results.filter((result) => result.passed).length,
        demonstratedErrors: blockers.length, demonstratedErrorsBlocked: blockers.filter((result) => result.report.decision === "blocked").length,
        attorneyReviewControls: controls.length, controlsIncorrectlyBlocked: controls.filter((result) => result.report.decision === "blocked").length,
    };
    const failures = [
        ...(corpus.synthetic === true ? [] : ["Corpus must be synthetic."]),
        ...missingCategories.map((category) => `Missing category: ${category}`),
        ...duplicateIds.map((id) => `Duplicate scenario ID: ${id}`),
        ...(results.length >= 14 ? [] : ["At least 14 scenarios are required."]),
        ...(blockers.length > 0 && controls.length > 0 ? [] : ["Both blocking scenarios and attorney-review controls are required."]),
        ...results.filter((result) => !result.passed).map((result) => `Scenario failed: ${result.id}`),
        // Golden risk labels are code-owned, so changing a failing fixture's
        // expectation to unchecked cannot turn a known blocker into a pass.
        ...Object.entries(REQUIRED_BLOCKING_CASES).flatMap(([id, field]) => {
            const scenario = corpus.cases.find((item) => item.id === id);
            const actual = results.find((item) => item.id === id)?.report;
            return scenario?.expectedDecision === "blocked" && scenario.expectedField === field && scenario.expectedStatus === "error" && actual?.decision === "blocked" && actual.checks.some((check) => check.field === field && check.status === "error") ? [] : [`Required demonstrated error was weakened or missed: ${id}`];
        }),
        ...REQUIRED_CONTROL_CASES.flatMap((id) => {
            const scenario = corpus.cases.find((item) => item.id === id);
            const actual = results.find((item) => item.id === id)?.report;
            return scenario?.expectedDecision === "attorney_review" && actual?.decision === "attorney_review" ? [] : [`Required attorney-review control was removed or blocked: ${id}`];
        }),
    ];
    return { benchmarkVersion: corpus.version, gateVersion: LEGAL_OUTPUT_GATE_VERSION, corpusHash: legalTextHash(JSON.stringify(corpus)), passed: failures.length === 0, thresholds: { scenarioPassRate: 1, demonstratedErrorBlockRate: 1, controlFalsePositiveRate: 0 }, metrics, failures, results, limitation: "Synthetic deterministic regression results only; no live model quality, comprehensive legal correctness, rendered Word fidelity or production outcomes are measured." };
}
