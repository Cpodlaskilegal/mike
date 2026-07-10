# Docket GPT-5.6 Family Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Upgrade Docket's main assistant to GPT-5.6 Sol, Terra, and Luna with all supported reasoning efforts and a separate non-persistent Pro mode, while preserving provider behavior, role-specific models, spend accuracy, and production reliability.

**Architecture:** A shared backend main-model resolver converts browser selections into explicit provider model, effort, mode, and resolution metadata before any SSE headers are sent. A layout-scoped frontend provider owns persistent Standard preferences and ephemeral per-chat Pro state. The OpenAI Responses adapter receives only validated settings, preserves the current tool loop, and records the actual response model and normalized usage. Tabular and title paths remain explicitly bound to their existing user settings.

**Tech Stack:** TypeScript, Node.js, Express, OpenAI Responses API and openai 6.46.0, Next.js, React context, browser localStorage, Node test runner through tsx, PostgreSQL usage ledger, PostHog AI events, Azure Container Apps, Azure Container Registry.

## Global Constraints

- Preserve unrelated untracked files and stage only files named in each task.
- Use npm separately in backend and frontend; never run a root package-manager command.
- Follow red-green-refactor: add or extend a focused test, run it and observe the intended failure, make the smallest implementation, rerun it, then run the package test suite.
- Keep OPENAI_MAIN_MODELS and the frontend model arrays as literal arrays because backend/test/assistantRuntimeContract.test.ts parses their source.
- Never print, commit, copy into command output, or expose an API key. The approved local key remains only in ignored backend/.env unless the production key probe proves an Azure secret replacement is required.
- Do not change title-generation or tabular-review model choices. GPT-5.4 Mini and Nano remain valid on those role-specific paths.
- Do not add a database migration; model/effort preference remains browser-local and the existing spend schema already has cache-creation columns.
- Do not regenerate any training-video output or rendered media.
- Do not add persisted reasoning, previous_response_id, explicit prompt caching, Programmatic Tool Calling, multi-agent behavior, or prompt changes.
- Do not fabricate a Pro model slug. Standard and Pro use the same explicit GPT-5.6 model ID; Pro is only reasoning.mode = "pro".
- Deployment is backend-first and frontend-second. Keep the current production image tags and revision names until all live gates pass.

## File Map

Backend model and request contract:

- Modify backend/src/lib/llm/models.ts
- Modify backend/src/lib/llm/types.ts
- Modify backend/src/lib/chatTools.ts
- Modify backend/src/routes/chat.ts
- Modify backend/src/routes/projectChat.ts
- Modify backend/src/routes/tabular.ts
- Modify backend/src/lib/userSettings.ts
- Modify backend/src/routes/user.ts
- Modify backend/scripts/assistant-runtime-check.ts
- Create backend/test/mainModelRequest.test.ts
- Modify backend/test/assistantRuntimeContract.test.ts

OpenAI adapter and accounting:

- Modify backend/package.json
- Modify backend/package-lock.json
- Modify backend/src/lib/llm/openai.ts
- Modify backend/src/lib/llmSpend.ts
- Create backend/test/openaiAdapter.test.ts
- Modify backend/test/llmSpend.test.ts
- Modify backend/test/errorRedactionIntegrations.test.ts

Frontend state and controls:

- Modify frontend/package.json
- Modify frontend/package-lock.json
- Create frontend/src/app/lib/assistantGenerationSettings.ts
- Create frontend/src/app/lib/assistantChatPayload.ts
- Create frontend/src/app/contexts/AssistantGenerationSettingsContext.tsx
- Create frontend/src/app/components/assistant/ReasoningEffortToggle.tsx
- Create frontend/src/app/components/assistant/ReasoningModeToggle.tsx
- Modify frontend/src/app/(pages)/DocketLayoutClient.tsx
- Modify frontend/src/app/components/assistant/ModelToggle.tsx
- Modify frontend/src/app/components/assistant/ChatInput.tsx
- Modify frontend/src/app/hooks/useAssistantChat.ts
- Delete frontend/src/app/hooks/useSelectedModel.ts
- Modify frontend/src/app/lib/docketApi.ts
- Modify frontend/src/app/lib/modelAvailability.ts
- Create frontend/test/assistantGenerationSettings.test.ts
- Create frontend/test/assistantChatPayload.test.ts

Documentation and release record:

- Modify frontend/src/app/components/tutorial/DocketTutorial.tsx
- Modify docs/docket-ai-training-plan.md
- Create docs/deployments/2026-07-10-gpt-5-6-family.md

---

### Task 1: Establish the canonical backend main-model request contract

**Files:**

- Modify: backend/package.json
- Modify: backend/package-lock.json
- Create: backend/test/mainModelRequest.test.ts
- Modify: backend/src/lib/llm/models.ts
- Modify: backend/src/lib/llm/types.ts
- Modify: frontend/src/app/components/assistant/ModelToggle.tsx

- [ ] **Step 1: Install the GPT-5.6-capable SDK types**

    npm install --prefix backend openai@6.46.0

Expected: backend/package.json and backend/package-lock.json resolve OpenAI 6.46.0 before ReasoningEffort gains max. This prerequisite prevents the 6.35 SDK types from rejecting max during Tasks 1 and 2.

- [ ] **Step 2: Add failing model-resolution tests**

Create table-driven tests that assert:

- OPENAI_MAIN_MODELS is exactly gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna.
- DEFAULT_MAIN_MODEL is gpt-5.6-sol.
- GPT_5_6_REASONING_EFFORTS is exactly none, low, medium, high, xhigh, max.
- A missing model resolves to Sol, medium, Standard, status defaulted.
- Each canonical GPT-5.6 model preserves its provider slug and valid effort.
- Pro with none or low clamps the effective effort to medium.
- minimal and unknown effort/mode values produce a typed validation error.
- A raw model value of null, a number, an array, an object, an empty string, or whitespace returns a parse error; an omitted model uses the default.
- For a canonical GPT-5.6 or unknown-fallback OpenAI request, non-string, null, and unknown non-empty reasoning values return a parse error.
- Claude and Gemini retain their selected model and strip GPT-only effort/mode.
- Claude and Gemini strip GPT-only fields even when those ignored field values are malformed.
- Unknown model strings safely resolve to Sol and status unknown_fallback while retaining requestedModel for observability.
- Legacy mappings are:
  - gpt-5.5 to Sol, medium, Standard
  - gpt-5.5-pro to Sol, high, Pro
  - gpt-5.4 to Sol, medium, Standard
  - gpt-5.4-mini to Terra, low, Standard
- isTabularModelId still accepts the existing GPT-5.4 tabular IDs.

Use the public shape:

    type MainModelResolutionStatus =
        | "direct"
        | "defaulted"
        | "legacy_mapped"
        | "unknown_fallback";

    type ResolvedMainModelRequest = {
        requestedModel: string | null;
        selectionModel: string;
        providerModel: string;
        provider: Provider;
        reasoningEffort?: Gpt56ReasoningEffort;
        reasoningMode?: ReasoningMode;
        status: MainModelResolutionStatus;
    };

    type MainModelRequestParseResult =
        | { ok: true; value: ResolvedMainModelRequest }
        | { ok: false; detail: string };

    resolveMainModelRequest({
        model,
        reasoning_effort,
        reasoning_mode,
    }): ResolvedMainModelRequest

    parseMainModelRequest(body: unknown): MainModelRequestParseResult

- [ ] **Step 3: Run the focused test and confirm the intended failure**

    npm exec --prefix backend -- tsx --test --test-concurrency=1 backend/test/mainModelRequest.test.ts

Expected: failure because GPT-5.6 constants and resolveMainModelRequest do not exist.

- [ ] **Step 4: Implement the registry, types, validation, and legacy map**

In backend/src/lib/llm/types.ts:

- Add max to the generic ReasoningEffort union without removing minimal.
- Add ReasoningMode = "standard" | "pro".
- Add reasoningMode?: ReasoningMode to StreamChatParams.
- Add safe request-resolution metadata fields to AiObservabilityContext metadata usage; do not add secrets or request content.

In backend/src/lib/llm/models.ts:

