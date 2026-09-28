import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";
import { PracticePantherConnectBanner } from "../src/components/PracticePantherConnectPrompt";

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function loadFunction(
  path: string,
  name: string,
  scope: Record<string, unknown>,
) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fn = parsed.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(fn, `Missing function: ${name}`);
  const javascript = ts.transpileModule(fn.getText(parsed).replace(/^export /, ""), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return new Function(
    "exports",
    "require",
    ...Object.keys(scope),
    `${javascript}\nreturn ${name};`,
  )(
    {},
    (id: string) => {
      assert.equal(id, "react/jsx-runtime");
      return jsxRuntime;
    },
    ...Object.values(scope),
  );
}

test("PracticePanther reminder links to the connection panel and can be dismissed", () => {
  let dismissed = false;
  const tree = PracticePantherConnectBanner({
    onDismiss: () => {
      dismissed = true;
    },
  });
  const markup = renderToStaticMarkup(tree);
  assert.match(
    markup,
    /href="\/account\/connectors#practicepanther-connection"/,
  );
  assert.match(markup, /Connect PracticePanther/);
  assert.match(markup, /aria-label="Dismiss PracticePanther reminder for this session"/);
  const dismiss = elements(tree).find((element) => element.type === "button");
  assert.ok(dismiss);
  (dismiss.props.onClick as () => void)();
  assert.equal(dismissed, true);
});

test("PracticePanther connector OAuth errors do not dispatch a Box reconnect event", async () => {
  const dispatched: string[] = [];
  const apiRequest = loadFunction("../src/app/lib/docketApi.ts", "apiRequest", {
    API_BASE: "https://api.example.com",
    getAuthHeader: async () => ({ Authorization: "Bearer test" }),
    fetch: async () =>
      new Response(
        JSON.stringify({ code: "oauth_required", detail: "Connect this account." }),
        { status: 403 },
      ),
    window: {
      dispatchEvent: (event: Event) => dispatched.push(event.type),
    },
    Event,
    DocketApiError: class extends Error {
      constructor(message: string, public status: number, public code?: string) {
        super(message);
      }
    },
  }) as (path: string, init?: RequestInit) => Promise<unknown>;

  await assert.rejects(
    apiRequest("/user/mcp-connectors/pp/refresh-tools", { method: "POST" }),
    /Connect this account/,
  );
  assert.deepEqual(dispatched, []);

  // Other OAuth errors retain the existing Box recheck behavior.
  await assert.rejects(apiRequest("/user/other-resource"), /Connect this account/);
  assert.deepEqual(dispatched, ["docket:box-auth-required"]);
});
