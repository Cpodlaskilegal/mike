import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_MAIN_MODEL_IDS,
  ASTRA_MODEL_ID,
  ASTRA_REASONING_EFFORTS,
  ASSISTANT_GENERATION_STORAGE_KEY,
  CLAUDE_OPUS_5_REASONING_EFFORTS,
  CLAUDE_REASONING_EFFORTS,
  CLAUDE_REASONING_MODEL_IDS,
  CLAUDE_MAIN_MODEL_IDS,
  GEMINI_MAIN_MODEL_IDS,
  GPT6_MODEL_IDS,
  GPT56_MODEL_IDS,
  GPT56_REASONING_EFFORTS,
  LEGACY_ASSISTANT_MODEL_STORAGE_KEY,
  OPENAI_MAIN_MODEL_IDS,
  PRO_REASONING_EFFORTS,
  activateAssistantSession,
  adoptCreatedAssistantChat,
  assistantReasoningEffortsFor,
  defaultAssistantGenerationSettings,
  deserializeAssistantGenerationSettings,
  effectiveAssistantGenerationSettings,
  isClaudeOpus5Model,
  isClaudeReasoningModel,
  isGpt56Model,
  isOpenAiReasoningModel,
  persistAssistantGenerationSettings,
  resetAssistantSession,
  selectAssistantEffort,
  selectAssistantModel,
  serializeAssistantGenerationSettings,
  setAssistantReasoningMode,
} from "../src/app/lib/assistantGenerationSettings";
import {
  assistantRequestContinuesAfterDisconnect,
  buildAssistantGenerationPayload,
} from "../src/app/lib/assistantChatPayload";
import {
  getModelProvider,
  isModelAvailable,
} from "../src/app/lib/modelAvailability";
import {
  DEFAULT_MODEL_ID,
  MODELS,
  TABULAR_MODELS,
} from "../src/app/components/assistant/ModelToggle";

