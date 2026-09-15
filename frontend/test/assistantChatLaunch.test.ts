import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { buildWorkflowLaunchMessage } from "../src/app/lib/workflowLaunch";

const source = readFileSync(
    new URL("../src/app/(pages)/assistant/chat/[id]/page.tsx", import.meta.url),
    "utf8",
);
const parsed = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Exercise the page's actual effect callbacks without adding a DOM dependency.
function pageEffectContaining(marker: string, scope: Record<string, unknown>) {
    let callback: ts.ArrowFunction | undefined;
    function visit(node: ts.Node) {
        if (
            ts.isCallExpression(node) &&
            node.expression.getText(parsed) === "useEffect" &&
            node.arguments[0] &&
            ts.isArrowFunction(node.arguments[0]) &&
            node.arguments[0].getText(parsed).includes(marker)
        ) {
            callback = node.arguments[0];
        }
        ts.forEachChild(node, visit);
    }
    visit(parsed);
    assert.ok(callback, `Missing page effect: ${marker}`);
    new Function(...Object.keys(scope), `return (${callback.getText(parsed)})();`)(...Object.values(scope));
}

test("standalone launch keeps its initial message snapshot after pending context is consumed", () => {
    assert.match(source, /const \[initialMessages\] = useState\(\(\) => newChatMessages \?\? \[\]\)/);
});

test("workflow launch survives delayed session readiness and is sent exactly once", () => {
    const message = buildWorkflowLaunchMessage(
        { id: "builtin-legal-research", title: "Research a Legal Question" },
        "Research the uploaded authorities.",
        [{ filename: "Opinion.pdf", document_id: "source-123" }],
    );
    const initialMessages = [message];
    let pending: typeof initialMessages | null = initialMessages;
    const hasAutoSent = { current: false };
    const sent: unknown[] = [];
    const setNewChatMessages = (value: typeof pending) => { pending = value; };

    pageEffectContaining("getChat(id)", {
        initialMessages,
        newChatMessages: pending,
        setNewChatMessages,
        hasLoaded: { current: false },
        messages: initialMessages,
        getChat: () => { assert.fail("A queued launch must not fetch empty chat history"); },
    });
    assert.equal(pending, initialMessages, "The load effect must retain the launch while settings initialize");

    const scope = {
        newChatMessages: pending,
        messages: initialMessages,
        hasAutoSent,
        isResponseLoading: true,
        setNewChatMessages,
        handleChat: (value: unknown) => { sent.push(value); },
    };
    pageEffectContaining("handleChat(", scope);
    assert.deepEqual(sent, []);
    assert.equal(pending, initialMessages);
    assert.equal(hasAutoSent.current, false);

    pageEffectContaining("handleChat(", { ...scope, isResponseLoading: false });
    assert.deepEqual(sent, [message]);
    assert.equal(pending, null);
    assert.equal(hasAutoSent.current, true);

    // Even an effect replay with the previous context snapshot cannot resend it.
    pageEffectContaining("handleChat(", { ...scope, isResponseLoading: false });
    assert.deepEqual(sent, [message]);
});
