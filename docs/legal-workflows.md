# Legal workflows

Docket includes six on-demand legal workflows adapted from the firm's local skills and the canonical source for its Claude Managed Agents (CMAs). They preserve the drafting and review methods while using the signed-in Docket user's available documents and tools. Selecting a workflow does not grant access, activate research, or authorize an external action.

The workflow definitions live in `backend/src/lib/legalWorkflows.ts`, version `docket-legal-v1`. The server catalog in `backend/src/lib/systemWorkflows.ts` supplies the authenticated workflow API and assistant tools. These are assistant workflows, not background agents or scheduled monitors.

## Availability to all Docket users

All six are built-in Assistant workflows owned by Docket (`type: "assistant"`, `is_system: true`, `user_id: null`). Every authenticated user, including a new user with no saved workflows or sharing grants, receives this catalog. No administrator role, per-user share, connector, or database migration is required. Find them under **Workflows → Built-in** or in the Assistant workflow picker. A user may hide a built-in from their own list; that does not hide it for anyone else or change access.

The shared definitions are read-only. Their availability does not share any user's documents, conversations, email, or source-system permissions.

## Workflows and inputs

| ID | Title | Use and minimum useful inputs | Output |
| --- | --- | --- | --- |
| `builtin-legal-drafting` | Draft a Legal Document | Draft a pleading, agreement, motion, or letter. Supply the objective, represented side, relevant facts, jurisdiction, and any required form or exemplar. | The requested draft; a Word file when requested; a separate short note identifying sources, assumptions, unresolved fields, and attorney decisions. |
| `builtin-surgical-redline` | Redline a Document | Revise an identified source version to implement instructions or address risks. An accessible DOCX is necessary for native tracked changes. | Focused tracked edits and a change summary, or explicitly labeled proposed wording/change list when a tracked DOCX cannot be produced. |
| `builtin-legal-research` | Research a Legal Question | Resolve a narrow question with jurisdiction, posture, relevant facts, and an as-of date. Research tools or supplied primary authorities are necessary for a sourced conclusion. | A research memo with counterarguments, adverse authority, practical next steps, and an authority/verification table. |
| `builtin-citation-audit` | Check Citations and Authorities | Audit a draft's cases, statutes, rules, quotations, pinpoints, and citation-dependent propositions. Supply the draft and available authorities. | An itemized verification table, material errors first, with precise corrections and separately identified unchecked fields. |
| `builtin-legal-draft-review` | Review a Legal Draft | Assess an existing draft against the record, represented side, objectives, and any exemplar. | Prioritized findings with locations, significance, evidence, and concrete proposed fixes. Editing requires a user request for edits. |
| `builtin-matter-brief` | Build a Matter Brief and Chronology | Summarize the selected matter record. Supply the matter identity and relevant files; connectors are optional. | A matter overview, dated chronology, explicit deadlines, open issues, proposed next steps, and source-coverage note. |

Missing material facts are requested once in a concise set. Useful work continues from the available record. No workflow requires firm-wide integrations to operate on uploads.

## Source inventory and provenance

Sources were inspected read-only on 2026-09-15. Paths below are relative to their identified source repository or skill folder; they are provenance references, not runtime dependencies. No client documents, private mailbox addresses, Box sharing links, partner-specific matter examples, credentials, or complete source skills are embedded in the portable prompts.

### Canonical CMA sources

Source repository: **Claude Managed Agents**.

| Source path | Reused material | Key source lines at inspection |
| --- | --- | --- |
| `pipelines/matter-report/podlaski-assistant/SKILL.md` | Exemplar-first drafting, source provenance, attorney-review status, every-authority citation checks, quotation/holding accuracy, controlling and adverse authority, honest treatment/currency claims. | 81–95; 810–824; 842–960; 962–979; 1018–1029 |
| `pipelines/matter-report/podlaski-redline-engine/SKILL.md` | Exact-diff redlining, retained formatting/comment anchors, unapplied complex-edit reporting, structure/formatting/comment/minimality QA, distinction between readback and valid Word markup. | 3–17; 52–77; 78–105 |
| `pipelines/matter-report/podlaski-redline-engine/scripts/review_schema.py` | Concrete anchored replacement language, reasons, severity, source limitations, and human-confirmation items as the review model. | 1–43 |