- Replace only the literal OPENAI_MAIN_MODELS values and main default.
- Leave OPENAI_MID_MODELS, OPENAI_LOW_MODELS, DEFAULT_TITLE_MODEL, and DEFAULT_TABULAR_MODEL unchanged.
- Export GPT_5_6_REASONING_EFFORTS, Gpt56ReasoningEffort, MainModelId, MainModelResolutionStatus, ResolvedMainModelRequest, MainModelRequestParseResult, resolveMainModelRequest, parseMainModelRequest, and resolveTabularModel.
- Define a small explicit registry for the three GPT-5.6 selections. Every entry uses the same selectionModel and providerModel string, supports Standard and Pro, defaults to medium, and declares Standard streaming and Pro non-streaming behavior.
- Keep resolveMainModelRequest limited to already typed values. Make parseMainModelRequest classify the raw model first, strip GPT-only fields for known Claude/Gemini selections, validate applicable GPT-5.6 fields, and return a safe field-specific parse result before resolution.
- Treat an absent model field as the default, but reject an explicitly null, non-string, empty, or whitespace model. Preserve safe fallback only for a non-empty unknown string.
- Apply the four legacy mappings only in the main-request resolver. Do not add legacy IDs to ALL_MODELS or the role-specific resolver.
- Return requested-versus-resolved status for defaults, legacy mappings, and unknown fallback.
- For non-OpenAI canonical models, ignore reasoning fields rather than forwarding them.
- Implement resolveTabularModel with isTabularModelId so a main-only GPT-5.6 ID can never become a stored or loaded tabular selection.

In frontend/src/app/components/assistant/ModelToggle.tsx, update the literal OpenAI main options and DEFAULT_MODEL_ID in the same commit:

- gpt-5.6-sol, GPT-5.6 Sol
- gpt-5.6-terra, GPT-5.6 Terra
- gpt-5.6-luna, GPT-5.6 Luna

Leave Claude, Gemini, and TABULAR_MODELS unchanged. This cross-layer edit keeps the existing assistant-runtime checker green while later tasks add persistence, descriptions, and reasoning controls.

- [ ] **Step 5: Rerun focused and full backend tests**

    npm exec --prefix backend -- tsx --test --test-concurrency=1 backend/test/mainModelRequest.test.ts
    npm test --prefix backend
    npm run lint --prefix frontend

Expected: focused tests, the checkout-level runtime suite, and frontend lint pass with matching backend/frontend literal model lists.

- [ ] **Step 6: Commit the contract**

    git add backend/package.json backend/package-lock.json backend/src/lib/llm/models.ts backend/src/lib/llm/types.ts backend/test/mainModelRequest.test.ts frontend/src/app/components/assistant/ModelToggle.tsx
    git commit -m "feat: define GPT-5.6 main model contract"

---

### Task 2: Resolve chat requests before SSE and isolate tabular chat

**Files:**

- Modify: backend/src/routes/chat.ts
- Modify: backend/src/routes/projectChat.ts
- Modify: backend/src/routes/tabular.ts
- Modify: backend/src/lib/userSettings.ts
- Modify: backend/src/routes/user.ts
- Modify: backend/src/lib/chatTools.ts
- Modify: backend/scripts/assistant-runtime-check.ts
- Modify: backend/test/assistantRuntimeContract.test.ts
- Modify: backend/test/mainModelRequest.test.ts

- [ ] **Step 1: Add failing route and containment assertions**

Extend the runtime-contract fixture and focused tests to prove:

- chat.ts and projectChat.ts call parseMainModelRequest before res.flushHeaders().
- Invalid reasoning_effort or reasoning_mode returns HTTP 400 JSON and does not start SSE.
- Both routes pass providerModel, reasoningEffort, reasoningMode, and resolution metadata into runLLMStream.
- runLLMStream no longer calls resolveModel for the main assistant and requires an explicit model.
- Tabular chat loads tabular_model and api_keys together from getUserModelSettings and passes tabular_model explicitly to runLLMStream.
- Loaded profiles resolve tabular_model through resolveTabularModel, and profile updates accept only isTabularModelId values.
- A GPT-5.6 main ID submitted as tabularModel is rejected; a stale stored GPT-5.6 tabular value safely reads as DEFAULT_TABULAR_MODEL.
- Title and structured-output calls keep title_model/tabular_model and their current GPT-5.4 IDs.
- Existing SSE event names, cancellation signal propagation, placeholder persistence, tool-event persistence, and citation events remain present.

- [ ] **Step 2: Run the focused contract tests and confirm failure**

    npm exec --prefix backend -- tsx --test --test-concurrency=1 backend/test/mainModelRequest.test.ts backend/test/assistantRuntimeContract.test.ts

Expected: failures show that routes still pass only model and tabular chat omits it.

- [ ] **Step 3: Parse and validate both assistant request bodies before streaming**

In backend/src/routes/chat.ts and backend/src/routes/projectChat.ts:

- Pass the raw body to parseMainModelRequest immediately after authentication/general body validation and before inserting a streaming placeholder or setting SSE headers.
- If parsing returns ok: false, return its safe HTTP 400 JSON detail without starting SSE.
- Pass resolved.providerModel as model plus resolved.reasoningEffort, resolved.reasoningMode, and safe requested/resolved/status metadata to runLLMStream.
- Preserve the existing API-key selection, document authorization, legal-research setting, project context, Ask Inputs placeholders, abort controller, and SSE writer.

In backend/src/lib/chatTools.ts:

- Make model required on runLLMStream.
- Add reasoningEffort, reasoningMode, and modelResolution metadata parameters.
- Remove the internal resolveModel(model, DEFAULT_MAIN_MODEL) fallback.
- Pass the exact required model and generation settings to streamChatWithTools.
- Merge requested_model, resolved_model, model_resolution_status, reasoning_effort, and reasoning_mode into the existing safe observability metadata.
- Do not change tool lists, system prompts, iteration count, conversation replay, or SSE serialization.

- [ ] **Step 4: Explicitly bind tabular chat to the user's tabular setting**

Replace the tabular chat getUserApiKeys call with:

    const {
        tabular_model: tabularModel,
        api_keys: apiKeys,
    } = await getUserModelSettings(userId, db);

Pass model: tabularModel into runLLMStream. Do not attach GPT-5.6 mode or effort fields. Keep the other tabular title, column, extraction, and structured-output calls unchanged.

In backend/src/lib/userSettings.ts, replace the generic resolveModel call for tabular_model with resolveTabularModel. In backend/src/routes/user.ts:

- Serialize tabularModel through resolveTabularModel.
- Validate an update with isTabularModelId instead of generic resolveModel.
- Continue returning Unsupported tabularModel for main-only GPT-5.6 IDs and unknown values.

- [ ] **Step 5: Update the literal-source runtime checker**

Update backend/scripts/assistant-runtime-check.ts and its fixture expectations in backend/test/assistantRuntimeContract.test.ts for:

- The exact new OpenAI main-model literal array and Sol default.
- Explicit route propagation of effort and mode.
- Explicit tabular model selection.
- Required abort signals and existing custom SSE vocabulary.

Do not weaken the checker into broad substring assertions that would permit GPT-5.5 to remain in the visible main list.

- [ ] **Step 6: Run backend tests and build**

    npm test --prefix backend
    npm run build --prefix backend

Expected: all tests pass and TypeScript confirms every runLLMStream caller supplies a model. If another role-specific caller is exposed, pass its already configured model explicitly rather than using Sol.

- [ ] **Step 7: Commit request propagation and containment**

    git add backend/src/routes/chat.ts backend/src/routes/projectChat.ts backend/src/routes/tabular.ts backend/src/lib/userSettings.ts backend/src/routes/user.ts backend/src/lib/chatTools.ts backend/scripts/assistant-runtime-check.ts backend/test/assistantRuntimeContract.test.ts backend/test/mainModelRequest.test.ts
    git commit -m "feat: propagate GPT-5.6 generation settings"

---

### Task 3: Implement typed Standard/Pro Responses behavior

**Files:**

- Modify: backend/src/lib/llm/types.ts
- Modify: backend/src/lib/llm/openai.ts
- Create: backend/test/openaiAdapter.test.ts
- Modify: backend/test/assistantRuntimeContract.test.ts

- [ ] **Step 1: Add failing pure adapter-contract tests**

Create backend/test/openaiAdapter.test.ts with typed response fixtures and request-shape assertions for:

- Standard Sol/Terra/Luna uses stream: true and reasoning: { effort }.
- Pro Sol/Terra/Luna uses stream: false and reasoning: { mode: "pro", effort }.
- Standard never sends reasoning.mode.
- Pro never changes or suffixes the provider model ID.
- All mapped function tools keep strict: false and parallel_tool_calls: true.
- Two function calls retain distinct call_id values, and the next input contains all response.output items followed by matching function_call_output items.
- A completed response with output_text returns text.
- A completed response with refusal content and no output_text returns the refusal text.
- A completed response with tool calls returns the calls instead of throwing.
- A completed response with no text, refusal, or calls throws OPENAI_EMPTY_RESPONSE.
- failed, incomplete, and stream-error responses retain sanitized error behavior.
- Docket callbacks still emit content deltas, reasoning deltas, reasoning-block completion, and tool-call starts expected by chatTools.