test("exports the exact GPT-5.6 model and effort contracts", () => {
  assert.deepEqual(GPT56_MODEL_IDS, [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  assert.deepEqual(GPT56_REASONING_EFFORTS, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(PRO_REASONING_EFFORTS, [
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(CLAUDE_OPUS_5_REASONING_EFFORTS, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(ASSISTANT_GENERATION_STORAGE_KEY, "docket.assistant-generation-settings.v1");
  assert.equal(LEGACY_ASSISTANT_MODEL_STORAGE_KEY, "docket.selectedModel");
});

test("GPT-6 Sol and Luna are selectable and keep their model IDs in saved and outgoing settings", () => {
  assert.deepEqual(GPT6_MODEL_IDS, ["gpt-6-sol", "gpt-6-luna"]);

  for (const [model, label] of [
    ["gpt-6-sol", "GPT-6 Sol"],
    ["gpt-6-luna", "GPT-6 Luna"],
  ] as const) {
    assert.equal(MODELS.find(({ id }) => id === model)?.label, label);
    assert.equal(TABULAR_MODELS.some(({ id }) => id === model), false);
    assert.equal(ALLOWED_MAIN_MODEL_IDS.has(model), true);
    assert.equal(isOpenAiReasoningModel(model), true);
    assert.equal(getModelProvider(model), "openai");
    assert.deepEqual(assistantReasoningEffortsFor(model, "standard"), GPT56_REASONING_EFFORTS);
    assert.deepEqual(assistantReasoningEffortsFor(model, "pro"), PRO_REASONING_EFFORTS);

    const selected = selectAssistantEffort(
      selectAssistantModel(defaultAssistantGenerationSettings(), model),
      "none",
    );
    assert.equal(selected.standardEffort, "none");
    const restored = deserializeAssistantGenerationSettings({
      versioned: serializeAssistantGenerationSettings(selected),
    });
    assert.equal(restored.model, model);
    assert.equal(restored.standardEffort, "none");
    assert.deepEqual(buildAssistantGenerationPayload(
      effectiveAssistantGenerationSettings(restored),
    ), { model, reasoning_effort: "none", reasoning_mode: "standard" });

    const pro = setAssistantReasoningMode(restored, "pro");
    assert.deepEqual(buildAssistantGenerationPayload(
      effectiveAssistantGenerationSettings(pro),
    ), { model, reasoning_effort: "medium", reasoning_mode: "pro" });
  }
});

test("offers the latest Claude models while retaining existing selections", () => {
  assert.deepEqual(CLAUDE_MAIN_MODEL_IDS, [
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ]);
  assert.deepEqual(GEMINI_MAIN_MODEL_IDS, [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
  ]);
  assert.deepEqual(new Set(ALLOWED_MAIN_MODEL_IDS), new Set([
    ...OPENAI_MAIN_MODEL_IDS,
    ...CLAUDE_MAIN_MODEL_IDS,
    ...GEMINI_MAIN_MODEL_IDS,
  ]));
  assert.deepEqual(
    MODELS.map(({ id }) => id),
    [
      ...OPENAI_MAIN_MODEL_IDS,
      ...CLAUDE_MAIN_MODEL_IDS,
      ...GEMINI_MAIN_MODEL_IDS,
    ],
  );
  assert.equal(
    TABULAR_MODELS.some(({ id }) => id === "claude-opus-5"),
    false,
  );
  assert.equal(
    MODELS.find(({ id }) => id === "claude-fable-5-1")?.label,
    "Claude Fable 5.1",
  );
  assert.deepEqual(
    TABULAR_MODELS.filter(({ group }) => group === "Anthropic").map(({ id }) => id),
    ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"],
  );
});

test("Opus 5.5 starts at Medium and keeps its effort separate from other Claude models", () => {
  const opus = selectAssistantModel(defaultAssistantGenerationSettings(), "claude-opus-5-5");
  assert.equal(MODELS.find(({ id }) => id === opus.model)?.label, "Claude Opus 5.5");
  assert.equal(TABULAR_MODELS.some(({ id }) => id === opus.model), false);
  assert.equal(ALLOWED_MAIN_MODEL_IDS.has(opus.model), true);
  assert.equal(getModelProvider(opus.model), "claude");
  assert.deepEqual(assistantReasoningEffortsFor(opus.model, "standard"), CLAUDE_REASONING_EFFORTS);
  assert.equal(opus.claudeEffort, "high");
  assert.deepEqual(effectiveAssistantGenerationSettings(opus), {
    model: "claude-opus-5-5",
    reasoningEffort: "medium",
    reasoningMode: "standard",
  });
  assert.deepEqual(buildAssistantGenerationPayload(effectiveAssistantGenerationSettings(opus)), {
    model: "claude-opus-5-5",
    reasoning_effort: "medium",
  });
  const oldPreference = deserializeAssistantGenerationSettings({
    versioned: JSON.stringify({
      version: 1,
      model: "claude-opus-5-5",
      standardEffort: "low",
      claudeEffort: "max",
    }),
  });
  assert.equal(effectiveAssistantGenerationSettings(oldPreference).reasoningEffort, "medium");
  assert.equal(oldPreference.claudeEffort, "max");
  assert.equal(effectiveAssistantGenerationSettings(
    selectAssistantModel(oldPreference, "claude-fable-5-1"),
  ).reasoningEffort, "max");
  assert.equal(JSON.parse(serializeAssistantGenerationSettings(oldPreference)).opus55Effort, undefined);

  const opusMax = selectAssistantEffort(opus, "max");
  assert.equal(opusMax.opus55Effort, "max");
  assert.equal(opusMax.claudeEffort, "high");
  const fable = selectAssistantModel(opusMax, "claude-fable-5-1");
  assert.equal(effectiveAssistantGenerationSettings(fable).reasoningEffort, "high");
  const fableXhigh = selectAssistantEffort(fable, "xhigh");
  assert.equal(fableXhigh.opus55Effort, "max");
  assert.equal(effectiveAssistantGenerationSettings(
    selectAssistantModel(fableXhigh, "claude-opus-5-5"),
  ).reasoningEffort, "max");
  const restored = deserializeAssistantGenerationSettings({
    versioned: serializeAssistantGenerationSettings(fableXhigh),
  });
  assert.equal(restored.claudeEffort, "xhigh");
  assert.equal(restored.opus55Effort, "max");
  assert.deepEqual(buildAssistantGenerationPayload(effectiveAssistantGenerationSettings(
    selectAssistantModel(restored, "claude-opus-5-5"),
  )), { model: "claude-opus-5-5", reasoning_effort: "max" });
  assert.equal(effectiveAssistantGenerationSettings(
    selectAssistantModel(restored, "claude-fable-5-1"),
  ).reasoningEffort, "xhigh");
});

test("Haiku 4.5 can be saved as a main model without reasoning-effort controls", () => {
  const haiku = selectAssistantModel(defaultAssistantGenerationSettings(), "claude-haiku-4-5");
  assert.equal(MODELS.find(({ id }) => id === haiku.model)?.label, "Claude Haiku 4.5");
  assert.equal(TABULAR_MODELS.some(({ id }) => id === haiku.model), true);
  assert.equal(ALLOWED_MAIN_MODEL_IDS.has(haiku.model), true);
  assert.equal(getModelProvider(haiku.model), "claude");
  assert.equal(isClaudeReasoningModel(haiku.model), false);
  assert.equal(assistantReasoningEffortsFor(haiku.model, "standard"), null);
  const restored = deserializeAssistantGenerationSettings({
    versioned: serializeAssistantGenerationSettings(haiku),
  });
  assert.equal(restored.model, "claude-haiku-4-5");
  assert.deepEqual(buildAssistantGenerationPayload(
    effectiveAssistantGenerationSettings(restored),
  ), { model: "claude-haiku-4-5" });
});

test("defaults the main OpenAI picker to Astra without changing tabular models", () => {
  assert.equal(ASTRA_MODEL_ID, "gpt-6-astra");
  assert.equal(MODELS.find(({ id }) => id === ASTRA_MODEL_ID)?.label, "GPT-6 Astra");
  assert.equal(ALLOWED_MAIN_MODEL_IDS.has(ASTRA_MODEL_ID), true);
  assert.equal(isOpenAiReasoningModel(ASTRA_MODEL_ID), true);
  assert.equal(isGpt56Model(ASTRA_MODEL_ID), false);
  assert.equal(TABULAR_MODELS.some(({ id }) => id === ASTRA_MODEL_ID), false);
  assert.equal(DEFAULT_MODEL_ID, ASTRA_MODEL_ID);
  assert.equal(defaultAssistantGenerationSettings().model, ASTRA_MODEL_ID);
  assert.equal(defaultAssistantGenerationSettings().standardEffort, "max");
  assert.equal(getModelProvider(ASTRA_MODEL_ID), "openai");
  const missing = { configured: false, source: null };
  assert.equal(isModelAvailable(ASTRA_MODEL_ID, {
    openai: { configured: true, source: "user" },
    claude: missing,
    courtlistener: missing,
    gemini: missing,
  }), true);
  assert.equal(isModelAvailable(ASTRA_MODEL_ID, {
    openai: missing,
    claude: missing,
    courtlistener: missing,
    gemini: missing,
  }), false);
});

test("Astra exposes Low through Max in Standard mode and supports Pro", () => {
  assert.deepEqual(ASTRA_REASONING_EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(assistantReasoningEffortsFor(ASTRA_MODEL_ID, "standard"), ASTRA_REASONING_EFFORTS);
  assert.deepEqual(assistantReasoningEffortsFor(ASTRA_MODEL_ID, "pro"), PRO_REASONING_EFFORTS);
  const astra = selectAssistantModel(defaultAssistantGenerationSettings(), ASTRA_MODEL_ID);
  assert.equal(astra.standardEffort, "max");
  assert.equal(setAssistantReasoningMode(astra, "pro").reasoningMode, "pro");
});

test("Astra normalizes None to Low when selected or restored from storage", () => {
  const none = selectAssistantEffort(
    selectAssistantModel(defaultAssistantGenerationSettings(), "gpt-5.6-sol"),
    "none",
  );
  const astra = selectAssistantModel(none, ASTRA_MODEL_ID);
  assert.equal(astra.standardEffort, "low");
  assert.equal(selectAssistantEffort(astra, "none").standardEffort, "low");

  const restored = deserializeAssistantGenerationSettings({
    versioned: JSON.stringify({ version: 1, model: ASTRA_MODEL_ID, standardEffort: "none" }),
  });
  assert.equal(restored.model, ASTRA_MODEL_ID);
  assert.equal(restored.standardEffort, "low");
  assert.equal(restored.proEffort, "medium");
  assert.deepEqual(effectiveAssistantGenerationSettings({ ...astra, standardEffort: "none" }), {
    model: ASTRA_MODEL_ID,
    reasoningEffort: "low",
    reasoningMode: "standard",
  });
  assert.equal(JSON.parse(serializeAssistantGenerationSettings({ ...astra, standardEffort: "none" })).standardEffort, "low");
  assert.equal(deserializeAssistantGenerationSettings({ legacy: ASTRA_MODEL_ID }).model, ASTRA_MODEL_ID);
});

test("Astra preserves model and effort across storage and OpenAI model switches", () => {
  const astra = selectAssistantEffort(
    selectAssistantModel(defaultAssistantGenerationSettings(), ASTRA_MODEL_ID),
    "xhigh",
  );
  const restored = deserializeAssistantGenerationSettings({
    versioned: serializeAssistantGenerationSettings(astra),
  });
  assert.equal(restored.model, ASTRA_MODEL_ID);
  assert.equal(restored.standardEffort, "xhigh");

  const pro = selectAssistantEffort(setAssistantReasoningMode(restored, "pro"), "max");
  for (const model of OPENAI_MAIN_MODEL_IDS) {
    const switched = selectAssistantModel(pro, model);
    assert.equal(switched.reasoningMode, "pro");
    assert.equal(switched.proEffort, "max");
    assert.equal(switched.standardEffort, "xhigh");
  }
});

test("Astra request payloads include supported effort and mode with durable Pro and Max", () => {
  for (const effort of ASTRA_REASONING_EFFORTS) {
    assert.deepEqual(buildAssistantGenerationPayload({
      model: ASTRA_MODEL_ID,
      reasoningEffort: effort,
      reasoningMode: "standard",
    }), {
      model: ASTRA_MODEL_ID,
      reasoning_effort: effort,
      reasoning_mode: "standard",
    });
  }
  for (const [mode, effort] of [["standard", "low"], ["pro", "medium"]] as const) {
    assert.deepEqual(buildAssistantGenerationPayload({
      model: ASTRA_MODEL_ID,
      reasoningEffort: "none",
      reasoningMode: mode,
    }), {
      model: ASTRA_MODEL_ID,
      reasoning_effort: effort,
      reasoning_mode: mode,
    });
  }
  for (const [mode, effort, durable] of [
    ["standard", "max", true],
    ["pro", "medium", true],
    ["standard", "high", false],
  ] as const) {
    assert.equal(assistantRequestContinuesAfterDisconnect(buildAssistantGenerationPayload({
      model: ASTRA_MODEL_ID,
      reasoningEffort: effort,
      reasoningMode: mode,
    })), durable);
  }
});

test("exposes exact provider-specific efforts and keeps GPT Pro off Opus 5", () => {
  assert.deepEqual(
    assistantReasoningEffortsFor("claude-opus-5", "standard"),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    assistantReasoningEffortsFor("claude-opus-5", "pro"),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    assistantReasoningEffortsFor("gpt-5.6-sol", "standard"),
    ["none", "low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    assistantReasoningEffortsFor("gpt-5.6-sol", "pro"),
    ["medium", "high", "xhigh", "max"],
  );
  assert.equal(
    assistantReasoningEffortsFor("claude-opus-4-8", "standard"),
    null,
  );
  assert.equal(isGpt56Model("claude-opus-5"), false);
});

test("exposes Claude effort controls for all current reasoning models", () => {
  assert.deepEqual(CLAUDE_REASONING_MODEL_IDS, [
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-sonnet-5",
    "claude-opus-5",
  ]);
  assert.deepEqual(CLAUDE_REASONING_EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(CLAUDE_OPUS_5_REASONING_EFFORTS, CLAUDE_REASONING_EFFORTS);
  for (const model of CLAUDE_REASONING_MODEL_IDS) {
    assert.equal(isClaudeReasoningModel(model), true);
    assert.equal(isOpenAiReasoningModel(model), false);
    assert.deepEqual(assistantReasoningEffortsFor(model, "standard"), CLAUDE_REASONING_EFFORTS);
    assert.deepEqual(assistantReasoningEffortsFor(model, "pro"), CLAUDE_REASONING_EFFORTS);
  }
  for (const model of ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5", "gpt-6-astra", null]) {
    assert.equal(isClaudeReasoningModel(model), false);
  }
});

test("existing Claude models preserve shared Claude effort separately from OpenAI settings", () => {
  const openaiPro = setAssistantReasoningMode(
    selectAssistantEffort(defaultAssistantGenerationSettings(), "xhigh"),
    "pro",
  );
  const sharedEffortModels = CLAUDE_REASONING_MODEL_IDS.filter(
    (model) => model !== "claude-opus-5-5",
  );
  for (const model of sharedEffortModels) {
    const selected = selectAssistantModel(openaiPro, model);
    assert.equal(selected.reasoningMode, "standard");
    assert.equal(selected.claudeEffort, "high");
    assert.equal(setAssistantReasoningMode(selected, "pro").reasoningMode, "standard");
    assert.equal(selectAssistantEffort(selected, "none").claudeEffort, "high");

    const edited = selectAssistantEffort(selected, "max");
    assert.equal(edited.standardEffort, "xhigh");
    const rehydrated = deserializeAssistantGenerationSettings({
      versioned: serializeAssistantGenerationSettings(edited),
    });
    assert.equal(rehydrated.model, model);
    assert.deepEqual(effectiveAssistantGenerationSettings(rehydrated), {
      model,
      reasoningEffort: "max",
      reasoningMode: "standard",
    });
    for (const nextModel of sharedEffortModels) {
      assert.equal(effectiveAssistantGenerationSettings(
        selectAssistantModel(rehydrated, nextModel),
      ).reasoningEffort, "max");
    }
    assert.equal(effectiveAssistantGenerationSettings(
      selectAssistantModel(rehydrated, ASTRA_MODEL_ID),
    ).reasoningEffort, "xhigh");
  }
});

test("older saved Claude settings hydrate with high effort and preserve the model", () => {
  for (const model of CLAUDE_MAIN_MODEL_IDS) {
    for (const snapshot of [
      { legacy: model },
      { versioned: JSON.stringify({ version: 1, model, standardEffort: "low" }) },
    ]) {
      const state = deserializeAssistantGenerationSettings(snapshot);
      assert.equal(state.model, model);
      assert.equal(state.claudeEffort, "high");
    }
  }
});

test("migrates retired Mythos selections to account-accessible Sonnet 5", () => {
  for (const snapshot of [
    {
      versioned: JSON.stringify({
        version: 1,
        model: "claude-mythos-5",
        standardEffort: "high",
      }),
      legacy: null,
    },
    { versioned: null, legacy: "claude-mythos-5" },
  ]) {
    const migrated = deserializeAssistantGenerationSettings(snapshot);
    assert.equal(migrated.model, "claude-sonnet-5");
    assert.equal(migrated.reasoningMode, "standard");
  }
});

test("defaults to Astra, GPT Max, Claude High, and Standard", () => {
  assert.deepEqual(defaultAssistantGenerationSettings(), {
    model: "gpt-6-astra",
    standardEffort: "max",
    proEffort: "max",
    claudeEffort: "high",
    reasoningMode: "standard",
    sessionKey: null,
  });
});

test("storage round-trip persists model plus independent GPT and Claude efforts", () => {
  const state = {
    ...defaultAssistantGenerationSettings(),
    model: "gpt-5.6-terra",
    standardEffort: "low" as const,
    proEffort: "max" as const,
    claudeEffort: "xhigh" as const,
    reasoningMode: "pro" as const,
    sessionKey: "assistant:123",
  };
  const serialized = serializeAssistantGenerationSettings(state);

  assert.deepEqual(JSON.parse(serialized), {
    version: 1,
    model: "gpt-5.6-terra",
    standardEffort: "low",
    claudeEffort: "xhigh",
  });
  assert.equal(serialized.includes("proEffort"), false);
  assert.equal(serialized.includes("reasoningMode"), false);
  assert.equal(serialized.includes("sessionKey"), false);
  assert.deepEqual(
    deserializeAssistantGenerationSettings({
      versioned: serialized,
      legacy: "gpt-5.5-pro",
    }),
    {
      model: "gpt-5.6-terra",
      standardEffort: "low",
      proEffort: "medium",
      claudeEffort: "xhigh",
      reasoningMode: "standard",
      sessionKey: null,
    },
  );
});

test("version-1 snapshots without a Claude effort hydrate Opus 5 at High", () => {
  const migrated = deserializeAssistantGenerationSettings({
    versioned: JSON.stringify({
      version: 1,
      model: "claude-opus-5",
      standardEffort: "low",
    }),
    legacy: null,
  });

  assert.equal(migrated.model, "claude-opus-5");
  assert.equal(migrated.standardEffort, "low");
  assert.equal(migrated.claudeEffort, "high");
  assert.deepEqual(effectiveAssistantGenerationSettings(migrated), {
    model: "claude-opus-5",
    reasoningEffort: "high",
    reasoningMode: "standard",
  });
});

test("missing, malformed, or unknown storage safely returns the default", () => {
  const invalidRecords = [
    null,
    "not-json",
    JSON.stringify({ version: 2, model: "gpt-5.6-terra", standardEffort: "high" }),
    JSON.stringify({ version: 1, model: "unknown", standardEffort: "high" }),
    JSON.stringify({ version: 1, model: "gpt-5.6-sol", standardEffort: "minimal" }),
  ];
  for (const versioned of invalidRecords) {
    assert.deepEqual(
      deserializeAssistantGenerationSettings({ versioned, legacy: null }),
      defaultAssistantGenerationSettings(),
    );
  }
});

test("a valid saved Sol preference wins over the Astra default and a conflicting legacy value", () => {
  assert.deepEqual(
    deserializeAssistantGenerationSettings({
      versioned: JSON.stringify({
        version: 1,
        model: "gpt-5.6-sol",
        standardEffort: "xhigh",
      }),
      legacy: "gpt-5.5-pro",
    }),
    {
      model: "gpt-5.6-sol",
      standardEffort: "xhigh",
      proEffort: "xhigh",
      claudeEffort: "high",
      reasoningMode: "standard",
      sessionKey: null,
    },
  );
});

test("invalid versioned data falls back to the legacy key", () => {
  assert.equal(
    deserializeAssistantGenerationSettings({
      versioned: "broken",
      legacy: "claude-sonnet-4-6",
    }).model,
    "claude-sonnet-4-6",
  );
});

test("migrates legacy GPT values once into Standard mode", () => {
  const cases = [
    ["gpt-5.5", "gpt-5.6-sol", "medium"],
    ["gpt-5.5-pro", "gpt-5.6-sol", "high"],
    ["gpt-5.4", "gpt-5.6-sol", "medium"],
    ["gpt-5.4-mini", "gpt-5.6-terra", "low"],
  ] as const;
  for (const [legacy, model, effort] of cases) {
    const migrated = deserializeAssistantGenerationSettings({
      versioned: null,
      legacy,
    });
    assert.equal(migrated.model, model, legacy);
    assert.equal(migrated.standardEffort, effort, legacy);
    assert.equal(migrated.reasoningMode, "standard", legacy);
    assert.equal(migrated.sessionKey, null, legacy);
  }
});

test("removes the legacy key only after a successful versioned write", () => {
  const events: string[] = [];
  const storage = {
    setItem(key: string, value: string) {
      events.push(`set:${key}:${JSON.parse(value).version}`);
    },
    removeItem(key: string) {
      events.push(`remove:${key}`);
    },
  };

  assert.equal(
    persistAssistantGenerationSettings(
      storage,
      defaultAssistantGenerationSettings(),
    ),
    true,
  );
  assert.deepEqual(events, [
    `set:${ASSISTANT_GENERATION_STORAGE_KEY}:1`,
    `remove:${LEGACY_ASSISTANT_MODEL_STORAGE_KEY}`,
  ]);
});

test("never removes the legacy key when the versioned write fails", () => {
  const events: string[] = [];
  const storage = {
    setItem() {
      events.push("set");
      throw new Error("storage unavailable");
    },
    removeItem(key: string) {
      events.push(`remove:${key}`);
    },
  };

  assert.equal(
    persistAssistantGenerationSettings(
      storage,
      defaultAssistantGenerationSettings(),
    ),
    false,
  );
  assert.deepEqual(events, ["set"]);
});

test("enabling GPT-5.6 Pro clamps None and Low to Medium without changing Standard", () => {
  for (const effort of ["none", "low"] as const) {
    const standard = selectAssistantEffort(
      selectAssistantModel(defaultAssistantGenerationSettings(), "gpt-5.6-sol"),
      effort,
    );
    const pro = setAssistantReasoningMode(standard, "pro");
    assert.equal(pro.standardEffort, effort);
    assert.equal(pro.proEffort, "medium");
    assert.deepEqual(effectiveAssistantGenerationSettings(pro), {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      reasoningMode: "pro",
    });
  }
});

test("enabling Pro from supported Standard efforts starts at that effort", () => {
  for (const effort of PRO_REASONING_EFFORTS) {
    const standard = selectAssistantEffort(
      defaultAssistantGenerationSettings(),
      effort,
    );
    const pro = setAssistantReasoningMode(standard, "pro");
    assert.equal(pro.standardEffort, effort);
    assert.equal(pro.proEffort, effort);
  }
});

test("editing Pro changes only Pro effort and disabling restores Standard", () => {
  const standard = selectAssistantEffort(
    defaultAssistantGenerationSettings(),
    "high",
  );
  const pro = setAssistantReasoningMode(standard, "pro");
  const edited = selectAssistantEffort(pro, "max");
  const restored = setAssistantReasoningMode(edited, "standard");

  assert.equal(edited.standardEffort, "high");
  assert.equal(edited.proEffort, "max");
  assert.deepEqual(effectiveAssistantGenerationSettings(restored), {
    model: "gpt-6-astra",
    reasoningEffort: "high",
    reasoningMode: "standard",
  });
});

test("switching among Sol, Terra, and Luna preserves active mode and effort", () => {
  let state = setAssistantReasoningMode(
    selectAssistantEffort(defaultAssistantGenerationSettings(), "xhigh"),
    "pro",
  );
  state = selectAssistantEffort(state, "max");
  for (const model of GPT56_MODEL_IDS) {
    state = selectAssistantModel(state, model);
    assert.equal(state.model, model);
    assert.equal(state.reasoningMode, "pro");
    assert.equal(state.proEffort, "max");
    assert.equal(state.standardEffort, "xhigh");
  }
});

test("switching to Claude or Gemini disables Pro and returning restores Standard effort", () => {
  const pro = setAssistantReasoningMode(
    selectAssistantEffort(defaultAssistantGenerationSettings(), "high"),
    "pro",
  );
  for (const externalModel of ["claude-sonnet-4-6", "gemini-3.1-pro-preview"]) {
    const external = selectAssistantModel(pro, externalModel);
    assert.equal(external.reasoningMode, "standard");
    assert.equal(isGpt56Model(external.model), false);
    const returned = selectAssistantModel(external, "gpt-5.6-luna");
    assert.equal(returned.standardEffort, "high");
    assert.equal(returned.reasoningMode, "standard");
  }
});

test("switching between GPT and Opus 5 preserves independent effort preferences", () => {
  const gpt = selectAssistantEffort(
    defaultAssistantGenerationSettings(),
    "xhigh",
  );
  const opus = selectAssistantModel(gpt, "claude-opus-5");

  assert.equal(isClaudeOpus5Model(opus.model), true);
  assert.equal(opus.reasoningMode, "standard");
  assert.equal(opus.standardEffort, "xhigh");
  assert.equal(opus.claudeEffort, "high");

  const editedOpus = selectAssistantEffort(opus, "max");
  assert.equal(editedOpus.standardEffort, "xhigh");
  assert.equal(editedOpus.claudeEffort, "max");
  assert.deepEqual(effectiveAssistantGenerationSettings(editedOpus), {
    model: "claude-opus-5",
    reasoningEffort: "max",
    reasoningMode: "standard",
  });

  const returnedToGpt = selectAssistantModel(editedOpus, "gpt-5.6-luna");
  assert.equal(returnedToGpt.standardEffort, "xhigh");
  assert.equal(returnedToGpt.claudeEffort, "max");
  assert.deepEqual(effectiveAssistantGenerationSettings(returnedToGpt), {
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
    reasoningMode: "standard",
  });

  const rehydrated = deserializeAssistantGenerationSettings({
    versioned: serializeAssistantGenerationSettings(returnedToGpt),
    legacy: null,
  });
  assert.equal(rehydrated.standardEffort, "xhigh");
  assert.equal(rehydrated.claudeEffort, "max");
  assert.equal(
    effectiveAssistantGenerationSettings(
      selectAssistantModel(rehydrated, "claude-opus-5"),
    ).reasoningEffort,
    "max",
  );
});

test("Opus 5 never accepts GPT-only None as its effort preference", () => {
  const opus = selectAssistantModel(
    defaultAssistantGenerationSettings(),
    "claude-opus-5",
  );
  const unchanged = selectAssistantEffort(opus, "none");

  assert.equal(unchanged.claudeEffort, "high");
});

test("resetting a session changes only mode and keeps persisted preferences", () => {
  const state = {
    ...setAssistantReasoningMode(
      selectAssistantEffort(defaultAssistantGenerationSettings(), "high"),
      "pro",
    ),
    model: "gpt-5.6-terra",
    sessionKey: "assistant:123",
  };
  const reset = resetAssistantSession(state);

  assert.equal(reset.reasoningMode, "standard");
  assert.equal(reset.model, "gpt-5.6-terra");
  assert.equal(reset.standardEffort, "high");
  assert.equal(reset.sessionKey, "assistant:123");
  assert.deepEqual(
    JSON.parse(serializeAssistantGenerationSettings(reset)),
    JSON.parse(serializeAssistantGenerationSettings(state)),
  );
});

test("first activation of the general new-chat identity starts Standard", () => {
  const pro = setAssistantReasoningMode(
    defaultAssistantGenerationSettings(),
    "pro",
  );
  const activated = activateAssistantSession(pro, "new:assistant");

  assert.equal(activated.sessionKey, "new:assistant");
  assert.equal(activated.reasoningMode, "standard");
});

test("changing between existing chat identities resets Pro", () => {
  const first = {
    ...setAssistantReasoningMode(defaultAssistantGenerationSettings(), "pro"),
    sessionKey: "assistant:first",
  };
  const second = activateAssistantSession(first, "assistant:second");

  assert.equal(second.sessionKey, "assistant:second");
  assert.equal(second.reasoningMode, "standard");
});

test("entering a project new-chat identity resets Pro", () => {
  const pro = {
    ...setAssistantReasoningMode(defaultAssistantGenerationSettings(), "pro"),
    sessionKey: "assistant:old",
  };
  const projectNew = activateAssistantSession(pro, "project:project-1:new");

  assert.equal(projectNew.sessionKey, "project:project-1:new");
  assert.equal(projectNew.reasoningMode, "standard");
});

test("a pre-created project chat resets once before auto-send and same-key activation is idempotent", () => {
  const prior = {
    ...setAssistantReasoningMode(defaultAssistantGenerationSettings(), "pro"),
    sessionKey: "assistant:prior",
  };
  const precreated = activateAssistantSession(
    prior,
    "project:project-1:chat-created-before-mount",
  );
  const userSelectedPro = setAssistantReasoningMode(precreated, "pro");
  const repeatedActivation = activateAssistantSession(
    userSelectedPro,
    "project:project-1:chat-created-before-mount",
  );

  assert.equal(precreated.reasoningMode, "standard");
  assert.equal(repeatedActivation.reasoningMode, "pro");
  assert.equal(
    repeatedActivation.sessionKey,
    "project:project-1:chat-created-before-mount",
  );
});

test("adopting the first server-created general chat ID preserves active Pro", () => {
  const newSession = activateAssistantSession(
    defaultAssistantGenerationSettings(),
    "new:assistant",
  );
  const pro = setAssistantReasoningMode(newSession, "pro");
  const adopted = adoptCreatedAssistantChat(pro, "assistant:created-1");

  assert.equal(adopted.sessionKey, "assistant:created-1");
  assert.equal(adopted.reasoningMode, "pro");
});

test("a second adoption or different existing activation resets to Standard", () => {
  const newSession = activateAssistantSession(
    defaultAssistantGenerationSettings(),
    "new:assistant",
  );
  const firstAdoption = adoptCreatedAssistantChat(
    setAssistantReasoningMode(newSession, "pro"),
    "assistant:created-1",
  );
  const secondAdoption = adoptCreatedAssistantChat(
    firstAdoption,
    "assistant:created-1",
  );
  const switched = activateAssistantSession(
    setAssistantReasoningMode(firstAdoption, "pro"),
    "assistant:other",
  );

  assert.equal(secondAdoption.reasoningMode, "standard");
  assert.equal(switched.reasoningMode, "standard");
});

test("a recreated page state is Standard even with persisted model and effort", () => {
  const hydrated = deserializeAssistantGenerationSettings({
    versioned: JSON.stringify({
      version: 1,
      model: "gpt-5.6-terra",
      standardEffort: "high",
    }),
    legacy: null,
  });

  assert.equal(hydrated.model, "gpt-5.6-terra");
  assert.equal(hydrated.standardEffort, "high");
  assert.equal(hydrated.reasoningMode, "standard");
  assert.equal(hydrated.sessionKey, null);
});

test("builds exact provider-specific generation fields", () => {
  assert.deepEqual(
    buildAssistantGenerationPayload({
      model: "claude-opus-5",
      reasoningEffort: "xhigh",
      reasoningMode: "standard",
    }),
    {
      model: "claude-opus-5",
      reasoning_effort: "xhigh",
    },
  );
  assert.deepEqual(
    buildAssistantGenerationPayload({
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      reasoningMode: "pro",
    }),
    {
      model: "gpt-5.6-terra",
      reasoning_effort: "max",
      reasoning_mode: "pro",
    },
  );
  assert.deepEqual(
    buildAssistantGenerationPayload({
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
      reasoningMode: "standard",
    }),
    { model: "claude-sonnet-4-6" },
  );
});

test("all current Claude models emit effort without OpenAI Pro mode", () => {
  for (const model of CLAUDE_REASONING_MODEL_IDS) {
    for (const reasoningEffort of CLAUDE_REASONING_EFFORTS) {
      const payload = buildAssistantGenerationPayload({
        model,
        reasoningEffort,
        reasoningMode: "pro",
      });
      assert.deepEqual(payload, { model, reasoning_effort: reasoningEffort });
      assert.equal(assistantRequestContinuesAfterDisconnect(payload), reasoningEffort === "max");
    }
    assert.deepEqual(buildAssistantGenerationPayload({
      model,
      reasoningEffort: "none",
      reasoningMode: "pro",
    }), { model, reasoning_effort: "high" });
  }
});

test("knows Pro and Max requests survive a disconnect before stream_start", () => {
  assert.equal(
    assistantRequestContinuesAfterDisconnect({
      model: "claude-opus-5",
      reasoning_effort: "max",
    }),
    true,
  );
  assert.equal(
    assistantRequestContinuesAfterDisconnect({
      model: "gpt-5.6-sol",
      reasoning_mode: "pro",
      reasoning_effort: "medium",
    }),
    true,
  );
  assert.equal(
    assistantRequestContinuesAfterDisconnect({
      model: "gpt-5.6-sol",
      reasoning_mode: "standard",
      reasoning_effort: "max",
    }),
    true,
  );
  assert.equal(
    assistantRequestContinuesAfterDisconnect({
      model: "gpt-5.6-sol",
      reasoning_mode: "standard",
      reasoning_effort: "high",
    }),
    false,
  );
});
