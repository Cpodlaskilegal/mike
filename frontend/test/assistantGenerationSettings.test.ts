import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_MAIN_MODEL_IDS,
  ASSISTANT_GENERATION_STORAGE_KEY,
  CLAUDE_MAIN_MODEL_IDS,
  GEMINI_MAIN_MODEL_IDS,
  GPT56_MODEL_IDS,
  GPT56_REASONING_EFFORTS,
  LEGACY_ASSISTANT_MODEL_STORAGE_KEY,
  PRO_REASONING_EFFORTS,
  activateAssistantSession,
  adoptCreatedAssistantChat,
  defaultAssistantGenerationSettings,
  deserializeAssistantGenerationSettings,
  effectiveAssistantGenerationSettings,
  isGpt56Model,
  persistAssistantGenerationSettings,
  resetAssistantSession,
  selectAssistantEffort,
  selectAssistantModel,
  serializeAssistantGenerationSettings,
  setAssistantReasoningMode,
} from "../src/app/lib/assistantGenerationSettings";
import { buildAssistantGenerationPayload } from "../src/app/lib/assistantChatPayload";

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
  assert.equal(ASSISTANT_GENERATION_STORAGE_KEY, "docket.assistant-generation-settings.v1");
  assert.equal(LEGACY_ASSISTANT_MODEL_STORAGE_KEY, "docket.selectedModel");
});

test("keeps the existing Claude and Gemini main-model inventories", () => {
  assert.deepEqual(CLAUDE_MAIN_MODEL_IDS, [
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
  ]);
  assert.deepEqual(GEMINI_MAIN_MODEL_IDS, [
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
  ]);
  assert.deepEqual(new Set(ALLOWED_MAIN_MODEL_IDS), new Set([
    ...GPT56_MODEL_IDS,
    ...CLAUDE_MAIN_MODEL_IDS,
    ...GEMINI_MAIN_MODEL_IDS,
  ]));
});

test("defaults to Sol, Medium, and Standard", () => {
  assert.deepEqual(defaultAssistantGenerationSettings(), {
    model: "gpt-5.6-sol",
    standardEffort: "medium",
    proEffort: "medium",
    reasoningMode: "standard",
    sessionKey: null,
  });
});

test("storage round-trip persists only model and Standard effort", () => {
  const state = {
    ...defaultAssistantGenerationSettings(),
    model: "gpt-5.6-terra",
    standardEffort: "low" as const,
    proEffort: "max" as const,
    reasoningMode: "pro" as const,
    sessionKey: "assistant:123",
  };
  const serialized = serializeAssistantGenerationSettings(state);

  assert.deepEqual(JSON.parse(serialized), {
    version: 1,
    model: "gpt-5.6-terra",
    standardEffort: "low",
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
      reasoningMode: "standard",
      sessionKey: null,
    },
  );
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

test("a valid versioned record wins over a conflicting legacy value", () => {
  assert.deepEqual(
    deserializeAssistantGenerationSettings({
      versioned: JSON.stringify({
        version: 1,
        model: "gpt-5.6-luna",
        standardEffort: "xhigh",
      }),
      legacy: "gpt-5.5-pro",
    }),
    {
      model: "gpt-5.6-luna",
      standardEffort: "xhigh",
      proEffort: "xhigh",
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

test("enabling Pro clamps None and Low to Medium without changing Standard", () => {
  for (const effort of ["none", "low"] as const) {
    const standard = selectAssistantEffort(
      defaultAssistantGenerationSettings(),
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
    model: "gpt-5.6-sol",
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

test("builds exact GPT generation fields and omits them for other providers", () => {
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