Expose typed deterministic helpers from openai.ts rather than making network calls in tests. Import ResponseCreateParamsBase, ResponseCreateParamsStreaming, and ResponseCreateParamsNonStreaming from the 6.46 Responses declarations:

    type OpenAIRequestBuilderInput =
        Omit<ResponseCreateParamsBase, "reasoning"> & {
            reasoningEffort: ReasoningEffort;
        };

    type Gpt56ProReasoningEffort =
        Exclude<Gpt56ReasoningEffort, "none" | "low">;

    buildOpenAIStandardStreamingRequest(
        input: OpenAIRequestBuilderInput,
    ): ResponseCreateParamsStreaming

    buildOpenAIProNonStreamingRequest(
        input: Omit<OpenAIRequestBuilderInput, "reasoningEffort"> & {
            reasoningEffort: Gpt56ProReasoningEffort;
        },
    ): ResponseCreateParamsNonStreaming

    buildOpenAIStandardNonStreamingRequest(
        input: OpenAIRequestBuilderInput,
    ): ResponseCreateParamsNonStreaming

    type CompletedOpenAIOutput =
        | { kind: "text"; text: string }
        | { kind: "refusal"; text: string }
        | { kind: "tool_calls"; text: "" };

    extractCompletedOpenAIOutput(response: Response): CompletedOpenAIOutput
    buildToolContinuationInput(
        response: Response,
        results: NormalizedToolResult[],
    ): ResponseInput
    shouldStreamOpenAI(reasoningMode: ReasoningMode): boolean

The separate return types are mandatory: do not return a union with stream: boolean and cast it into the SDK overload. The Standard non-streaming builder preserves title/tabular one-shot calls while omitting reasoning.mode; the Pro builder always sets stream: false and reasoning.mode: "pro".

- [ ] **Step 2: Run the focused test and confirm failure**

    npm exec --prefix backend -- tsx --test --test-concurrency=1 backend/test/openaiAdapter.test.ts

Expected: failure because the request builder and completed-output extractor do not yet implement mode/refusal behavior.

- [ ] **Step 3: Refactor request construction without changing the tool loop**

In backend/src/lib/llm/openai.ts:

- Remove isProModel and every special case based on gpt-5.5-pro.
- Make reasoningMode and reasoningEffort explicit inputs from StreamChatParams.
- Build the three typed request bodies above without assertions that erase stream literal types.
- Use the Standard streaming builder for interactive Standard chat, the Pro non-streaming builder for interactive Pro chat, and the Standard non-streaming builder for existing one-shot title/tabular completions.
- Use non-streaming create for Pro and the existing streaming create path for Standard.
- Preserve instructions, manual message history, max_output_tokens, text format, function tools, strict: false, parallel_tool_calls: true, abort signals, and current-turn function continuation.
- On every tool iteration, replay all provider output items from the response and append one function_call_output per normalized tool result with the matching call_id.
- Continue emitting a final Pro answer through the adapter callbacks so chatTools produces the same browser-facing content event contract.
- Extract refusal text from completed message content when output_text is empty.
- Throw a named safe empty-response error when a completed response contains neither user-visible text, refusal, nor executable tool calls.
- Keep failed, incomplete, aborted, and stream errors explicit; never fall back to another model.

- [ ] **Step 4: Preserve the Docket SSE and cancellation contract**

Extend backend/test/assistantRuntimeContract.test.ts only where needed to assert that Standard and Pro both flow through existing chatTools callbacks and events. Do not expose raw OpenAI stream event names to the browser.

- [ ] **Step 5: Run focused tests, full tests, and build**

    npm exec --prefix backend -- tsx --test --test-concurrency=1 backend/test/openaiAdapter.test.ts backend/test/assistantRuntimeContract.test.ts
    npm test --prefix backend
    npm run build --prefix backend

Expected: all pass with the new SDK and no reference to a fabricated GPT-5.6 Pro slug.

- [ ] **Step 6: Commit the adapter change**

    git add backend/src/lib/llm/types.ts backend/src/lib/llm/openai.ts backend/test/openaiAdapter.test.ts backend/test/assistantRuntimeContract.test.ts
    git commit -m "feat: support GPT-5.6 Standard and Pro responses"

---

### Task 4: Price GPT-5.6 and record actual response-model usage

**Files:**

- Modify: backend/src/lib/llmSpend.ts
- Modify: backend/src/lib/llm/openai.ts
- Modify: backend/test/llmSpend.test.ts
- Modify: backend/test/openaiAdapter.test.ts
- Modify: backend/test/errorRedactionIntegrations.test.ts

- [ ] **Step 1: Add failing exact-cost and normalized-usage tests**

Add exact bigint assertions:

- Sol, 1,000,000 input and 1,000,000 output: 35,000,000,000 nanos.
- Terra, 1,000,000 input and 1,000,000 output: 17,500,000,000 nanos.
- Luna, 1,000,000 input and 1,000,000 output: 7,000,000,000 nanos.
- Sol with 1,000,000 total input, 200,000 cached, 100,000 cache-write, and 1,000,000 output:
  - regular input cost 3,500,000,000 nanos
  - cached plus cache-write cost 725,000,000 nanos
  - output cost 30,000,000,000 nanos
  - total 34,225,000,000 nanos.
- Existing GPT-5.5 and GPT-5.4 ledger models remain priced.
- An unknown actual provider model remains explicitly unpriced instead of borrowing the requested model's rate.

Add adapter tests proving:

- Usage model is response.model, not the requested app selection.
- A request selected as Sol whose response.model reports Terra records and prices Terra.
- input_tokens_details.cache_write_tokens maps to cacheCreation5mTokens.
- Regular OpenAI input subtracts cached and cache-write tokens once.
- A successful AI event reports actual response model as the primary model plus requested_model, resolved_model, reasoning_mode, reasoning_effort, streaming, and resolution status metadata.
- Failure metadata has actual_model null and contains no key, prompt, document content, or raw provider error.
- Existing integration redaction tests still prove provider credentials are removed from logged and SSE errors after the new metadata is added.

- [ ] **Step 2: Run focused tests and confirm failure**

    npm exec --prefix backend -- tsx --test --test-concurrency=1 backend/test/llmSpend.test.ts backend/test/openaiAdapter.test.ts backend/test/errorRedactionIntegrations.test.ts

Expected: failures because pricing entries, cache-write normalization, and actual-model attribution are absent.

- [ ] **Step 3: Add immutable pricing entries and correct regular-input math**

In backend/src/lib/llmSpend.ts:

- Retain all historical GPT-5.5 and GPT-5.4 prices.
- Add per-million standard pricing:
  - gpt-5.6-sol: input 5, cached 0.5, output 30
  - gpt-5.6-terra: input 2.5, cached 0.25, output 15
  - gpt-5.6-luna: input 1, cached 0.1, output 6
- Keep the existing cache-creation calculation at 1.25 times input.
- For OpenAI only, calculate regularInputTokens as input minus cached input minus cacheCreation5mTokens minus cacheCreation1hTokens, clamped at zero.

- [ ] **Step 4: Normalize provider usage from the completed response**

In backend/src/lib/llm/openai.ts:

- Derive a pure normalized usage record from response.model and response.usage.
- Use that same normalized record in both interactive streamOpenAI and one-shot completeOpenAIText paths.
- Pass response.model to calculateLlmCostNanos and recordLlmUsage.
- Map input_tokens_details.cached_tokens to cachedInputTokens.
- Map input_tokens_details.cache_write_tokens to cacheCreation5mTokens.
- Keep provider_response_id, account-versus-user-key billing source, user/chat/project attribution, and report delivery behavior unchanged.
- Use actual response.model for the PostHog $ai_model field.
- For failures without a completed response, keep the resolved provider model in $ai_model and set actual_response_model to null; never invent an actual model.
- Add only the approved safe requested/resolved/actual/mode/effort/streaming/status metadata.

- [ ] **Step 5: Run accounting and adapter tests**

    npm exec --prefix backend -- tsx --test --test-concurrency=1 backend/test/llmSpend.test.ts backend/test/openaiAdapter.test.ts backend/test/errorRedactionIntegrations.test.ts
    npm test --prefix backend
    npm run build --prefix backend

Expected: exact costs pass, historical pricing tests remain green, and actual response model drives new ledger records.

