# Docket GPT-5.6 Family and Reasoning Controls Design

**Date:** 2026-07-10
**Status:** Conversational design approved; written specification awaiting review

## Outcome

Upgrade Docket's main OpenAI assistant from GPT-5.5 to the GPT-5.6 family. The
main composer will offer GPT-5.6 Sol, Terra, and Luna, all supported reasoning
efforts, and a separate Standard/Pro mode control. Sol with medium effort in
Standard mode is the default. Title generation, tabular extraction, and
tabular chat remain on their separately configured role-specific models rather
than inheriting the new main-assistant default.

The release must preserve Docket's Responses API tool loop, custom SSE contract,
document authorization, legal prompts, saved chat format, and other provider
choices. It must also preserve historical spend data and report the actual
provider model used rather than merely the client selection.

## Evidence and current state

- Docket currently exposes `gpt-5.5-pro`, `gpt-5.5`, `gpt-5.4`, and
  `gpt-5.4-mini` in the main assistant and defaults to `gpt-5.5`.
- The backend already uses `openai.responses.create` for streaming and
  non-streaming requests. The browser consumes Docket's own SSE event
  vocabulary and does not call OpenAI directly.
- Live calls with a new key in the selected firm organization/project returned
  HTTP 200 for `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` in Standard
  mode. Pro-mode calls also returned HTTP 200 for all three models. A streamed
  Sol call with a function tool, `strict: false`, and
  `parallel_tool_calls: true` completed successfully.
- OpenAI identifies Sol as the frontier-capability model, Terra as the balanced
  intelligence/cost model, and Luna as the efficient high-volume model. The
  `gpt-5.6` alias currently resolves to Sol, but Docket will use explicit model
  IDs.
- GPT-5.6 Pro is an execution mode selected with `reasoning.mode: "pro"`; it is
  not a separate provider model slug.
- The installed OpenAI SDK is 6.35.0. The current 6.46.0 release types GPT-5.6
  reasoning mode and `max` effort.
- Tabular chat currently omits a model and therefore inherits
  `DEFAULT_MAIN_MODEL`. The implementation must stop that accidental coupling
  before changing the main default.

## User experience

### Model control

The OpenAI section of the main-chat model picker will contain:

1. **GPT-5.6 Sol** — frontier quality; default.
2. **GPT-5.6 Terra** — balanced quality and cost.
3. **GPT-5.6 Luna** — faster, lower-cost, high-volume work.

GPT-5.5 and the GPT-5.4 main-chat choices will no longer be displayed. Claude
and Gemini choices remain unchanged. GPT-5.4 Mini and Nano remain available in
the existing tabular/title settings where they serve a different workload.

### Reasoning control

When a GPT-5.6 model is selected, the composer will show an adjacent reasoning
control with all supported values:

- None
- Low
- Medium
- High
- X-High
- Max

`minimal` remains in Docket's generic legacy type but is intentionally not a
GPT-5.6 picker value: OpenAI's current GPT-5.6 guidance lists `none`, `low`,
`medium`, `high`, `xhigh`, and `max` as the supported efforts.

Medium is the default. The selected model and effort persist in browser storage
using the same local-preference model as the current picker. They do not require
a database migration or cross-device account synchronization.

The control is hidden for Claude, Gemini, and role-specific GPT-5.4 routes. The
last valid GPT-5.6 effort remains stored so that it is restored when the user
returns to a GPT-5.6 model.

An `AssistantGenerationSettingsProvider` mounted inside
`DocketLayoutClient` owns the active settings. `useAssistantChat` consumes the
provider and passes controlled values to `InitialView`, `ChatView`, the project
assistant page, and `ChatInput`. Provider ownership keeps settings stable when
the first submitted message swaps `InitialView` for `ChatView` or the router
replaces the new-chat URL with the server-created chat URL.

### Pro mode

Pro is a separate toggle, not a model entry. It is available for Sol, Terra,
and Luna. Pro is never written to browser storage and starts disabled on a page
load or new chat.

The provider tracks assistant-session identity. Entering a new-chat route or a
different existing chat resets mode to Standard; adopting the server-created
ID for the first message in the same new chat does not reset it. A full page
load also recreates the provider in Standard mode. Ask Inputs continuations
reuse the active model, effort, and mode rather than omitting the fields and
falling back to defaults.

Pro supports Medium, High, X-High, and Max. If Pro is enabled while None or Low
is selected, Docket remembers the Standard effort and temporarily raises the
effective effort to Medium. Disabling Pro restores the remembered Standard
effort. Switching away from GPT-5.6 disables Pro.

