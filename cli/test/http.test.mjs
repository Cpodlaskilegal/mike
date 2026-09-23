import test from "node:test";
import assert from "node:assert/strict";
import { fetchApi, pathSegment, requestJson } from "../src/http.mjs";

const config = { apiBaseUrl: "https://example.test" };

test("GET retries once with a refreshed token after 401", async () => {
  const refreshed = [];
  const requests = [];
  const value = await requestJson(config, "/projects", {
    auth: { token: async ({ forceRefresh }) => {
      refreshed.push(forceRefresh);
      return forceRefresh ? "fresh" : "stale";
    } },
    fetchImpl: async (_url, init) => {
      requests.push(init.headers.Authorization);
      return requests.length === 1
        ? Response.json({ detail: "expired" }, { status: 401 })
        : Response.json([{ id: "p1" }]);
    },
  });
  assert.deepEqual(refreshed, [false, true]);
  assert.deepEqual(requests, ["Bearer stale", "Bearer fresh"]);
  assert.deepEqual(value, [{ id: "p1" }]);
});

test("POST does not replay after 401", async () => {
  let count = 0;
  await assert.rejects(fetchApi(config, "/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "hello" }] },
    auth: { token: async () => "private-token" },
    fetchImpl: async () => {
      count++;
      return Response.json({ detail: "invalid token" }, { status: 401 });
    },
  }), /invalid token/);
  assert.equal(count, 1);
});

test("API errors use safe JSON detail and never echo non-JSON response bodies", async () => {
  await assert.rejects(requestJson(config, "/projects", {
    fetchImpl: async () => new Response("<html>secret</html>", { status: 502, headers: { "content-type": "text/html" } }),
  }), (error) => error.message === "Docket API returned HTTP 502");
  assert.equal(pathSegment("a/b"), "a%2Fb");
});