- [ ] **Step 6: Commit spend and observability changes**

    git add backend/src/lib/llmSpend.ts backend/src/lib/llm/openai.ts backend/test/llmSpend.test.ts backend/test/openaiAdapter.test.ts backend/test/errorRedactionIntegrations.test.ts
    git commit -m "feat: account for GPT-5.6 usage"

---

### Task 5: Add a tested frontend settings state machine and package test runner

**Files:**

- Modify: frontend/package.json
- Modify: frontend/package-lock.json
- Create: frontend/src/app/lib/assistantGenerationSettings.ts
- Create: frontend/test/assistantGenerationSettings.test.ts

- [ ] **Step 1: Add the package-local TypeScript test runner**

    npm install --prefix frontend --save-dev tsx@4.22.4 --legacy-peer-deps

Add this frontend package script:

    "test": "tsx --test --test-concurrency=1 test/*.test.ts"

Expected: only the frontend package manifest and lockfile change.

- [ ] **Step 2: Write failing pure state-machine tests**

Create frontend/test/assistantGenerationSettings.test.ts without React or DOM dependencies. Cover:

- GPT56_MODEL_IDS is exactly Sol, Terra, Luna.
- GPT56_REASONING_EFFORTS is exactly none, low, medium, high, xhigh, max.
- The fresh default is Sol, medium, Standard.
- Storage round-trip persists model and Standard effort, but never Pro mode or Pro effort.
- Missing, malformed, or unknown storage data safely returns the default.
- Legacy stored values migrate once:
  - gpt-5.5 to Sol/medium
  - gpt-5.5-pro to Sol/high
  - gpt-5.4 to Sol/medium
  - gpt-5.4-mini to Terra/low
- Migration always returns Standard mode.
- Enabling Pro from none or low sets effective Pro effort to medium while leaving Standard effort unchanged.
- Enabling Pro from medium/high/xhigh/max starts Pro at that effort.
- Editing effort in Pro changes only Pro effort.
- Disabling Pro restores the unchanged Standard effort.
- Switching among Sol, Terra, and Luna preserves the active mode and corresponding effort.
- Switching from GPT-5.6 to Claude or Gemini disables Pro and hides GPT-specific settings.
- Returning to a GPT-5.6 model restores the stored Standard effort.
- resetAssistantSession changes mode to Standard and never erases the persisted model/effort.

Use a pure state shape:

    type AssistantGenerationSettingsState = {
        model: string;
        standardEffort: Gpt56ReasoningEffort;
        proEffort: ProReasoningEffort;
        reasoningMode: "standard" | "pro";
        sessionKey: string | null;
    };

And pure exported operations:

    defaultAssistantGenerationSettings()
    deserializeAssistantGenerationSettings(raw)
    serializeAssistantGenerationSettings(state)
    selectAssistantModel(state, model)
    selectAssistantEffort(state, effort)
    setAssistantReasoningMode(state, mode)
    resetAssistantSession(state)
    effectiveAssistantGenerationSettings(state)
    isGpt56Model(model)

- [ ] **Step 3: Run the new frontend test and confirm failure**

    npm test --prefix frontend

Expected: failure because assistantGenerationSettings.ts does not exist.

- [ ] **Step 4: Implement the pure model, persistence, and migration logic**

In frontend/src/app/lib/assistantGenerationSettings.ts:

- Export literal GPT56_MODEL_IDS and GPT56_REASONING_EFFORTS arrays matching the backend.
- Export PRO_REASONING_EFFORTS as medium, high, xhigh, max.
- Export ASSISTANT_GENERATION_STORAGE_KEY = "docket.assistant-generation-settings.v1" and LEGACY_ASSISTANT_MODEL_STORAGE_KEY = "docket.selectedModel".
- Serialize only version, model, and standardEffort.
- Never serialize reasoningMode, proEffort, or sessionKey.
- Clamp Pro to medium when Standard is none or low.
- Preserve the current valid Standard effort when Pro changes.
- Disable Pro for every non-GPT-5.6 model.
- Export the unchanged Claude and Gemini main-model ID arrays plus one pure allowed-main-model set. Do not import ModelToggle from this React-free module.
- Hydration precedence is exact: use a valid versioned record first; if it is absent or invalid, try docket.selectedModel; if the legacy value is valid or one of the four mapped GPT values, migrate it; otherwise use Sol/medium/Standard.
- After the first successful versioned write, remove docket.selectedModel so it cannot override future preferences. Never remove it before the versioned write succeeds.

- [ ] **Step 5: Run tests and static checks**

    npm test --prefix frontend
    npm run lint --prefix frontend

Expected: pure tests pass. Lint may still report unused helpers until the provider is introduced in Task 6; resolve only actual errors and do not suppress the state contract.

- [ ] **Step 6: Commit the pure frontend contract**

    git add frontend/package.json frontend/package-lock.json frontend/src/app/lib/assistantGenerationSettings.ts frontend/test/assistantGenerationSettings.test.ts
    git commit -m "feat: define assistant generation settings"

---

### Task 6: Mount stable settings ownership and implement chat-session reset semantics

**Files:**

- Create: frontend/src/app/contexts/AssistantGenerationSettingsContext.tsx
- Modify: frontend/src/app/(pages)/DocketLayoutClient.tsx
- Modify: frontend/src/app/hooks/useAssistantChat.ts
- Modify: frontend/test/assistantGenerationSettings.test.ts

- [ ] **Step 1: Add failing session-transition tests**

Extend the pure test suite with an explicit session identity reducer:

    activateAssistantSession(state, nextSessionKey)
    adoptCreatedAssistantChat(state, createdChatKey)

Assert:

- First activation of new:assistant starts Standard.
- Changing from one existing chat key to another resets Pro to Standard.
- Entering a project new-chat key resets Pro.
- A pre-created project/workflow chat carrying newChatMessages resets to Standard once before its auto-send; it is not mistaken for general-chat URL adoption.
- Adopting the server-created chat ID for the same newly submitted conversation changes the session key without resetting Pro.
- A second adoption or a different existing-chat activation resets to Standard.
- A recreated initial state, representing a full page load, is Standard even if storage contains a model and effort.

- [ ] **Step 2: Run the session tests and confirm failure**

    npm exec --prefix frontend -- tsx --test --test-concurrency=1 frontend/test/assistantGenerationSettings.test.ts

Expected: failure because activation/adoption operations and provider methods are absent.

- [ ] **Step 3: Implement the client context**

Create AssistantGenerationSettingsProvider and useAssistantGenerationSettings with:

- Lazy browser hydration from the versioned preference and legacy key.
- Sol/medium/Standard SSR-safe initial state.
- A hydrated flag that becomes true only after storage migration/default resolution finishes.
- Persistence effect that writes only model and Standard effort after hydration.
- Guard localStorage reads, writes, and legacy-key removal so unavailable storage falls back to safe in-memory settings without breaking chat.
- Actions for selectModel, selectEffort, setReasoningMode, activateSession, and adoptCreatedChat.
- Derived effective model, reasoning_effort, and reasoning_mode.
- No server synchronization and no database write.
- A clear hook error if consumed outside the provider.

Mount it inside ChatHistoryProvider in frontend/src/app/(pages)/DocketLayoutClient.tsx so it survives:

- InitialView to ChatView replacement.
- window.history.replaceState after the server emits chat_id.
- Navigation within the authenticated Docket layout.

- [ ] **Step 4: Connect useAssistantChat to session identity**

In frontend/src/app/hooks/useAssistantChat.ts:

- Consume the generation-settings context.
- On hook activation, derive an identity from projectId and initialChatId:
  - general new route: new:assistant
  - existing general chat: assistant:{chatId}
  - project context: project:{projectId}:{chatId or new}
- Activate that identity when the actual route/chat identity changes.
- When a new general chat receives its first SSE chat_id, call adoptCreatedChat before replacing the browser URL.
- A project chat created before the chat page mounts is a new session and therefore starts Standard when its route activates.
- Preserve all existing chat-history, router, title generation, abort, and stream parsing behavior.
- Avoid an effect dependency loop: provider actions must be stable callbacks and activation must be idempotent for the current key.

- [ ] **Step 5: Run tests, lint, and frontend build**

    npm test --prefix frontend
    npm run lint --prefix frontend
    npm run build --prefix frontend

Expected: session tests pass and context compiles across all assistant routes.

- [ ] **Step 6: Commit provider and session ownership**

    git add 'frontend/src/app/(pages)/DocketLayoutClient.tsx' frontend/src/app/contexts/AssistantGenerationSettingsContext.tsx frontend/src/app/hooks/useAssistantChat.ts frontend/test/assistantGenerationSettings.test.ts
    git commit -m "feat: scope generation settings to assistant sessions"

