import assert from "node:assert/strict";
import test from "node:test";
import { toChatStreamError } from "../src/lib/chatErrors";

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
