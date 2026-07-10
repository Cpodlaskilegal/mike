import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    DEFAULT_MAIN_MODEL,
    DEFAULT_TABULAR_MODEL,
    DEFAULT_TITLE_MODEL,
    GPT_5_6_REASONING_EFFORTS,
    OPENAI_MAIN_MODELS,
    isTabularModelId,
    parseMainModelRequest,
    resolveMainModelRequest,
    resolveTabularModel,
} from "../src/lib/llm/models";

const backendRoot = new URL("..", import.meta.url).pathname;

function readBackendSource(relativePath: string): string {
    return readFileSync(`${backendRoot}/${relativePath}`, "utf8");
}

function sourceSection(
    source: string,
    startMarker: string,
    endMarker?: string,
): string {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, `${startMarker} should be present`);
    const end = endMarker
        ? source.indexOf(endMarker, start + startMarker.length)
        : -1;
    return source.slice(start, end < 0 ? undefined : end);
}

test("defines the canonical GPT-5.6 main-model contract", () => {
    assert.deepEqual(OPENAI_MAIN_MODELS, [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
    ]);
    assert.equal(DEFAULT_MAIN_MODEL, "gpt-5.6-sol");
    assert.equal(DEFAULT_TITLE_MODEL, "gpt-5.4-nano");
    assert.equal(DEFAULT_TABULAR_MODEL, "gpt-5.4-mini");
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
        [
            { model: "gpt-5.6-sol", reasoning_effort: "minimal" },
            /reasoning_effort/,
        ],
        [
            { model: "gpt-5.6-sol", reasoning_effort: "turbo" },
            /reasoning_effort/,
        ],
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
        assert.equal(
            result.ok,
            false,
            `expected ${JSON.stringify(model)} to fail`,
        );
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

    for (const [
        requestedModel,
        selectionModel,
        reasoningEffort,
        reasoningMode,
    ] of cases) {
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

test("main chat routes resolve the raw request before persistence and SSE", () => {
    for (const relativePath of [
        "src/routes/chat.ts",
        "src/routes/projectChat.ts",
    ]) {
        const source = readBackendSource(relativePath);
        const parseIndex = source.indexOf("parseMainModelRequest(req.body)");
        const placeholderIndex = source.indexOf(
            'role: "assistant"',
            parseIndex,
        );
        const flushIndex = source.indexOf("res.flushHeaders()", parseIndex);

        assert.notEqual(
            parseIndex,
            -1,
            `${relativePath} should parse the raw body`,
        );
        assert.notEqual(
            placeholderIndex,
            -1,
            `${relativePath} should persist an assistant placeholder`,
        );
        assert.notEqual(
            flushIndex,
            -1,
            `${relativePath} should flush SSE headers`,
        );
        assert.ok(
            parseIndex < placeholderIndex,
            `${relativePath} should parse before the assistant placeholder`,
        );
        assert.ok(
            parseIndex < flushIndex,
            `${relativePath} should parse before SSE headers are flushed`,
        );

        const validationSection = source.slice(parseIndex, placeholderIndex);
        assert.match(validationSection, /if\s*\(\s*!parsedMainModel\.ok\s*\)/);
        assert.match(
            validationSection,
            /status\(400\)[\s\S]*?json\(\{\s*detail:\s*parsedMainModel\.detail\s*\}\)/,
        );

        const streamCall = sourceSection(source, "runLLMStream({", "});");
        assert.match(streamCall, /model:\s*mainModelRequest\.providerModel/);
        assert.match(
            streamCall,
            /reasoningEffort:\s*mainModelRequest\.reasoningEffort/,
        );
        assert.match(
            streamCall,
            /reasoningMode:\s*mainModelRequest\.reasoningMode/,
        );
        assert.match(
            streamCall,
            /modelResolution:\s*\{[\s\S]*?requestedModel:\s*mainModelRequest\.requestedModel[\s\S]*?resolvedModel:\s*mainModelRequest\.providerModel[\s\S]*?status:\s*mainModelRequest\.status[\s\S]*?\}/,
        );
    }
});

test("runLLMStream requires and forwards an already resolved model contract", () => {
    const source = readBackendSource("src/lib/chatTools.ts");
    const runLlmStream = sourceSection(
        source,
        "export async function runLLMStream",
    );
    const signature = runLlmStream.slice(0, runLlmStream.indexOf("): Promise"));

    assert.match(signature, /\bmodel:\s*string\b/);
    assert.doesNotMatch(signature, /\bmodel\?:\s*string\b/);
    assert.match(signature, /\breasoningEffort\?:\s*ReasoningEffort\b/);
    assert.match(signature, /\breasoningMode\?:\s*ReasoningMode\b/);
    assert.match(signature, /\bmodelResolution\?:\s*\{/);
    assert.doesNotMatch(runLlmStream, /\bresolveModel\s*\(/);
    assert.doesNotMatch(runLlmStream, /\bDEFAULT_MAIN_MODEL\b/);
    assert.match(runLlmStream, /streamChatWithTools\(\{[\s\S]*?\bmodel,/);
    assert.match(runLlmStream, /\breasoningEffort,/);
    assert.match(runLlmStream, /\breasoningMode,/);
    for (const metadataKey of [
        "requested_model",
        "resolved_model",
        "model_resolution_status",
        "reasoning_effort",
        "reasoning_mode",
    ]) {
        assert.match(runLlmStream, new RegExp(`\\b${metadataKey}:`));
    }
});

test("tabular chat binds runLLMStream to the resolved tabular profile model", () => {
    const source = readBackendSource("src/routes/tabular.ts");
    const chatRoute = sourceSection(
        source,
        'tabularRouter.post("/:reviewId/chat"',
    );

    assert.match(
        chatRoute,
        /const\s*\{\s*tabular_model:\s*tabularModel,\s*api_keys:\s*apiKeys,?\s*\}\s*=\s*await\s+getUserModelSettings\(\s*userId,\s*db,?\s*\)/,
    );
    assert.doesNotMatch(chatRoute, /getUserApiKeys\s*\(/);
    const streamCall = sourceSection(chatRoute, "runLLMStream({", "});");
    assert.match(streamCall, /\bmodel:\s*tabularModel\b/);
    assert.match(streamCall, /\bapiKeys,/);
    assert.doesNotMatch(streamCall, /\breasoningEffort\b|\breasoningMode\b/);
});

test("profile reads and updates contain tabular-only model IDs", () => {
    const settingsSource = readBackendSource("src/lib/userSettings.ts");
    assert.match(
        settingsSource,
        /tabular_model:\s*resolveTabularModel\(\s*data\?\.tabular_model\s*\)/,
    );
    assert.doesNotMatch(
        settingsSource,
        /tabular_model:\s*resolveModel\(\s*data\?\.tabular_model/,
    );

    const userRouteSource = readBackendSource("src/routes/user.ts");
    assert.match(
        userRouteSource,
        /tabularModel:\s*resolveTabularModel\(\s*row\.tabular_model\s*\)/,
    );
    const tabularUpdate = sourceSection(
        userRouteSource,
        'if ("tabularModel" in raw)',
        'if ("legalResearchUs" in raw)',
    );
    assert.match(tabularUpdate, /!isTabularModelId\(\s*raw\.tabularModel\s*\)/);
    assert.match(tabularUpdate, /detail:\s*"Unsupported tabularModel"/);
    assert.match(
        tabularUpdate,
        /update\.tabular_model\s*=\s*raw\.tabularModel/,
    );
    assert.doesNotMatch(tabularUpdate, /resolveModel\s*\(/);
});

test("title and structured-output paths remain on their role-specific models", () => {
    const chatSource = readBackendSource("src/routes/chat.ts");
    assert.match(
        chatSource,
        /completeText\(\{\s*model:\s*title_model[\s\S]*?reasoningEffort:\s*"none"/,
    );

    const tabularSource = readBackendSource("src/routes/tabular.ts");
    const extraction = sourceSection(
        tabularSource,
        "async function queryGemini(",
        "async function generateChatTitle(",
    );
    assert.match(extraction, /completeText\(\{\s*model,/);
    assert.match(extraction, /textFormat:\s*TABULAR_CELL_RESULT_FORMAT/);

    const bulkExtraction = sourceSection(
        tabularSource,
        "async function queryGeminiAllColumns(",
    );
    assert.match(bulkExtraction, /completeText\(\{\s*model,/);
    assert.match(bulkExtraction, /name:\s*"tabular_bulk_cell_results"/);
});