---

### Task 7: Enrich the model picker, build the controls, and propagate every assistant request

**Files:**

- Create: frontend/src/app/lib/assistantChatPayload.ts
- Create: frontend/src/app/components/assistant/ReasoningEffortToggle.tsx
- Create: frontend/src/app/components/assistant/ReasoningModeToggle.tsx
- Create: frontend/test/assistantChatPayload.test.ts
- Modify: frontend/src/app/components/assistant/ModelToggle.tsx
- Modify: frontend/src/app/components/assistant/ChatInput.tsx
- Modify: frontend/src/app/hooks/useAssistantChat.ts
- Modify: frontend/src/app/lib/docketApi.ts
- Modify: frontend/src/app/lib/modelAvailability.ts
- Delete: frontend/src/app/hooks/useSelectedModel.ts

- [ ] **Step 1: Write failing payload tests**

Create frontend/test/assistantChatPayload.test.ts for a pure buildAssistantGenerationPayload function. Assert:

- Sol/medium/Standard yields model gpt-5.6-sol, reasoning_effort medium, reasoning_mode standard.
- Terra/high/Pro and Luna/max/Pro keep the exact model ID and mode pro.
- Pro never creates a model string containing a Pro suffix.
- A defensive Pro none/low state emits medium.
- Claude and Gemini payloads contain model only and omit both GPT-specific fields.
- Normal general chat, project chat, and Ask Inputs continuation builders use the same generation payload.
- Payload fields use snake_case exactly as the backend expects.

- [ ] **Step 2: Run payload tests and confirm failure**

    npm exec --prefix frontend -- tsx --test --test-concurrency=1 frontend/test/assistantChatPayload.test.ts

Expected: failure because the payload builder does not exist.

- [ ] **Step 3: Verify and enrich the visible main-model list**

In frontend/src/app/components/assistant/ModelToggle.tsx:

- Verify the OpenAI entries changed in Task 1 are exactly:
  - gpt-5.6-sol, label GPT-5.6 Sol
  - gpt-5.6-terra, label GPT-5.6 Terra
  - gpt-5.6-luna, label GPT-5.6 Luna
- Add concise descriptions in the menu: frontier quality, balanced quality/cost, efficient high-volume.
- Set DEFAULT_MODEL_ID to gpt-5.6-sol.
- Leave every Claude and Gemini entry unchanged.
- Leave TABULAR_MODELS unchanged, including GPT-5.4, Mini, and Nano.

Build the literal ModelToggle options from the same IDs and add a test asserting parity with the pure allowed-main-model set. Update frontend/src/app/lib/modelAvailability.ts to import pure IDs or use provider prefixes rather than importing a React component; all three GPT-5.6 models continue to use the existing OpenAI availability gate.

- [ ] **Step 4: Implement adjacent effort and mode controls**

ReasoningEffortToggle:

- Render only for a GPT-5.6 main selection.
- Offer None, Low, Medium, High, X-High, Max in that order.
- In Standard, display and change standardEffort.
- In Pro, offer only Medium, High, X-High, Max and display proEffort.
- Use accessible button/menu labels and disabled/loading styles consistent with ModelToggle.

ReasoningModeToggle:

- Render only for a GPT-5.6 main selection.
- Offer Standard and Pro as execution modes, not models.
- Explain that Pro can take longer and cost more.
- Display Standard after a page load, new chat, or provider switch.

Place both next to ModelToggle in ChatInput, wrapping cleanly on narrow screens. Read and update them through useAssistantGenerationSettings. Remove useSelectedModel usage and delete its file.

Disable model/effort/mode changes and message submission only during the brief pre-hydration state so a persisted Terra/Luna preference cannot accidentally submit as the SSR default Sol. Preserve the existing loading/cancel behavior after hydration.

- [ ] **Step 5: Centralize request-body generation**

In frontend/src/app/lib/assistantChatPayload.ts:

- Implement buildAssistantGenerationPayload from the effective context settings.
- Keep it pure and return model plus optional reasoning_effort/reasoning_mode.
- Export a shared AssistantGenerationPayload type.

In frontend/src/app/lib/docketApi.ts:

- Add reasoning_effort and reasoning_mode to both streamChat and streamProjectChat payload types.
- Do not add these fields to tabular APIs or account model settings.

For the existing DocketMessage contract:

- Keep the existing optional DocketMessage.model field for stale in-memory newChatMessages compatibility during this release, but do not add effort or mode to saved message types.
- Stop ChatInput from setting DocketMessage.model, and make useAssistantChat ignore it. Context-owned generation payloads determine every new request so restored history cannot dictate the next settings.

- [ ] **Step 6: Use the same active settings for every submission path**

In frontend/src/app/hooks/useAssistantChat.ts:

- Build generation fields from the context immediately before each fetch.
- Spread the same fields into normal streamChat and streamProjectChat calls.
- Make submitAskInputs call the same handleChat path without relying on message.model.
- Ensure the auto-sent first message after route creation uses the current provider state after session activation/reset.
- Ensure model/effort changes apply to the next turn without rewriting prior saved messages.
- Keep attachments, displayed document, workflows, Ask Inputs payload, and abort signal unchanged.

- [ ] **Step 7: Run focused tests and all frontend gates**

    npm test --prefix frontend
    npm run lint --prefix frontend
    npm run build --prefix frontend

Expected: tests prove consistent payloads; lint and Next production build pass; no main-assistant GPT-5.5 option remains.

- [ ] **Step 8: Commit controls and propagation**

    git add frontend/package.json frontend/package-lock.json frontend/src/app/lib/assistantChatPayload.ts frontend/src/app/components/assistant/ReasoningEffortToggle.tsx frontend/src/app/components/assistant/ReasoningModeToggle.tsx frontend/src/app/components/assistant/ModelToggle.tsx frontend/src/app/components/assistant/ChatInput.tsx frontend/src/app/hooks/useAssistantChat.ts frontend/src/app/lib/docketApi.ts frontend/src/app/lib/modelAvailability.ts frontend/test/assistantChatPayload.test.ts
    git add -u frontend/src/app/hooks/useSelectedModel.ts
    git commit -m "feat: add GPT-5.6 reasoning controls"

---

### Task 8: Lock the cross-layer contract and update user-facing guidance

**Files:**

- Modify: backend/test/assistantRuntimeContract.test.ts
- Modify: backend/scripts/assistant-runtime-check.ts
- Modify: frontend/test/assistantGenerationSettings.test.ts
- Modify: frontend/test/assistantChatPayload.test.ts
- Modify: frontend/src/app/components/tutorial/DocketTutorial.tsx
- Modify: docs/docket-ai-training-plan.md

- [ ] **Step 1: Add cross-layer literal and safety assertions**

Extend the runtime checker and frontend tests to fail unless:

- Backend and frontend literal main OpenAI arrays contain the same three IDs in the same order.
- Both defaults are Sol.
- Both effort lists contain none, low, medium, high, xhigh, max and exclude minimal.
- Backend accepts exactly the snake_case fields emitted by frontend.
- No source under backend/src or frontend/src fabricates gpt-5.6-pro, gpt-5.6-sol-pro, gpt-5.6-terra-pro, or gpt-5.6-luna-pro.
- No main ModelToggle entry exposes GPT-5.5 or GPT-5.4.
- TABULAR_MODELS and backend role-specific defaults retain GPT-5.4 values.
- The request path still carries AbortSignal and the custom Docket SSE event vocabulary.

- [ ] **Step 2: Run the cross-layer tests and observe any drift**

    npm exec --prefix backend -- tsx --test --test-concurrency=1 backend/test/assistantRuntimeContract.test.ts
    npm test --prefix frontend

Expected: any frontend/backend string drift fails before documentation is updated.

- [ ] **Step 3: Update the in-app tutorial source**

Revise only the source steps in frontend/src/app/components/tutorial/DocketTutorial.tsx:

- Introduce Sol as frontier/default, Terra as balanced, and Luna as efficient.
- Explain effort values and that higher values trade latency/cost for more reasoning.
- Explain Pro as a separate mode available on all three models.
- State that Pro resets to Standard on a page load or new chat.
- Keep tutorial selectors stable and do not make the tour depend on a rendered menu being open.

- [ ] **Step 4: Update the training plan source, not artifacts**

In docs/docket-ai-training-plan.md:

