# Anthropic model refresh and API assessment

Assessed September 15, 2026 against Docket's main assistant and current official Anthropic documentation. Context7 was consulted first; live documentation resolved its stale Sonnet 5 pricing information. Implementation sizes below are engineering estimates, not delivery commitments. Deployment evidence belongs in the release record.

## Model configuration in this refresh

| Current model | Claude API ID | Input / output per million tokens | Recommended Docket use |
| --- | --- | --- | --- |
| Fable 5.1 | `claude-fable-5-1` | $10 / $50 | Demanding research and document work |
| Opus 5 | `claude-opus-5` | $5 / $25 | Complex assistant work |
| Sonnet 5 | `claude-sonnet-5` | $2 / $10 | Faster assistant work and tabular review |
| Haiku 4.5 | `claude-haiku-4-5` | $1 / $5 | Short utility tasks |

Fable 5.1, Opus 5, and Sonnet 5 have 1M-token context windows and 128K maximum output; Haiku 4.5 has 200K context and 64K output. Mythos 5.1 remains restricted to Project Glasswing and is not offered as a normal Docket choice. The workload recommendations above are our assessment. [Models](https://platform.claude.com/docs/en/models/overview)

Sonnet 5's scheduled September price increase was canceled: $2/$10 is now standard. Fable 5.1 cache reads cost $0.25 per million tokens; its five-minute and one-hour cache writes remain $12.50 and $20. [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)

This release covers model selection, saved-setting compatibility, effort controls, request compatibility, and spend estimates. Sonnet 5 tabular completions now honor the caller's low effort while retaining the 2,048-token extraction limit. Fable 5.1 joins the current choices; existing model preferences and Docket's Astra default are preserved. Fable 5.1, Fable 5, Opus 5, and Sonnet 5 expose `low`, `medium`, `high`, `xhigh`, and `max`, defaulting to `high`. Docket raises its per-request output allowance from 16,384 to 64,000 only when the user explicitly selects `xhigh` or `max`. Thinking and visible text share this ceiling; it is not a budget for the entire assistant run. [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)

Fable 5.1 keeps thinking enabled. Its final synthesis request retains the original system prompt, tools, and prior messages, appends the closing instruction, and uses `tool_choice: none`. This matters because editing the prefix can invalidate signed thinking blocks. Forced tool choices `any` and `tool` are unsupported on Fable 5.1. [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/thinking#preserved-thinking)

## Recommended next work — not enabled by this release

### 1. Automatic prompt caching — small; first priority

`backend/src/lib/llm/claude.ts` repeatedly sends the same instructions, tools, and accumulated conversation. Its usage accounting already captures cache reads and writes, but requests do not set automatic `cache_control`.

Add top-level `cache_control: { type: "ephemeral" }` to interactive Claude requests, then verify actual cache hits on repeated synthetic tool turns. This targets repeated input cost and latency. Five-minute writes cost 25% above ordinary input; un-reused prefixes can cost more, so measure total cost rather than assuming every request benefits. Begin with interactive loops, keeping one-shot title generation out of the initial rollout. [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

### 2. Native structured outputs — small to medium; concrete reliability gap

`backend/src/routes/tabular.ts` already supplies JSON schemas through `completeText` for column prompts and extracted cells. The Claude completion adapter ignores `textFormat`, leaving those paths dependent on prose instructions and `JSON.parse`.

Map the existing schema to Claude's `output_config.format`, preserving application validation. Separately consider `strict: true` for a few critical document-editing tools after auditing their schemas. Do not enable strict mode across every MCP tool: current limits include 20 strict tools and 24 optional parameters per request. Native citation blocks and JSON output schemas cannot be combined; existing citation strings inside JSON can remain application-defined. Test refusals, output truncation, malformed fields, and case-sensitive enum handling. [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

### 3. Signed conversation compaction — medium to large; strongest continuity improvement

Current `compactChatHistory` in `backend/src/lib/chatTools.ts` retains a bounded suffix and short head/tail excerpts after approximately 180,000 characters. This can lose exact decisions and constraints. Claude state within a tool loop is richer, but `LlmMessage` and persisted chat history reduce later turns to text.

The September 14 on-demand compaction beta returns a signed summary block using `compaction: { type: "summarize" }` and header `compact-2026-09-04`. It can run separately while the conversation continues and preserve a recent tail. Implementation needs durable opaque provider blocks, concurrency checks before substituting a summary, usage accounting, and model-switch handling. Documents and images removed by compaction must be retrieved again. Keep source records, permissions, exact quotations, and document versions in Docket; summaries are working context. [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction#compact-on-demand-with-the-compaction-parameter)

### 4. Tool search and deferred loading — medium

`runLLMStream` currently combines built-in, workflow, research, mailbox, and all authorized user MCP tool schemas before each request. Defer rarely used tools and keep common document tools immediately available. The API still receives every definition; fewer definitions enter the model's context until discovered.

Keep execution, user authorization, approvals, and auditing in Docket's existing tool gateway. Add server-tool event handling and a tested fallback when discovery fails. Enable by verified model capability: the current compatibility table lists Fable 5.1 and Opus 5, but omits Sonnet 5. Measure selection accuracy with the actual authorized catalog before adoption. [Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)

### 5. Progress updates and per-turn steering — small to medium after state work

Docket already streams reasoning and tool events. The new `thinking.display: "updates"` beta could show concise progress without a reasoning summary during long Fable runs. It requires `thinking-display-updates-2026-08-18` and a distinct UI treatment for progress versus final answer. [Fable 5.1 changes](https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1)

Per-message effort changes on Fable 5.1 and Opus 5 can preserve the prompt cache, unlike top-level effort changes. This becomes useful once Docket persists native conversation blocks across user turns; it is not necessary for this release's fixed effort within each run. [Per-message effort](https://platform.claude.com/docs/en/build-with-claude/effort#per-message-effort-beta)

### 6. Native document citations — medium; pilot one retrieval path

Docket already has rich document, spreadsheet, and CourtListener citation contracts in `assistantContracts.ts`. Native Claude citations could attach source locations to text or PDF document blocks and map into those contracts. Plain-text citations use character locations; text PDFs use page locations. Scanned PDFs need extractable text, and DOCX/XLSX require conversion.

Start with a read-only document summary. Maintain Docket's quote verification and document-version identity; native citations locate supporting text but do not establish that a legal proposition is correct. [Citations](https://platform.claude.com/docs/en/build-with-claude/citations)

## Model-specific considerations

Fable 5.1 requires 30-day retention, as Fable 5 already did; zero data retention requires express Anthropic authorization. A successful model probe does not establish the firm's contractual arrangement. This release does not change retention settings. [API retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention#model-specific-data-retention-requirements)

Fable 5.1 text carries a statistical watermark without added hidden characters or organization-identifying data. Supported media retrieved from the Files API can carry signed Content Credentials. That does not require changing Docket's DOCX text handling. [Content provenance](https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1#content-provenance)

Anthropic identifies changed tendencies relevant to this app: fewer independent tool calls batched together, less retrieval at low effort, unmarked quotations in summaries, and whole-file rewrites for small edits. Docket already instructs fresh document reads and exact short citations. Add evaluation cases for quoted versus paraphrased sources, surgical tracked changes, missing evidence, and multi-source research before changing its prompts broadly. [Fable 5.1 prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1)

## Lower priority

Managed Agents now has session budgets, advisors, and server-evaluated permission policies; Files and Skills are generally available. These may help a future durable task or artifact worker, but they introduce a separate runtime and stored provider resources. Evaluate them as an additional execution option while Docket owns matter isolation, approvals, audit history, and work products. They are not prerequisites for the model refresh. [Release notes](https://platform.claude.com/docs/en/release-notes/overview), [Stateful API retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)

Recommended sequence: measure automatic caching, close the structured-output gap, then build durable Claude state and compaction. Pilot tool discovery and native citations against representative legal workflows before wider rollout.