Standard requests stream. Pro requests use the existing non-streaming final
answer path because Pro performs additional model work and returns one final
answer. Docket still emits that final text through its existing browser-facing
content event contract.

## Model and request contract

### Main-model resolution

The backend will separate a Docket main-model selection from the provider
request configuration. A small main-model registry will define:

- Docket selection ID
- provider
- provider model ID
- supported reasoning efforts
- Standard/Pro capability
- default effort
- streaming behavior

For the GPT-5.6 family, the Docket selection IDs and provider model IDs are the
same explicit strings: `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
Mode remains a separate request field. No code path may send a fabricated
`gpt-5.6-pro` or `gpt-5.6-sol-pro` model slug to OpenAI.

The main-chat resolver must be distinct from title/tabular resolution so that
legacy main-chat aliases can migrate without rewriting intentional GPT-5.4
role-specific requests.

Tabular chat will load the user's validated `tabular_model` alongside the API
keys and pass it explicitly to `runLLMStream`. Its default therefore remains
`gpt-5.4-mini`, and a main-default change cannot silently move tabular chat to
Sol. This is a containment correction required to keep the tabular surface out
of the GPT-5.6 rollout.

### Browser-to-backend request

The chat and project-chat request bodies will accept these optional fields:

```json
{
  "model": "gpt-5.6-sol",
  "reasoning_effort": "medium",
  "reasoning_mode": "standard"
}
```

The backend validates each value before starting the SSE response. Missing
fields resolve to Sol, Medium, and Standard for a GPT-5.6 request. Pro with None
or Low is normalized to Medium defensively even though the new client prevents
that combination.

For non-OpenAI models, GPT-5.6-specific fields are ignored and never forwarded
to another provider. Unknown model strings retain Docket's safe default
behavior but are recorded as requested-versus-resolved metadata so a successful
fallback cannot be mistaken for proof that the requested model ran.

### Legacy compatibility

The new browser performs one-time local-preference migration:

| Stored main selection | New model | New stored effort | New mode |
| --- | --- | --- | --- |
| `gpt-5.5` | Sol | Medium | Standard |
| `gpt-5.5-pro` | Sol | High | Standard |
| `gpt-5.4` | Sol | Medium | Standard |
| `gpt-5.4-mini` | Terra | Low | Standard |

Pro is Standard after browser migration because Pro is deliberately not
persisted. Stale clients that actively submit `gpt-5.5-pro` are different: the
backend maps that request to Sol, Pro, and High so the old request retains its
runtime semantics. Other stale main-chat model strings map by their prior role
without changing title or tabular routes.

### OpenAI request composition

The adapter continues using Responses with the existing instructions, manual
message history, function tools, structured-output configuration, maximum
output limit, and function-call continuation items.

Standard request shape:

```json
{
  "model": "gpt-5.6-sol",
  "reasoning": { "effort": "medium" },
  "stream": true
}
```

Pro request shape:

```json
{
  "model": "gpt-5.6-sol",
  "reasoning": { "mode": "pro", "effort": "medium" },
  "stream": false
}
```

The baseline release preserves `parallel_tool_calls: true`, explicit
`strict: false` function schemas, Docket's manual conversation-history replay,
and current-turn replay of every provider output item plus matching
`function_call_output` items. It does not add persisted reasoning,
`previous_response_id`, Programmatic Tool Calling, explicit prompt caching,
multi-agent behavior, or prompt rewrites.

## Refusals and failures

Existing failed, incomplete, and stream-error responses continue to surface as
sanitized Docket errors. Provider failures never trigger an automatic fallback
to GPT-5.5 or a cheaper GPT-5.6 tier.

Completed Responses can contain refusal content without `output_text`. The
adapter will extract a completed refusal and return its safe user-facing text
through the normal content contract. A completed response with neither text,
refusal, nor tool calls is treated as an explicit empty-response error rather
than being saved as a blank assistant message.

## Spend accounting and observability

Historical GPT-5.5 and GPT-5.4 pricing entries remain for existing ledger rows.
The active standard per-million-token GPT-5.6 prices are recorded from OpenAI's
current pricing page:

| Model | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| Sol | $5.00 | $0.50 | $6.25 | $30.00 |
| Terra | $2.50 | $0.25 | $3.125 | $15.00 |
| Luna | $1.00 | $0.10 | $1.25 | $6.00 |

Pro mode bills the selected model's reported token usage at that model's token
rates. The ledger model key comes from `response.model`, not an app-only label.
Where OpenAI reports cache-write tokens, Docket records them through its
existing cache-creation ledger fields at the documented 1.25x input rate.

Each OpenAI generation records these safe metadata fields in addition to the
existing token, latency, route, chat, project, and cost fields:

- requested model
- resolved Docket selection
- actual `response.model`
- reasoning mode
- reasoning effort
- streaming state
- legacy-migration/fallback status when applicable

This makes a successful request insufficient by itself to claim the intended
model ran; verification must inspect the actual response model or corresponding
trace.

## Test-first implementation

Every behavior change begins with a failing focused test and follows the
red-green-refactor cycle.

Backend coverage will prove:

- canonical Sol/Terra/Luna main-model lists and Sol default;
- main-route legacy mappings without changing title/tabular GPT-5.4 routes;
- validation and normalization of effort and mode;
- Standard streaming versus Pro non-streaming request composition;
- the same provider model ID in Standard and Pro;
- no fabricated Pro slug;
- tool continuation, multiple call IDs, `strict: false`, and custom SSE
  vocabulary remain intact;
- completed refusal, completed empty, failed, and incomplete behavior;
- actual-provider-model spend pricing, cache-write accounting, and trace
  metadata;
- tabular chat explicitly uses the validated user `tabular_model` instead of
  inheriting `DEFAULT_MAIN_MODEL`;
- unchanged GPT-5.4 structured-output/title paths.

Frontend coverage will use a small pure preference helper and the lightest
package-local TypeScript test runner to prove:

- all three GPT-5.6 choices and all six efforts;
- legacy local-storage migration;
- model and effort persistence;
- Pro non-persistence and reset on new chat/page load;
- Pro effort clamping and Standard-effort restoration;
- GPT-5.6 controls hidden for other providers;
- submitted chat and project-chat payloads contain the selected model, effort,
  and mode.

The concrete runner is `tsx --test`: add `tsx` as a frontend development
dependency, add `npm test --prefix frontend`, keep pure reducer/migration logic
in `frontend/src/app/lib/assistantGenerationSettings.ts`, and place Node test
files under `frontend/test/`. Component compilation, lint, and the production
Next build remain separate gates.

The existing assistant runtime checker is updated rather than replaced. The
repository's required clean install, test, build, lint, and smoke commands remain
release gates.

## Deployment and rollback

1. Work on `codex/gpt-5-6-upgrade`; preserve unrelated untracked files.
2. Capture the currently deployed backend and frontend images and revision
   names.
3. Probe the account-level OpenAI Platform `OPENAI_API_KEY` referenced by the
   backend Azure Container App without printing it and without using a saved
   per-user override. If it cannot call GPT-5.6, replace only that Container App
   secret/environment reference with the newly created scoped project key.
4. Deploy the backend first so stale and new clients are both understood.
5. Verify the backend's latest revision equals its latest ready revision, the
   intended image has 100% traffic, and the health endpoint returns OK.
6. Run authenticated synthetic Standard and Pro traces for Sol, Terra, and
   Luna. Include at least one streamed function-tool call and confirm the
   actual response model and spend record.
7. Deploy the frontend and verify its latest/ready revision, intended image,
   100% traffic, login response, picker controls, defaults, persistence, and
   new-chat Pro reset.
8. Roll back the frontend image first and the backend image second if a release
   gate fails. Keep the captured image tags until the live verification window
   is complete.

## Explicitly out of scope

- GPT-5.6 changes to title generation or tabular review, other than explicitly
  decoupling tabular chat from the main default by using its existing
  `tabular_model` setting.
- Account-synced model/effort preferences or a database migration for picker
  state.
- Persisted reasoning, `previous_response_id`, explicit prompt caching,
  Programmatic Tool Calling, multi-agent beta, or prompt rewrites.
- Strict-schema cleanup across all Docket tools.
- Regenerating published training-video artifacts.
- Automatic model discovery from `/v1/models`.

The in-app tutorial and `docs/docket-ai-training-plan.md` source will be updated
to describe Sol, Terra, Luna, reasoning effort, Pro latency/cost, and the
Standard reset behavior.

## Security note

No tool, log, test, commit, or deployment output may print an API key. The new
key is stored only in the ignored `backend/.env` unless the approved Azure
fallback is required. A credential-like value previously entered as a key name
was not reused or sent back to OpenAI as a name; if that value was a real key,
it should be revoked separately because it appeared in conversation data.

## Sources

- [Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model)
- [GPT-5.6 Sol model](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [Upgrading to GPT-5.6 Sol](https://developers.openai.com/api/docs/guides/upgrading-to-gpt-5p6-sol)
- [Reasoning mode](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