- Replace GPT-5.5 main-assistant references with the three GPT-5.6 choices.
- Add effort and Standard/Pro guidance.
- Recommend Sol/medium/Standard as the default.
- Describe Terra and Luna use cases without promising deterministic latency.
- State that Pro may take longer and cost more and resets for new sessions.
- Preserve GPT-5.4 references that explicitly describe title/tabular roles.
- Do not touch docs/training-video/output, docs/training-video/hyperframes/renders, audio, captions, or MP4 files.

- [ ] **Step 5: Run source scans and package gates**

    rg -n "gpt-5\\.5|GPT-5\\.5|gpt-5\\.4|GPT-5\\.4" frontend/src/app/components/assistant frontend/src/app/components/tutorial docs/docket-ai-training-plan.md backend/src/lib/llm/models.ts
    rg -n "gpt-5\\.6-(pro|sol-pro|terra-pro|luna-pro)" backend/src frontend/src
    npm test --prefix backend
    npm test --prefix frontend
    npm run build --prefix backend
    npm run lint --prefix frontend
    npm run build --prefix frontend

Expected: the first scan reports only intentional GPT-5.4 role-specific guidance and explicit legacy migration code/tests; the fabricated-slug scan returns no matches; all gates pass.

- [ ] **Step 6: Commit contract and documentation**

    git add backend/scripts/assistant-runtime-check.ts backend/test/assistantRuntimeContract.test.ts frontend/test/assistantGenerationSettings.test.ts frontend/test/assistantChatPayload.test.ts frontend/src/app/components/tutorial/DocketTutorial.tsx docs/docket-ai-training-plan.md
    git commit -m "docs: explain GPT-5.6 assistant modes"

---

### Task 9: Run clean local release gates and smoke both runtimes

**Files:**

- Review all files changed by Tasks 1-8
- No new implementation file unless a test exposes a defect

- [ ] **Step 1: Inspect scope and source hygiene**

    git status --short
    git diff --check
    git diff --stat origin/main...HEAD
    git diff --name-only origin/main...HEAD
    rg -n "gpt-5\\.5-pro|gpt-5\\.5" backend/src frontend/src
    rg -n "gpt-5\\.6-(pro|sol-pro|terra-pro|luna-pro)" backend/src frontend/src
    git ls-files backend/.env frontend/.env.local

Expected:

- GPT-5.5 appears only in explicit legacy migration code if that code is under src.
- No fabricated GPT-5.6 Pro slug appears.
- No env file is tracked.
- Unrelated untracked files remain untouched.
- git diff --check reports no whitespace errors.

- [ ] **Step 2: Reinstall exactly from both lockfiles**

    npm ci --prefix backend
    npm ci --prefix frontend --legacy-peer-deps

Expected: clean installs succeed with OpenAI 6.46.0 and frontend tsx 4.22.4.

- [ ] **Step 3: Run every required static and test gate**

    npm test --prefix backend
    npm test --prefix frontend
    npm run build --prefix backend
    npm exec --prefix backend -- tsx backend/scripts/assistant-runtime-check.ts
    npm run lint --prefix frontend
    npm run build --prefix frontend

Expected: every command exits zero. Do not deploy with a skipped or known-failing gate.

- [ ] **Step 4: Smoke the compiled backend**

Run the backend in one terminal/session:

    PORT=3201 npm start --prefix backend

From a second terminal/session:

    curl -fsS http://localhost:3201/health

Expected: HTTP 200 and an OK health payload. Stop the backend process cleanly after the check. If startup fails because a required local service is absent, record the exact error and fix only code/config regressions; do not reinterpret a failed smoke as success.

- [ ] **Step 5: Smoke the compiled frontend**

Run the frontend in one terminal/session:

    PORT=3200 npm start --prefix frontend

From a second terminal/session:

    curl -fsSI http://localhost:3200/login

Expected: HTTP 200 or the established login response. Stop the frontend process cleanly.

- [ ] **Step 6: Review the complete diff**

Review behavior by file, not only the summary:

    git diff origin/main...HEAD -- backend/src/lib/llm backend/src/lib/chatTools.ts backend/src/routes backend/src/lib/llmSpend.ts backend/test
    git diff origin/main...HEAD -- frontend/src frontend/test frontend/package.json docs/docket-ai-training-plan.md

Confirm:

- Main chat resolves once at the route boundary.
- Tabular chat always passes tabular_model.
- Pro does not persist.
- Ask Inputs always includes active generation settings.
- Actual response.model drives ledger pricing.
- Tool schemas and continuation IDs remain intact.

- [ ] **Step 7: Commit only if release-gate fixes were required**

If a gate required a code change, inspect git diff --name-only, stage each verified implementation/test path explicitly, and run:

    git commit -m "fix: satisfy GPT-5.6 release gates"

Do not use git add -A or git add . because unrelated untracked files are present. If no fix was needed, do not create an empty commit.

---

### Task 10: Probe the production credential and deploy the backend first

**Files:**

- Create: docs/deployments/2026-07-10-gpt-5-6-family.md
- No secret-bearing file

- [ ] **Step 1: Capture the rollback baseline without secrets**

    OLD_API_IMAGE=$(az containerapp show --resource-group mike-prod-rg --name mike-api --query 'properties.template.containers[0].image' -o tsv)
    OLD_API_REVISION=$(az containerapp show --resource-group mike-prod-rg --name mike-api --query 'properties.latestReadyRevisionName' -o tsv)
    OLD_WEB_IMAGE=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query 'properties.template.containers[0].image' -o tsv)
    OLD_WEB_REVISION=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query 'properties.latestReadyRevisionName' -o tsv)
    printf '%s\n' "api_image=$OLD_API_IMAGE" "api_revision=$OLD_API_REVISION" "web_image=$OLD_WEB_IMAGE" "web_revision=$OLD_WEB_REVISION"

Expected baseline at planning time was mike-api--0000037 and mike-web--0000037 with the 202607092215-admin-spend-reports and 202607092230-admin-spend-reports images, but use the values read immediately before deployment as authoritative.

Create the directory with mkdir -p docs/deployments, then create docs/deployments/2026-07-10-gpt-5-6-family.md with apply_patch. Its first four lines must use the field names previous_api_image, previous_api_revision, previous_web_image, and previous_web_revision. Each field name is followed by a colon, one space, and its literal captured value. Do not insert shell expressions. This non-secret record makes rollback independent of shell-session lifetime. Add the release-evidence sections listed in Task 11 Step 9 below those four lines.

- [ ] **Step 2: Confirm the secret reference without retrieving its value**

    az containerapp show --resource-group mike-prod-rg --name mike-api --query "properties.template.containers[0].env[?name=='OPENAI_API_KEY'].{name:name,secretRef:secretRef}" -o json

Expected: OPENAI_API_KEY refers to openai-api-key. Do not use an Azure command that prints secret values.

- [ ] **Step 3: Probe the currently referenced production key inside the container**

Run a Node fetch through az containerapp exec that:

- Reads process.env.OPENAI_API_KEY only inside the production container.
- Calls POST https://api.openai.com/v1/responses once each for gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna.
- Uses a short input, max_output_tokens 32, and Standard effort none.
- Prints only model, HTTP status, returned response.model, and safe error code.
- Never prints a request header, environment variable, response request echo, or full error body.

Open an interactive container shell in a TTY-backed execution session:

    az containerapp exec --resource-group mike-prod-rg --name mike-api --command sh

After the shell prompt appears, send this exact one-line probe through the same session's stdin, then send exit:

    node -e 'const models=["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna"];(async()=>{for(const requestedModel of models){let httpStatus=null;try{const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.OPENAI_API_KEY},body:JSON.stringify({model:requestedModel,input:"Reply only OK.",max_output_tokens:32,reasoning:{effort:"none"},store:false})});httpStatus=response.status;const body=await response.json().catch(()=>({}));console.log(JSON.stringify({requested_model:requestedModel,http_status:httpStatus,response_model:typeof body.model==="string"?body.model:null,error_code:typeof body.error?.code==="string"?body.error.code:null}));if(!response.ok)process.exitCode=1;}catch{console.log(JSON.stringify({requested_model:requestedModel,http_status:httpStatus,response_model:null,error_code:"NETWORK_OR_PARSE_ERROR"}));process.exitCode=1;}}})()'

Expected: three HTTP 200 results whose returned model values identify Sol, Terra, and Luna.

- [ ] **Step 4: Replace only the approved Azure key if the probe proves it is required**

