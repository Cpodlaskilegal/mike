import assert from "node:assert/strict";
import test from "node:test";
import { toChatStreamError } from "../src/lib/chatErrors";
import {
    appendAssistantFailureMarker,
    chatStreamErrorLine,
} from "../src/lib/chatErrors";
import {
    AssistantStreamFailureError,
    buildAssistantFailurePayload,
} from "../src/lib/chatTools";

test("maps Anthropic not_found_error to model_unavailable", () => {
    const error = Object.assign(new Error("Anthropic request failed"), {
        status: 404,
        error: {
            type: "not_found_error",
            message: "The requested model does not exist.",
        },
    });

    assert.deepEqual(toChatStreamError(error), {
        type: "error",
        code: "model_unavailable",
        retryable: false,
        message:
            "The selected model is not available for this account. Choose another model or update the provider credentials.",
    });
});

test("maps Anthropic model_context_window_exceeded to request_too_large", () => {
    const error = {
        status: 400,
        error: {
            type: "model_context_window_exceeded",
            message: "The request exceeds the model context window.",
        },
    };

    assert.deepEqual(toChatStreamError(error), {
        type: "error",
        code: "request_too_large",
        retryable: false,
        message:
            "The request is too large for the selected model. Remove some documents, narrow the prompt, or start a smaller chat.",
    });
});

test("preserves partial assistant work and the original terminal subtype", () => {
    const cause = Object.assign(new Error("Final synthesis was empty"), {
        name: "TOOL_ITERATION_LIMIT",
    });
    const partial = new AssistantStreamFailureError(cause, "Draft section", [
        { type: "content", text: "Draft section" },
        { type: "doc_read", filename: "source.pdf" },
    ]);
    const classified = toChatStreamError(partial);
    assert.equal(classified.code, "tool_iteration_limit");
    assert.equal(classified.retryable, true);
    assert.deepEqual(appendAssistantFailureMarker(partial.events, classified), [
        { type: "content", text: "Draft section" },
        { type: "doc_read", filename: "source.pdf" },
        {
            type: "content",
            text: `\n\nThis response is incomplete. ${classified.message}`,
        },
    ]);
    assert.match(
        chatStreamErrorLine(partial, { runId: "run-123" }),
        /"code":"tool_iteration_limit".*"runId":"run-123"/,
    );
    const payload = buildAssistantFailurePayload(partial, classified, {});
    assert.deepEqual(payload.content, appendAssistantFailureMarker(partial.events, classified));
    assert.equal(
        payload.content.filter((event) => event.type === "content")
            .map((event) => event.text).join(""),
        `Draft section\n\nThis response is incomplete. ${classified.message}`,
    );
    assert.equal(payload.annotations, null);
    assert.equal(payload.citations, null);
});

test("empty completion remains distinct from tool exhaustion", () => {
    const error = Object.assign(new Error("No visible answer"), {
        name: "ASSISTANT_INCOMPLETE_RESPONSE",
    });
    assert.deepEqual(toChatStreamError(error), {
        type: "error",
        code: "empty_response",
        retryable: true,
        message: "Docket did not produce a visible final answer. Retry the request.",
    });
});