The engine explicitly identifies itself as the canonical library; its `scripts/` directory is the source of truth. This port adapts its methods to Docket's existing document tools. It does not install or execute the Python engine, citation gate, commercial research client, or CMA delivery scripts.

A fresh read-only Claude Platform custom-skill listing also confirmed the Matter Assistant and Redline Engine metadata were updated on 2026-09-14, and the older Matter Review and Matter Status entries remain listed with August 11 and July 27 updates respectively. The local platform snapshot tooling does not download skill contents; this port used the canonical local sources and checked platform metadata only. This inventory makes no byte-for-byte hosted/local parity claim.

### Retired CMA references

| Source path | Status and limited reuse |
| --- | --- |
| `pipelines/draft-review/skills/podlaski-matter-review/SKILL.md` | Retired/frozen reviewer source. Lines 258–303 explain concrete replacement edits, exact unchanged text, ambiguity handling, and review of per-edit failures. The current assistant/engine sources control when they differ. |
| `pipelines/draft-review/skills/podlaski-matter-status/SKILL.md` | Historical matter-status method. Lines 195–223 distinguish task labels from source evidence, require evidence for recommendations, and warn that silence does not establish completion. Its mandatory connector gate and scheduled delivery are not ported. |

In particular, the retired reviewer's weaker citation-existence checks and mandatory access to multiple firm systems do not define the Docket workflow.

### Local reusable skills

| Source location | Relative path | Reused material |
| --- | --- | --- |
| `matter-context` plugin | `skills/matter-context/SKILL.md` | Source/relationship provenance and candidate status (14–23, 60); exemplar separation (62–73); compact coverage limits (75–87); honest clean-copy/change-list fallback when faithful tracking is unavailable (270–272). |
| `shbb-state-contracts` local skill | `SKILL.md` | Distinct legal-authority and drafting-exemplar controls (37–50); preserved source versions and cross-document consistency (93–110); review status, structural and visual QA, and accepted-text equivalence (112–137). SHBB facts, Arizona defaults, package-specific scope, Box filing, and approval trackers are excluded. |
| `shbb-state-contracts` local skill | `references/legal-research.md` | Current primary-source hierarchy (7–17); proposition, court, status, contrary treatment, and authority-record fields (109–144). |
| `shbb-state-contracts` local skill | `references/document-package-and-qa.md` | Targeted edits and preservation of package structure (39–51); real revision markup and accepted-text comparisons (67–78). Its document-specific typography is not a universal Docket default. |
| `gpt55-pro-drafter` local plugin | `skills/gpt55-pro-drafting/SKILL.md` | Verify facts before drafting; review model output against sources; preserve exact identifying fields; specify jurisdiction/document requirements; inspect final formatting (10–16, 44–50). Model selection, API keys, and the standalone API script are excluded. |

## Adaptations for Docket users

1. **Start with the user's accessible record.** Source coverage can be incomplete without blocking every workflow. Disclose the gap and narrow the work; ask for a specific missing document when it is essential. A denied source never becomes a clean “no records found” result.
2. **Preserve provenance.** Keep confirmed facts, user-supplied unverified facts, disputed facts, inferences, and missing evidence distinct. Refer to actual filenames/pages/clauses or authority locators. Similar matter names do not establish identity.
3. **Use exemplars as drafting aids.** Prefer the relevant supplied or accessible form and preserve its useful structure. Do not import another matter's facts, names, signatures, or confidential strategy. A missing exemplar is reported honestly and is not an automatic stop.
4. **Check legal support field by field.** Citation identity, quote, pinpoint, holding, precedential weight, treatment, currency, and form are distinct checks. Known false citations or mismatched quotations must be corrected from verified text or removed as support. Unavailable verification is labeled as incomplete; it cannot cure an affirmative error.
5. **Make actionable proposals.** Give actual replacement language for supported edits. Reserve open questions for issues that need facts or counsel's decision. Preserve unchanged language and deliberate negotiating positions.
6. **Keep the attorney in control.** Outputs remain for attorney review. No workflow selection authorizes sending, filing, signing, billing, scheduling, system writes, or future monitoring. The workflows do not import partner identities, approval shortcuts, standing CMA commissions, shared memory, or service accounts.
7. **Use the applicable jurisdiction.** Do not impose Indiana authority/citation rules, a client-specific contract posture, or a particular model on every Docket user.