Skip this step when all three current-key probes pass. If any probe fails specifically for authentication or model access:

    set -a
    source backend/.env
    set +a
    test -n "$OPENAI_API_KEY"
    az containerapp secret set --resource-group mike-prod-rg --name mike-api --secrets openai-api-key="$OPENAI_API_KEY" --output none
    az containerapp update --resource-group mike-prod-rg --name mike-api --set-env-vars OPENAI_API_KEY=secretref:openai-api-key --output none
    unset OPENAI_API_KEY

Then repeat Step 3. Do not replace unrelated secrets or change per-user OpenAI keys. If the second probe fails, stop before deployment and report the safe status/code.

- [ ] **Step 5: Build an immutable backend image**

    API_TAG="gpt56-$(git rev-parse --short=12 HEAD)"
    az acr build --registry mikeacr9c6e79 --image "mike-api:$API_TAG" --file backend/Dockerfile backend

Expected: ACR build succeeds and produces mikeacr9c6e79.azurecr.io/mike-api:$API_TAG.

- [ ] **Step 6: Deploy backend and wait for readiness**

    API_TAG="gpt56-$(git rev-parse --short=12 HEAD)"
    az containerapp update --resource-group mike-prod-rg --name mike-api --image "mikeacr9c6e79.azurecr.io/mike-api:$API_TAG" --set-env-vars "DEPLOY_VERSION=$API_TAG"
    az containerapp show --resource-group mike-prod-rg --name mike-api --query '{latestRevisionName:properties.latestRevisionName,latestReadyRevisionName:properties.latestReadyRevisionName,image:properties.template.containers[0].image,traffic:properties.configuration.ingress.traffic}' -o json

Poll the show command at short intervals until latestRevisionName equals latestReadyRevisionName. Expected:

- Image is the new immutable tag.
- Latest equals latest ready.
- Traffic is 100 percent to the intended revision.

- [ ] **Step 7: Verify backend health and stale-client compatibility**

    curl -fsS https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io/health

Before deploying the new frontend, use the still-deployed old frontend in the user's authenticated browser:

- Start a new disposable general chat with GPT-5.5 selected and submit Reply only OK.
- Start another disposable chat with GPT-5.5 Pro selected and submit Reply only OK.
- Record both timestamps and chat IDs.
- Confirm both complete through the new backend. In Task 11's read-only ledger query, confirm their actual model is Sol; unit/integration tests remain the source of truth for the safe legacy_mapped metadata and Standard-versus-Pro mapping.

This exercises real stale-client request shapes without copying an authentication token.

Use apply_patch to add a verification_chat_ids field to the deployment record. Its value is the two unique UUIDs separated by commas, with no spaces. Task 11 extends this same field with the new-client synthetic chat UUIDs before querying the ledger.

- [ ] **Step 8: Roll back immediately if a backend gate fails**

    OLD_API_IMAGE=$(awk -F': ' '$1=="previous_api_image" {print $2}' docs/deployments/2026-07-10-gpt-5-6-family.md)
    test -n "$OLD_API_IMAGE"
    az containerapp update --resource-group mike-prod-rg --name mike-api --image "$OLD_API_IMAGE"
    az containerapp show --resource-group mike-prod-rg --name mike-api --query '{latestRevisionName:properties.latestRevisionName,latestReadyRevisionName:properties.latestReadyRevisionName,image:properties.template.containers[0].image,traffic:properties.configuration.ingress.traffic}' -o json

Wait for latest ready and health before proceeding. Preserve failure logs and do not deploy the frontend after a backend rollback.

---

### Task 11: Deploy the frontend, verify live behavior and usage, and record the release

**Files:**

- Modify: docs/deployments/2026-07-10-gpt-5-6-family.md

- [ ] **Step 1: Read and validate existing public build configuration**

Read the current public values from the deployed apps without requesting secret values:

    API_BASE_URL=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query "properties.template.containers[0].env[?name=='NEXT_PUBLIC_API_BASE_URL'].value | [0]" -o tsv)
    AZURE_TENANT_ID=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query "properties.template.containers[0].env[?name=='NEXT_PUBLIC_AZURE_TENANT_ID'].value | [0]" -o tsv)
    AZURE_CLIENT_ID=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query "properties.template.containers[0].env[?name=='NEXT_PUBLIC_AZURE_CLIENT_ID'].value | [0]" -o tsv)
    AZURE_API_SCOPE=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query "properties.template.containers[0].env[?name=='NEXT_PUBLIC_AZURE_API_SCOPE'].value | [0]" -o tsv)
    OPENAI_ENABLED=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query "properties.template.containers[0].env[?name=='NEXT_PUBLIC_OPENAI_ENABLED'].value | [0]" -o tsv)
    POSTHOG_KEY=$(az containerapp show --resource-group mike-prod-rg --name mike-api --query "properties.template.containers[0].env[?name=='POSTHOG_KEY'].value | [0]" -o tsv)
    POSTHOG_HOST=$(az containerapp show --resource-group mike-prod-rg --name mike-api --query "properties.template.containers[0].env[?name=='POSTHOG_HOST'].value | [0]" -o tsv)
    test -n "$API_BASE_URL" -a -n "$AZURE_TENANT_ID" -a -n "$AZURE_CLIENT_ID" -a -n "$AZURE_API_SCOPE" -a -n "$OPENAI_ENABLED" -a -n "$POSTHOG_KEY" -a -n "$POSTHOG_HOST"

These are public build/runtime configuration values. Do not read or print OPENAI_API_KEY.

- [ ] **Step 2: Build and deploy the immutable frontend image**

Re-read the public values in this same shell invocation so the build does not depend on variables from a prior tool call:

    API_BASE_URL=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query "properties.template.containers[0].env[?name=='NEXT_PUBLIC_API_BASE_URL'].value | [0]" -o tsv)
    AZURE_TENANT_ID=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query "properties.template.containers[0].env[?name=='NEXT_PUBLIC_AZURE_TENANT_ID'].value | [0]" -o tsv)
    AZURE_CLIENT_ID=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query "properties.template.containers[0].env[?name=='NEXT_PUBLIC_AZURE_CLIENT_ID'].value | [0]" -o tsv)
    AZURE_API_SCOPE=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query "properties.template.containers[0].env[?name=='NEXT_PUBLIC_AZURE_API_SCOPE'].value | [0]" -o tsv)
    OPENAI_ENABLED=$(az containerapp show --resource-group mike-prod-rg --name mike-web --query "properties.template.containers[0].env[?name=='NEXT_PUBLIC_OPENAI_ENABLED'].value | [0]" -o tsv)
    POSTHOG_KEY=$(az containerapp show --resource-group mike-prod-rg --name mike-api --query "properties.template.containers[0].env[?name=='POSTHOG_KEY'].value | [0]" -o tsv)
    POSTHOG_HOST=$(az containerapp show --resource-group mike-prod-rg --name mike-api --query "properties.template.containers[0].env[?name=='POSTHOG_HOST'].value | [0]" -o tsv)
    test -n "$API_BASE_URL" -a -n "$AZURE_TENANT_ID" -a -n "$AZURE_CLIENT_ID" -a -n "$AZURE_API_SCOPE" -a -n "$OPENAI_ENABLED" -a -n "$POSTHOG_KEY" -a -n "$POSTHOG_HOST"
    WEB_TAG="gpt56-$(git rev-parse --short=12 HEAD)"
    az acr build --registry mikeacr9c6e79 --image "mike-web:$WEB_TAG" --file frontend/Dockerfile --build-arg "NEXT_PUBLIC_API_BASE_URL=$API_BASE_URL" --build-arg "NEXT_PUBLIC_AZURE_TENANT_ID=$AZURE_TENANT_ID" --build-arg "NEXT_PUBLIC_AZURE_CLIENT_ID=$AZURE_CLIENT_ID" --build-arg "NEXT_PUBLIC_AZURE_API_SCOPE=$AZURE_API_SCOPE" --build-arg "NEXT_PUBLIC_OPENAI_ENABLED=$OPENAI_ENABLED" --build-arg "NEXT_PUBLIC_POSTHOG_KEY=$POSTHOG_KEY" --build-arg "NEXT_PUBLIC_POSTHOG_HOST=$POSTHOG_HOST" frontend
    az containerapp update --resource-group mike-prod-rg --name mike-web --image "mikeacr9c6e79.azurecr.io/mike-web:$WEB_TAG" --set-env-vars "DEPLOY_VERSION=$WEB_TAG"
    unset POSTHOG_KEY

Poll:

    az containerapp show --resource-group mike-prod-rg --name mike-web --query '{latestRevisionName:properties.latestRevisionName,latestReadyRevisionName:properties.latestReadyRevisionName,image:properties.template.containers[0].image,traffic:properties.configuration.ingress.traffic}' -o json

