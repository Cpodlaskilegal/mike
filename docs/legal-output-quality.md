# Legal output evidence and release gate

DCK-005 adds a deterministic evidence gate and a synthetic regression benchmark. The gate compares citation identity, literal quotations and mapped locators against source text/metadata actually retrieved in the current assistant turn. Known mismatches block Word generation, proposed edits and final source-backed assistant text. A blocked final response is replaced before its content or citation payload reaches the browser or saved message. All answer/citation chunks are held until completion, because a later source tool may reveal a contradiction in pre-tool text. Ordinary answers are then released unchanged; legal/source-backed answers first receive the evidence report. Reasoning and tool activity continue to stream. Safe partial work still survives interruption, with an explicit incomplete-response check when legal evidence was involved.

Every result is **for attorney review**. `attorney_review` means no demonstrated error in the checks performed. It never means correct law, a fully verified draft, complete factual support, or a validated Word layout. The visible evidence card remains outside the collapsed activity history, shows errors first, exposes unchecked fields and identifies source coverage. Reports are persisted in assistant events alongside the output and source SHA-256 hashes.

After a process restart, recovered provider completions carry an explicit unchecked source-recovery report. Retrieval evidence is turn-local and cannot be assumed to have survived; recovered legal text must be reviewed against sources again. Assistant, project and tabular-chat views expose the report.

## Evidence and checks

`backend/src/lib/legalOutputGate.ts` owns the check logic. `chatTools.ts` collects evidence through authorized `read_document`, `fetch_documents`, `find_in_document`, `courtlistener_read_case` and `courtlistener_find_in_case` calls. The model cannot supply the gate's source text, authority metadata, completeness flags or checked status. The model supplies only a claim inventory to `check_legal_output` or `legal_claims` on Word generation/editing. A standalone draft manifest is bound to the exact draft hash and is not reused for changed final wording.

The final gate also extracts Docket's structured `<CITATIONS>` document and case quotations without requiring the optional manifest tool. Unstructured citations, unnamed claims and malformed/missing citation inventories remain explicitly unchecked. This is a bounded, transparent check, not an exhaustive parser of every legal assertion. Check reports identify the claim count and each field checked, rather than calling an entire citation verified after an existence lookup.

| Field | Performed check | Limits |
| --- | --- | --- |
| Authority identity/citation | Exact normalized match to retrieved authority metadata | Requires a claim with source ID and retrieved metadata; opinion text alone is not citation metadata. |
| Quotation | Exact occurrence in retrieved text after whitespace/typographic-quote normalization | Semantic equivalents, editorial brackets and ellipses are not certified; edited or abridged quotations remain unchecked. Empty quotes and unreadable extraction cannot establish support. Absence in a partial source is unchecked, not a demonstrated false quotation. |
| Pinpoint | Quotation occurs at a locator mapped by retrieval | PDF `[Page N]` markers are extraction pages. Reporter pages, paragraph numbers and unmapped locators are unchecked. |
| Facts | Explicit support item for attorney review | Even identical words do not prove factual truth, context or entailment. Unsupported facts are visible unchecked items. |
| Adverse authority | Synthetic/attorney-required authority must be mentioned | Production retrieval does not identify the full universe of adverse authority. Comprehensive adverse search and substantive treatment always remain unchecked. |
| DOCX | ZIP/CRC, required package parts, XML syntax, Word body and nonpositive explicit font/page sizes | No full OOXML schema validation, visual rendering, comment/revision equivalence, signature layout, typography or exemplar-fidelity certification. |

Holding/application, precedential weight, current law/treatment, comprehensive adverse-authority search and claims outside the inventory are always explicit unchecked fields. Native media and MCP sources outside the implemented retrieval adapter are not silently counted as checked evidence. Truncated/excerpt retrieval remains partial in coverage, even if the server can verify a specific quote from the full extracted source. No live client data or commercial research/citator calls are used by the benchmark.

## Measured release check

Run from the repository root:

```bash
npm exec --prefix backend -- tsx --test backend/test/legalOutputGate.test.ts backend/test/legalOutputRuntime.test.ts
npm run legal:quality-gate --prefix backend -- --report ../artifacts/legal-quality.json
```

The versioned JSON corpus in `backend/test/fixtures/legal-output-benchmark.json` contains synthetic authorities, records and deliberately defective outputs. It covers wrong authority/citation, false quotation, wrong and unmapped pinpoints, omitted known adverse authority, unsupported factual assertion, truncated sources, malformed/missing DOCX parts and a zero-size font. Clean controls, limited-source cases and unsupported-fact warnings are also evaluated. DOCX fixtures are actual ZIP packages passed through the same structural gate used in production.

Release thresholds are 100% expected scenario outcomes, 100% blocking of demonstrated errors, and zero blocked attorney-review controls. All 18 baseline scenarios, all seven categories and unique IDs are required. The eight demonstrated-error and ten control contracts are also code-owned, so changing a failing fixture's expected error to unchecked cannot produce a passing release. A changed outcome, missing category, malformed corpus or regression exits nonzero. The report includes measured counts, per-case findings, gate/corpus versions, corpus hash, source/output hashes, validator/integration source hashes, Git SHA, time and Node version. These measurements cover the deterministic validator, not provider/model drafting quality, live research coverage or rendered Word fidelity.

`.github/workflows/legal-quality.yml` runs the behavioral tests and measured gate on every pull request and main-branch push, retaining the JSON measurement as a CI artifact. Make `legal-quality` a required branch/deployment check in repository settings; branch protection is an external repository setting, not something this source file enforces. Manual production releases must run the same check before deployment. No production migration is needed for these event-based reports.

Implementation reference: the installed `fast-xml-parser` validator checks XML syntax, rather than document-specific business rules ([official library](https://github.com/NaturalIntelligence/fast-xml-parser)). ZIP checking uses JSZip's CRC option ([official documentation](https://github.com/Stuk/jszip/blob/main/documentation/api_jszip/load_async.md)).
