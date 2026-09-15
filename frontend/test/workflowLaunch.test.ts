import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowLaunchMessage } from "../src/app/lib/workflowLaunch";

test("catalog launch carries the selected workflow and source files into the chat payload", () => {
    const workflow = {
        id: "system-legal-redline",
        title: "Legal redline",
        prompt_md: "The server must resolve this stored prompt.",
    };
    const message = buildWorkflowLaunchMessage(
        workflow,
        "  Revise the indemnity clause for the customer.  ",
        [{ filename: "Agreement.docx", document_id: "document-123" }],
    );

    // This is the serialized message shape passed through the assistant API.
    assert.deepEqual(JSON.parse(JSON.stringify(message)), {
        role: "user",
        content: "Revise the indemnity clause for the customer.",
        files: [{ filename: "Agreement.docx", document_id: "document-123" }],
        workflow: { id: "system-legal-redline", title: "Legal redline" },
    });
});

test("launch without inputs keeps the workflow selected and asks for required materials", () => {
    const message = buildWorkflowLaunchMessage(
        { id: "system-legal-research", title: "Legal research" },
        " \n ",
    );

    assert.deepEqual(message.workflow, {
        id: "system-legal-research",
        title: "Legal research",
    });
    assert.match(message.content, /Legal research/);
    assert.match(message.content, /Ask me for any information or documents needed/);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(message)), "files"), false);
});

test("launch preserves a custom workflow identity for server resolution", () => {
    const message = buildWorkflowLaunchMessage(
        { id: "custom-workflow-456", title: "Partner review" },
        "Review these documents.",
    );

    assert.deepEqual(message.workflow, {
        id: "custom-workflow-456",
        title: "Partner review",
    });
    assert.equal(message.content, "Review these documents.");
});