Expected: latest equals latest ready, intended image is active, and traffic is 100 percent to that revision.

- [ ] **Step 3: Verify public endpoints**

    curl -fsS https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io/health
    curl -fsSI https://docket.podlaskilegal.com/login

Expected: API OK and login HTTP 200 or the established expected login response.

- [ ] **Step 4: Verify controls and persistence in an authenticated browser**

Using the user's existing authenticated Docket browser session:

- Open a new general assistant chat.
- Confirm defaults are GPT-5.6 Sol, Medium, Standard.
- Confirm OpenAI model choices are only Sol, Terra, Luna and Claude/Gemini choices remain.
- Confirm Standard efforts are None, Low, Medium, High, X-High, Max.
- Select Low, enable Pro, and confirm effective effort is Medium.
- Change Pro to High, disable Pro, and confirm Low is restored.
- Select Terra and X-High in Standard; reload and confirm Terra/X-High persist while mode is Standard.
- Enable Pro, start a new chat, and confirm mode resets to Standard.
- Select Claude or Gemini and confirm both GPT-specific controls disappear and Pro is disabled.
- Return to a GPT-5.6 model and confirm the last Standard effort returns.
- Repeat the picker and reset check inside a project assistant chat.

- [ ] **Step 5: Run authenticated production generations**

Create identifiable, minimal synthetic turns in a disposable test chat:

- Standard Sol: Use list_documents, then reply only with the document count. Verify at least one streamed tool call and final content.
- Standard Terra: Reply exactly TERRA_STANDARD_OK.
- Standard Luna: Reply exactly LUNA_STANDARD_OK.
- Pro Sol at Medium: Reply exactly SOL_PRO_OK.
- Pro Terra at Medium: Reply exactly TERRA_PRO_OK.
- Pro Luna at Medium: Reply exactly LUNA_PRO_OK.
- In a separate disposable turn, submit: Use Ask Inputs to ask me to choose Option A or Option B before answering. Choose one option and confirm the continuation retains the active model, effort, and mode.

For each request, record timestamp, selected model, mode, effort, completion status, and chat ID. Do not record document contents or user prompts in the deployment document.

Use apply_patch to update the deployment record's verification_chat_ids value to the unique comma-separated union of the two stale-client chat UUIDs and every new-client synthetic/Ask Inputs chat UUID. Validate that every entry is a chat UUID before the ledger query.

- [ ] **Step 6: Verify actual-model ledger rows and cache accounting**

Inside the backend container, run a read-only pg query using process.env.DATABASE_URL. Select only:

- model
- provider_response_id
- route
- chat_id
- input_tokens
- cached_input_tokens
- cache_creation_5m_tokens
- output_tokens
- cost_status
- total_cost_nanos
- created_at

for exactly the recorded verification chat IDs. First validate the local value:

    VERIFICATION_CHAT_IDS=$(awk -F': ' '$1=="verification_chat_ids" {print $2}' docs/deployments/2026-07-10-gpt-5-6-family.md)
    [[ "$VERIFICATION_CHAT_IDS" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}(,[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})*$ ]]

Open a TTY-backed shell:

    az containerapp exec --resource-group mike-prod-rg --name mike-api --command sh

Through that same session's stdin, set VERIFICATION_CHAT_IDS to the already regex-validated literal value read from the deployment record. Do not substitute any unvalidated text. Then send this exact one-line read-only query and exit:

    node -e 'const {Pool}=require("pg");const chatIds=(process.env.VERIFICATION_CHAT_IDS||"").split(",").map(value=>value.trim()).filter(Boolean);if(!chatIds.length){console.error(JSON.stringify({ok:false,error_name:"MissingChatIds"}));process.exit(1)}const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});(async()=>{const result=await pool.query("select model, provider_response_id, route, chat_id, input_tokens, cached_input_tokens, cache_creation_5m_tokens, output_tokens, cost_status, total_cost_nanos, created_at from llm_usage_events where provider = $1 and chat_id = any($2::uuid[]) order by created_at asc limit 100",["openai",chatIds]);console.log(JSON.stringify(result.rows));})().catch(error=>{console.error(JSON.stringify({ok:false,error_name:error instanceof Error?error.name:"UnknownError"}));process.exitCode=1;}).finally(()=>pool.end())'

Expected:

- Rows identify gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna as actual provider models.
- Standard and Pro remain priced under the selected actual model, with no fabricated Pro slug.
- Token counts are nonnegative and cost_status is priced.
- Cache-write tokens, when reported, appear in cache_creation_5m_tokens and are not double-counted as regular input.

- [ ] **Step 7: Inspect safe production diagnostics**

    az containerapp logs show --resource-group mike-prod-rg --name mike-api --tail 200
    az containerapp logs show --resource-group mike-prod-rg --name mike-web --tail 100

Expected: no uncaught GPT-5.6 request errors, empty-response saves, repeated client reconnects, credential output, or spend-ledger errors during the synthetic window.

- [ ] **Step 8: Roll back frontend first, then backend, if any live gate fails**

    OLD_WEB_IMAGE=$(awk -F': ' '$1=="previous_web_image" {print $2}' docs/deployments/2026-07-10-gpt-5-6-family.md)
    OLD_API_IMAGE=$(awk -F': ' '$1=="previous_api_image" {print $2}' docs/deployments/2026-07-10-gpt-5-6-family.md)
    test -n "$OLD_WEB_IMAGE" -a -n "$OLD_API_IMAGE"
    az containerapp update --resource-group mike-prod-rg --name mike-web --image "$OLD_WEB_IMAGE"
    az containerapp show --resource-group mike-prod-rg --name mike-web --query '{latestRevisionName:properties.latestRevisionName,latestReadyRevisionName:properties.latestReadyRevisionName,image:properties.template.containers[0].image,traffic:properties.configuration.ingress.traffic}' -o json
    az containerapp update --resource-group mike-prod-rg --name mike-api --image "$OLD_API_IMAGE"
    az containerapp show --resource-group mike-prod-rg --name mike-api --query '{latestRevisionName:properties.latestRevisionName,latestReadyRevisionName:properties.latestReadyRevisionName,image:properties.template.containers[0].image,traffic:properties.configuration.ingress.traffic}' -o json

Wait for both latest-ready checks and repeat API/login health checks. If the Azure key was changed, leave the approved working scoped key in place unless the failure is proven credential-related; an image rollback does not require secret rollback.

- [ ] **Step 9: Record the deployment evidence**

Complete docs/deployments/2026-07-10-gpt-5-6-family.md with:

- Git commit SHA.
- Previous and deployed API/web image tags and revisions.
- Whether the existing production key passed or the approved secret was replaced.
- Exact local clean-install/test/build/lint/smoke commands and exit status.
- Endpoint and Azure latest/ready/traffic evidence.
- A six-row Standard/Pro live model matrix with selected and actual model.
- Tool-call and Ask Inputs continuation evidence.
- Ledger model/cost verification without response IDs if the repository should not retain them.
- Errors found and how they were resolved.
- Files changed.
- Remaining manual steps, including revoking the credential-like value that appeared in conversation if it was a real key.
- Confidence level and rollback images.

- [ ] **Step 10: Commit the release record and run the final verification**

    git add docs/deployments/2026-07-10-gpt-5-6-family.md
    git commit -m "docs: record GPT-5.6 deployment"
    git status --short
    git log --oneline origin/main..HEAD

Expected: only the user's pre-existing unrelated untracked files remain. Re-run:

    curl -fsS https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io/health
    curl -fsSI https://docket.podlaskilegal.com/login

## Completion Criteria

The work is complete only when all of the following are true:

- Local clean install, backend/frontend tests, backend build, frontend lint/build, and both smokes pass.
- The production credential can call all three GPT-5.6 model IDs without exposing the key.
- Backend and frontend latest revisions equal latest ready revisions, expected immutable images are active, and traffic is 100 percent.
- Sol/medium/Standard is the fresh default.
- Model and Standard effort persist; Pro never persists and resets on new chat/page load.
- All six Standard efforts and four valid Pro efforts behave as designed.
- Main GPT-5.5/5.4 choices are hidden while Claude/Gemini and GPT-5.4 role-specific choices remain.
- Normal, project, first-message, tool, and Ask Inputs requests carry the intended settings.
- Standard streams; Pro returns through the final-content path.
- The actual response model is GPT-5.6 Sol/Terra/Luna in the ledger, with priced and non-duplicated usage.
- Tutorial/training source is current and no video artifact was regenerated.
- A rollback-ready deployment record exists.