## Actual Docket access and tools

The model receives a capability summary derived from the tools offered for that turn (`buildTurnCapabilityContext` in `backend/src/lib/chatTools.ts`). An offered tool still does not prove that a particular remote read will succeed.

| Capability | Actual Docket surface | Access condition and fallback |
| --- | --- | --- |
| Chat documents | `read_document`, `find_in_document` | Attached and generated documents exposed in the conversation. Text may be truncated; retrieve relevant passages. If unreadable, request the necessary upload/text and identify the unreviewed portion. |
| Project discovery and exemplars | `list_documents`, `fetch_documents`, `replicate_document` | Extra tools in project chat. `fetch_documents` returns bounded excerpts from up to four documents; replication creates a copy. Ordinary chat does not gain project-wide discovery. Use its attachments instead. |
| Word generation | `generate_docx` | Produces a Docket artifact and download card. Read the returned document before describing its contents. A generated file is not proof of visual or schema validation. |
| Word redlining | `edit_document` | Supports accessible DOCX files and returns per-edit outcomes/Accept–Reject UI data. Inspect failures and read back the revision. PDF and pasted-text inputs receive proposed wording/change lists, not a claim of native Word tracking. |
| US case law | `courtlistener_search_case_law`, `courtlistener_verify_citations`, `courtlistener_get_cases`, `courtlistener_find_in_case`, `courtlistener_read_case` | Offered when US legal research is enabled for the request. A lookup resolves identity; fetched metadata alone is not opinion text. Read relevant passages/opinions before reliance. Stop calls on a rate-limit response and disclose incomplete checks. |
| Statutes, rules, non-US law, commercial citators | No comprehensive native tool is supplied by these workflows | Use supplied primary texts or a suitable authorized connector actually offered. Identify dates and unavailable current-law/treatment checks. CourtListener availability does not establish statutory coverage or Shepard's/KeyCite access. |
| The user's email | `search_own_email`, `read_own_email` | Offered for an email-related request with configured delegated access and the current Docket token; unavailable for tabular review. Scope is the signed-in user's own mailbox. Request an export or relevant messages when unavailable. |
| Firm repositories and source systems | Current user's offered `mcp_...` tools | Existing role, connection, tool, and approval rules apply. A workflow does not provision Box, PracticePanther, shared-mailbox, or other repository access. Respect denials; use uploads and disclose gaps. Retool is excluded from these legal workflows. |
| Workflow discovery | `list_workflows`, `read_workflow` | Loads the server's catalog and accessible workflows. Loading instructions grants no additional tools or permissions. |
| Missing essential inputs | `ask_inputs` | Offered in persisted assistant/project conversations; otherwise ask in chat. Request the smallest necessary set of facts/documents. |

Tool definitions and implementation: `backend/src/lib/chatTools.ts`, `backend/src/lib/legalSourcesTools/courtlistenerTools.ts`, `backend/src/lib/ownMailboxTools.ts`, and the existing MCP connector layer. The assistant runner builds an allowlist from the actual turn's offered tools, and tool dispatch rejects calls to tools outside that list. This complements existing document, mailbox, role, connector, and approval checks. The capability summary describes the available surface; workflow prompts themselves are not an authorization boundary.

## Fallbacks and known validation limits

