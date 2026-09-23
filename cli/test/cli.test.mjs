import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, runCli } from "../src/cli.mjs";

test("argument parser maps read routes and ask options", () => {
  assert.deepEqual(parseArgs(["projects", "show", "project 1", "--json"]), {
    action: "projects.show", id: "project 1", json: true,
  });
  assert.deepEqual(parseArgs(["documents", "list", "--project", "abc"]), {
    action: "documents.list", projectId: "abc", json: false,
  });
  assert.deepEqual(parseArgs(["ask", "Summarize this matter", "--project", "p1", "--chat", "c1"]), {
    action: "ask", prompt: "Summarize this matter", projectId: "p1", chatId: "c1", json: false,
  });
  assert.throws(() => parseArgs(["workflows", "list", "--type", "other"]), /assistant or tabular/);
  assert.throws(() => parseArgs(["ask", "--chat", "c1"]), /requires a prompt/);
});

test("projects list sends a bearer token and emits JSON without the token", async () => {
  const out = [];
  const calls = [];
  await runCli(["projects", "list", "--json"], {
    stdout: { write: (value) => out.push(value) },
    stderr: { write() {} },
    authFactory: async () => ({ token: async () => "private-token" }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json([{ id: "p1", name: "Matter" }]);
    },
  });
  assert.equal(calls[0].url.endsWith("/projects"), true);
  assert.equal(calls[0].init.headers.Authorization, "Bearer private-token");
  assert.deepEqual(JSON.parse(out.join("")), [{ id: "p1", name: "Matter" }]);
  assert.equal(out.join("").includes("private-token"), false);
});

test("health runs without loading auth", async () => {
  const out = [];
  await runCli(["health", "--json"], {
    stdout: { write: (value) => out.push(value) },
    authFactory: async () => { throw new Error("auth should not load"); },
    fetchImpl: async (url, init) => {
      assert.equal(url.endsWith("/health"), true);
      assert.equal(init.headers.Authorization, undefined);
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(JSON.parse(out.join("")), { ok: true });
});
