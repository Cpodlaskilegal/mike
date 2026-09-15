import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isValidElement, type ReactElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

// Exercise the actual component output and handlers without a browser or API.
function loadComponent(
  path: string,
  name: string,
  scope: Record<string, unknown> = {},
) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = parsed.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(component, `Missing component: ${name}`);
  const javascript = ts.transpileModule(component.getText(parsed).replace(/^export /, ""), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("exports", "require", ...Object.keys(scope), `${javascript}\nreturn ${name};`)(
    {},
    (id: string) => {
      assert.equal(id, "react/jsx-runtime");
      return jsxRuntime;
    },
    ...Object.values(scope),
  );
}

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function textContent(node: unknown): string {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement<Record<string, unknown>>(node)) return textContent(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

const upload = {
  id: "upload-id", toolName: "upload_file", title: "Upload file", enabled: true,
  readOnly: false, destructive: false, requiresConfirmation: true,
};

function connectorPanel(managedBy: "box" | "practicepanther" | null, options: Record<string, unknown> = {}) {
  const ConnectorPanel = loadComponent("../src/app/(pages)/account/connectors/page.tsx", "ConnectorPanel", {
    RefreshCw: "refresh-icon", Trash2: "trash-icon",
  });
  return ConnectorPanel({
    connector: { id: "connector-id", name: "Box", managedBy, enabled: true, tools: [upload] },
    isAdmin: true, busy: null, ...options,
  });
}

test("Box write tools can be toggled and enabling one does not approve an action", () => {
  const changes: unknown[][] = [];
  const tree = connectorPanel("box", {
    isAdmin: false,
    onToolEnabled: (...args: unknown[]) => { changes.push(args); return Promise.resolve(); },
  });
  const inputs = elements(tree).filter((node) => node.type === "input");
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].props.disabled, false);
  assert.equal(inputs[1].props.checked, true);
  (inputs[1].props.onChange as (event: unknown) => void)({ target: { checked: false } });
  (inputs[1].props.onChange as (event: unknown) => void)({ target: { checked: true } });
  assert.deepEqual(changes, [
    ["connector-id", "upload-id", false], ["connector-id", "upload-id", true],
  ]);
  assert.match(textContent(tree), /initiating user.*one-time approval/i);
  assert.doesNotMatch(textContent(tree), /disabled for chat/);
});

test("custom connector confirmation tools remain blocked and busy Box toggles remain disabled", () => {
  for (const tree of [connectorPanel(null), connectorPanel("box", { busy: "tool:upload-id" })]) {
    const inputs = elements(tree).filter((node) => node.type === "input");
    assert.equal(inputs[1].props.disabled, true);
  }
  assert.match(textContent(connectorPanel(null)), /Requires confirmation; disabled for chat/);
});

function approvalCard(status: string | null, overrides: Record<string, unknown> = {}) {
  const approval = status ? {
    id: "approval-id", connectorName: "Box", toolName: "upload_file", status,
    actorEmail: "actor@example.com", argumentsPreview: { folder_id: "folder-123", name: "Pleading.docx" },
    expiresAt: "2099-01-01T00:00:00.000Z",
  } : null;
  const states: unknown[] = [approval, null, null];
  const updates: unknown[] = [];
  const decisions: unknown[][] = [];
  const Card = loadComponent("../src/app/components/assistant/message/McpApprovalCard.tsx", "McpApprovalCard", {
    useState: () => [states.shift(), (next: unknown) => updates.push(next)],
    useEffect: () => {},
    Loader2: "loader-icon",
    decideMcpApproval: async (...args: unknown[]) => { decisions.push(args); return { approval }; },
    ...overrides,
  });
  return { tree: Card({ approvalId: "approval-id", connectorName: "Box", toolName: "upload_file" }), decisions, updates };
}

test("Box approval shows the stored connector, exact action, and Docket audit attribution", () => {
  const { tree, decisions } = approvalCard("pending");
  const text = textContent(tree);
  assert.match(text, /Box change needs your approval/);
  assert.match(text, /Nothing has been sent to Box/);
  assert.match(text, /folder-123/);
  assert.match(text, /Pleading.docx/);
  assert.match(text, /actor@example.com/);
  assert.match(text, /Docket.*audit record/);
  assert.doesNotMatch(text, /PracticePanther/);
  assert.deepEqual(decisions, [], "Rendering the card must never submit approval");
});

test("approval controls submit only the stored approval ID and explicit decision", async () => {
  for (const [label, decision] of [["Approve once", "approve"], ["Deny", "reject"]]) {
    const { tree, decisions } = approvalCard("pending");
    const button = elements(tree).find((node) => node.type === "button" && textContent(node) === label);
    assert.ok(button);
    assert.equal(button.props.disabled, false);
    (button.props.onClick as () => void)();
    await Promise.resolve();
    assert.deepEqual(decisions, [["approval-id", decision]]);
  }
});

test("non-pending Box approvals never offer execution and all statuses use Box labels", () => {
  for (const status of [null, "executing", "succeeded", "indeterminate", "rejected", "expired", "failed"]) {
    const { tree, decisions } = approvalCard(status);
    assert.match(textContent(tree), /Box/);
    assert.doesNotMatch(textContent(tree), /PracticePanther/);
    assert.equal(elements(tree).filter((node) => node.type === "button").length, 0);
    assert.deepEqual(decisions, []);
  }
});