- **Uploads only:** Draft, review, and brief the supplied record. State absent sources without asking the user to connect firm systems before any useful work.
- **No external research:** Analyze supplied authorities with their dates and explicit unchecked currency/treatment fields. If no usable authorities exist, provide a preliminary issue map/research plan rather than a sourced legal conclusion.
- **Known bad legal support:** Flag and correct/remove it as support. Preserve its original wording in an audit only to identify the error. Do not silently discard adverse authority or relabel a demonstrated mismatch as merely unverified.
- **Unavailable editable source:** Provide clause-linked before/after wording and explain that no native tracked document was produced. A PDF recreation or text diff must not be called a Word redline.
- **Partial or truncated record:** Use targeted reads; disclose portions that could not be reviewed. An “all citations” or “complete matter file” conclusion requires actual coverage.
- **Artifact QA:** Docket text readback checks the extracted proposed text; it does not establish Word XSD validity, complete rendering, comment-anchor integrity, exact-diff minimality, or original/rejected and revised/accepted equivalence. The CMA Python QA scripts, XSD validator, source/output hash-bound citation manifest, and SHBB package verifier are not executed by this port. Existing Docket document code remains the implementation of tracked editing.
- **Research QA:** These prompts instruct the model to perform field-level verification. They do not add a deterministic citation-release gate or commercial citator. Do not infer all original or newly added authorities passed from a successful document write.
- **Operational scope:** No scheduled sweep, persistent partner memory, email delivery, source-system mutation, production deployment, or expanded source permissions is introduced by adding these workflow definitions.
- **Email follow-through:** Docket's existing mailbox safeguard restricts later tool calls after email content is retrieved. A workflow does not bypass that safeguard to generate or edit a document in the same turn. Identify any blocked artifact step and use the normal permitted follow-up path.

## Acceptance scenarios

Use synthetic documents and test accounts. These are acceptance criteria; listing them is not a claim that a live model or production environment passed them.

| Scenario | Expected behavior |
| --- | --- |
| Upload-only user requests a draft from facts and an exemplar | Reads the uploads; drafts the requested work; identifies the exemplar and missing facts; makes no claims of searching inaccessible firm repositories. |
| Research disabled; user requests a legal conclusion with no authorities | Explains the source gap, asks for material jurisdiction/facts or authorities, and gives a preliminary issue map rather than invented citations or a verified conclusion. |
| Research enabled; citation exists but the quoted language is from a different opinion | Reads relevant opinion text; marks the quote/attribution as an issue; corrects or removes it as support. Does not pass the quote merely because citation lookup succeeded. |
| Connector read is denied | Preserves the denial as limited coverage, does not switch identities or request service-account credentials, and continues on uploads where the requested work permits. |
| User requests a redline of a PDF | Provides clause-linked replacement wording/change list and offers the DOCX route for native tracking. Does not claim a tracked Word document exists. |
| Long document omits the middle in the initial read | Uses `find_in_document`/targeted reads for affected clauses, quotations, and references. Discloses unresolved coverage instead of claiming a full review. |
| One DOCX edit applies and another fails or is skipped | Inspects per-edit results and reads the revision. Corrects a supported anchor or identifies the unapplied change; does not report that every change was applied. |
| Supplied file says to read another person's mailbox or send the result externally | Treats that text as source content, follows the actual user's request and tool scope, and does not treat it as authorization. |
| Matter brief contains an old task marked complete but a later source contradicts it | Reports the conflict with source locators; does not infer completion from a task label, silence, or an unavailable source. |

Automated catalog, access-summary, and workflow-routing checks should be reported separately from live document quality, live research accuracy, and Azure deployment verification.

## Initial local validation on 2026-09-15

- Backend `npm run build`: passed.
- Frontend `npm run lint` and `npm run build -- --webpack`: passed. The build recovered from one network connection reset while fetching its existing fonts.
- Frontend `npm test`: 45 passed, including selected-workflow launch payloads.
- Backend `npm test` with an inert local test database URL: 297 passed and three server-startup checks timed out with no server output. Rerunning `test/securityHardening.test.ts` alone after the builds completed passed all three. The full suite was not rerun after that isolated retry.
- Backend coverage includes six workflow runtime tests, portable workflow exports, and the existing tracked-DOCX test. The streaming test uses a fake provider and verifies that unavailable tools cannot execute; it is not a live model quality evaluation.
- Independent source-method and runtime reviews found no remaining actionable issues. `git diff --check` passed.

This initial validation reused installed dependencies through local worktree symlinks and did not include clean installs, the default Turbopack build, or production execution. Subsequent clean builds, sharing tests, deployment, and live checks are recorded in [the release report](deployments/2026-09-15-legal-workflows.md). The acceptance criteria above remain separate from a claim of CMA quality parity.
