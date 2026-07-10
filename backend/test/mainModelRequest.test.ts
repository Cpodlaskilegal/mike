import assert from "node:assert/strict";
import test from "node:test";
import {
    DEFAULT_MAIN_MODEL,
    DEFAULT_TABULAR_MODEL,
    GPT_5_6_REASONING_EFFORTS,
    OPENAI_MAIN_MODELS,
    isTabularModelId,
    parseMainModelRequest,
    resolveMainModelRequest,
    resolveTabularModel,
} from "../src/lib/llm/models";

test("defines the canonical GPT-5.6 main-model contract", () => {
    assert.deepEqual(OPENAI_MAIN_MODELS, [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
    ]);
    assert.equal(DEFAULT_MAIN_MODEL, "gpt-5.6-sol");
    assert.deepEqual(GPT_5_6_REASONING_EFFORTS, [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]);
});

test("defaults an omitted main model to Sol, Medium, and Standard", () => {
    assert.deepEqual(resolveMainModelRequest({}), {
        requestedModel: null,
        selectionModel: "gpt-5.6-sol",
        providerModel: "gpt-5.6-sol",
        provider: "openai",
        reasoningEffort: "medium",
        reasoningMode: "standard",
        status: "defaulted",
    });
});

test("preserves each canonical GPT-5.6 provider slug and valid effort", () => {
    const cases = [
        ["gpt-5.6-sol", "none"],
        ["gpt-5.6-terra", "xhigh"],
        ["gpt-5.6-luna", "max"],
    ] as const;

    for (const [model, effort] of cases) {
        assert.deepEqual(
            resolveMainModelRequest({
                model,
                reasoning_effort: effort,
                reasoning_mode: "standard",
            }),
            {
                requestedModel: model,
                selectionModel: model,
                providerModel: model,
                provider: "openai",
                reasoningEffort: effort,
                reasoningMode: "standard",
                status: "direct",
            },
        );
    }
});

test("clamps Pro None and Low requests to Medium", () => {
    for (const effort of ["none", "low"] as const) {
        const resolved = resolveMainModelRequest({
            model: "gpt-5.6-sol",
            reasoning_effort: effort,
            reasoning_mode: "pro",
        });
        assert.equal(resolved.reasoningMode, "pro");
        assert.equal(resolved.reasoningEffort, "medium");
    }
});

test("returns field-specific validation errors for invalid effort and mode values", () => {
    const cases = [
        [{ model: "gpt-5.6-sol", reasoning_effort: "minimal" }, /reasoning_effort/],
        [{ model: "gpt-5.6-sol", reasoning_effort: "turbo" }, /reasoning_effort/],
        [{ model: "gpt-5.6-sol", reasoning_mode: "turbo" }, /reasoning_mode/],
    ] as const;

    for (const [body, detailPattern] of cases) {
        const result = parseMainModelRequest(body);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.detail, detailPattern);
    }
});

test("rejects explicit malformed model values but defaults an omitted model", () => {
    const invalidModels: unknown[] = [null, 7, [], {}, "", "   "];

    for (const model of invalidModels) {
        const result = parseMainModelRequest({ model });
        assert.equal(result.ok, false, `expected ${JSON.stringify(model)} to fail`);
        if (!result.ok) assert.match(result.detail, /model/);
    }

    assert.deepEqual(parseMainModelRequest({}), {
        ok: true,
        value: {
            requestedModel: null,
            selectionModel: "gpt-5.6-sol",
            providerModel: "gpt-5.6-sol",
            provider: "openai",
            reasoningEffort: "medium",
            reasoningMode: "standard",
            status: "defaulted",
        },
    });
});

test("rejects malformed reasoning fields for canonical and fallback OpenAI requests", () => {
    const models = ["gpt-5.6-sol", "future-main-model"];
    const malformed: unknown[] = [null, 9, [], {}, "turbo"];

    for (const model of models) {
        for (const reasoning_effort of malformed) {
            const result = parseMainModelRequest({ model, reasoning_effort });
            assert.equal(result.ok, false);
            if (!result.ok) assert.match(result.detail, /reasoning_effort/);
        }
        for (const reasoning_mode of malformed) {
            const result = parseMainModelRequest({ model, reasoning_mode });
            assert.equal(result.ok, false);
            if (!result.ok) assert.match(result.detail, /reasoning_mode/);
        }
    }
});

test("retains Claude and Gemini selections while stripping GPT-only fields", () => {
    const cases = [
        ["claude-fable-5", "claude"],
        ["gemini-3.1-pro-preview", "gemini"],
    ] as const;

    for (const [model, provider] of cases) {
        for (const fields of [
            { reasoning_effort: "max", reasoning_mode: "pro" },
            { reasoning_effort: null, reasoning_mode: { malformed: true } },
        ]) {
            assert.deepEqual(parseMainModelRequest({ model, ...fields }), {
                ok: true,
                value: {
                    requestedModel: model,
                    selectionModel: model,
                    providerModel: model,
                    provider,
                    status: "direct",
                },
            });
        }
    }
});

test("falls back unknown non-empty model strings to Sol with observability status", () => {
    assert.deepEqual(
        parseMainModelRequest({
            model: "future-main-model",
            reasoning_effort: "high",
            reasoning_mode: "pro",
        }),
        {
            ok: true,
            value: {
                requestedModel: "future-main-model",
                selectionModel: "gpt-5.6-sol",
                providerModel: "gpt-5.6-sol",
                provider: "openai",
                reasoningEffort: "high",
                reasoningMode: "pro",
                status: "unknown_fallback",
            },
        },
    );
});

test("treats object prototype keys as unknown model strings", () => {
    for (const requestedModel of ["toString", "__proto__"]) {
        assert.deepEqual(resolveMainModelRequest({ model: requestedModel }), {
            requestedModel,
            selectionModel: "gpt-5.6-sol",
            providerModel: "gpt-5.6-sol",
            provider: "openai",
            reasoningEffort: "medium",
            reasoningMode: "standard",
            status: "unknown_fallback",
        });
    }
});

test("maps legacy main selections without changing their intended semantics", () => {
    const cases = [
        ["gpt-5.5", "gpt-5.6-sol", "medium", "standard"],
        ["gpt-5.5-pro", "gpt-5.6-sol", "high", "pro"],
        ["gpt-5.4", "gpt-5.6-sol", "medium", "standard"],
        ["gpt-5.4-mini", "gpt-5.6-terra", "low", "standard"],
    ] as const;

    for (const [requestedModel, selectionModel, reasoningEffort, reasoningMode] of cases) {
        assert.deepEqual(resolveMainModelRequest({ model: requestedModel }), {
            requestedModel,
            selectionModel,
            providerModel: selectionModel,
            provider: "openai",
            reasoningEffort,
            reasoningMode,
            status: "legacy_mapped",
        });
    }
});

test("keeps main-only GPT-5.6 IDs out of tabular model resolution", () => {
    for (const model of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]) {
        assert.equal(isTabularModelId(model), true);
        assert.equal(resolveTabularModel(model), model);
    }

    assert.equal(isTabularModelId("gpt-5.6-sol"), false);
    assert.equal(resolveTabularModel("gpt-5.6-sol"), DEFAULT_TABULAR_MODEL);
});
