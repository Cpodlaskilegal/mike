import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    AssistantStreamAbortError,
    appendCancellationMarker,
    isAbortError,
    throwIfAborted,
} from "../src/lib/llm/types";

test("turns an aborted assistant signal into a recognizable abort error", () => {
    const controller = new AbortController();
    controller.abort();

    assert.throws(
        () => throwIfAborted(controller.signal),
        (error: unknown) => isAbortError(error),
    );
});

test("keeps buffered content and reasoning with exactly one cancellation marker", () => {
    const events = appendCancellationMarker([
        { type: "reasoning", text: "Checking the agreement." },
        {
            type: "content",
            text: "The agreement requires notice.",
        },
        { type: "content", text: "Cancelled by user." },
    ]);

    assert.deepEqual(events, [
        { type: "reasoning", text: "Checking the agreement." },
        { type: "content", text: "The agreement requires notice." },
        { type: "content", text: "Cancelled by user." },
    ]);
});

test("carries partial assistant state across a cancelled provider stream", () => {
    const events = [{ type: "content", text: "Partial answer" }];
    const error = new AssistantStreamAbortError("Partial answer", events);

    assert.equal(error.fullText, "Partial answer");
    assert.deepEqual(error.events, events);
    assert.equal(isAbortError(error), true);
    assert.equal(
        appendCancellationMarker(error.events).some(
            (event) =>
                event.type === "content" &&
                "text" in event &&
                event.text === "The assistant failed before it could finish.",
        ),
        false,
    );
});

test("stops later tool dispatch while retaining the completed tool outcome", async () => {
    process.env.DATABASE_URL ??=
        "postgresql://docket:test@127.0.0.1:5432/docket";
    const { runToolCalls } = await import("../src/lib/chatTools");
    const controller = new AbortController();

    const result = await runToolCalls(
        [
            {
                id: "first-tool",
                function: {
                    name: "read_workflow",
                    arguments: JSON.stringify({ workflow_id: "review" }),
                },
            },
            {
                id: "second-tool",
                function: { name: "list_workflows", arguments: "{}" },
            },
        ],
        new Map(),
        "test-user",
        {} as never,
        () => controller.abort(),
        new Map([["review", { title: "Review", prompt_md: "Review it." }]]),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        controller.signal,
    );

    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(result.workflowsApplied, [
        { workflow_id: "review", title: "Review" },
    ]);
    assert.deepEqual(result.toolResults, [
        {
            role: "tool",
            tool_call_id: "first-tool",
            content: "Review it.",
        },
    ]);
});

test("does not begin a tool batch when its signal is already aborted", async () => {
    process.env.DATABASE_URL ??=
        "postgresql://docket:test@127.0.0.1:5432/docket";
    const { runToolCalls } = await import("../src/lib/chatTools");
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        runToolCalls(
            [
                {
                    id: "never-started",
                    function: { name: "list_workflows", arguments: "{}" },
                },
            ],
            new Map(),
            "test-user",
            {} as never,
            () => undefined,
            new Map(),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            controller.signal,
        ),
        (error: unknown) => isAbortError(error),
    );
});

test("persists completed tool events before the stream raises cancellation", async () => {
    const source = await readFile(
        new URL("../src/lib/chatTools.ts", import.meta.url),
        "utf8",
    );
    const toolDispatch = source.indexOf("} = await runToolCalls(");
    const workflowEventPush = source.indexOf(
        "for (const wf of workflowsApplied)",
        toolDispatch,
    );
    const abortAfterDispatch = source.indexOf(
        "throwIfAborted(signal);",
        toolDispatch + 1,
    );

    assert.ok(toolDispatch >= 0, "runLLMStream should call runToolCalls");
    assert.ok(
        workflowEventPush > toolDispatch,
        "runLLMStream should collect completed tool events",
    );
    assert.ok(
        workflowEventPush < abortAfterDispatch,
        "runLLMStream must preserve completed tool events before cancellation",
    );
});
