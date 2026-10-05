import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isValidElement, type ReactElement } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

// Exercise the actual connector panel and its handlers without a browser or
// API, the same way mcpApprovalUi.test.ts does.
function loadConnectorPanel() {
  const path = "../src/app/(pages)/account/connectors/page.tsx";
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = parsed.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "ConnectorPanel",
  );
  assert.ok(component, "Missing component: ConnectorPanel");
  const javascript = ts.transpileModule(component.getText(parsed), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("exports", "require", "RefreshCw", "Trash2", `${javascript}\nreturn ConnectorPanel;`)(
    {},
    (id: string) => {
      assert.equal(id, "react/jsx-runtime");
      return jsxRuntime;
    },
    "refresh-icon",
    "trash-icon",
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

function buttons(tree: unknown, label: string) {
  return elements(tree).filter(
    (node) => node.type === "button" && textContent(node) === label,
  );
}

const practicePanther = {
  id: "pp-connector", name: "PracticePanther MCP", managedBy: "practicepanther",
  authType: "oauth", enabled: true, oauthConnected: true, tools: [],
};

function panel(connector: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return loadConnectorPanel()({ connector, isAdmin: false, busy: null, ...options });
}

test("a user can disconnect his own connected PracticePanther account, admin or not", async () => {
  const calls: string[] = [];
  for (const isAdmin of [false, true]) {
    const tree = panel(practicePanther, {
      isAdmin,
      onPracticePantherDisconnect: async (id: string) => { calls.push(id); },
    });
    const [disconnect, ...more] = buttons(tree, "Disconnect");
    assert.ok(disconnect, "Disconnect is offered once PracticePanther is connected");
    assert.equal(more.length, 0);
    assert.equal(disconnect.props.disabled, false);
    (disconnect.props.onClick as () => void)();
    await Promise.resolve();
    // Docket's own button is still there beside it.
    assert.equal(buttons(tree, "Check connection").length, 1);
  }
  assert.deepEqual(calls, ["pp-connector", "pp-connector"]);
});

test("Disconnect is offered for a connected per-user PracticePanther connector and nothing else", () => {
  // Not connected yet: Docket's own Connect button, no Disconnect.
  const notConnected = panel({ ...practicePanther, oauthConnected: false });
  assert.equal(buttons(notConnected, "Disconnect").length, 0);
  assert.equal(buttons(notConnected, "Connect PracticePanther").length, 1);
  // The retired shared connector, Box and a custom connector never show it.
  const others = [
    { ...practicePanther, authType: "none", enabled: false, oauthConnected: false },
    { ...practicePanther, authType: "none", enabled: true },
    { id: "box", name: "Box MCP", managedBy: "box", authType: "oauth", enabled: true, oauthConnected: true, tools: [] },
    { id: "custom", name: "Custom", managedBy: null, authType: "oauth", enabled: true, oauthConnected: true, tools: [] },
  ];
  for (const connector of others) {
    for (const isAdmin of [false, true]) {
      assert.equal(buttons(panel(connector, { isAdmin }), "Disconnect").length, 0, connector.name);
    }
  }
});

test("Connect, Check connection and Disconnect are locked together while one of them is under way", () => {
  const tree = panel(practicePanther, { busy: "oauth:pp-connector" });
  assert.equal(buttons(tree, "Disconnect")[0].props.disabled, true);
  assert.equal(buttons(tree, "Checking PracticePanther")[0].props.disabled, true);
});
