import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";

const backendRoot = new URL("..", import.meta.url).pathname;

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

async function loadRequireAdmin() {
  return import("../src/middleware/requireAdmin");
}

function responseFor(userId?: string) {
  const state: { statusCode?: number; body?: unknown } = {};
  const response = {
    locals: userId ? { userId } : {},
    status(statusCode: number) {
      state.statusCode = statusCode;
      return response;
    },
    json(body: unknown) {
      state.body = body;
      return response;
    },
  };
  return { response: response as unknown as Response, state };
}

test("requireAdmin rejects a non-admin before the protected handler", async () => {
  const { response, state } = responseFor("member-1");
  let nextCalls = 0;
  const { createRequireAdmin } = await loadRequireAdmin();

  await createRequireAdmin(async () => false)(
    {} as Request,
    response,
    (() => {
      nextCalls += 1;
    }) as NextFunction,
  );

  assert.equal(nextCalls, 0);
  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, { detail: "Admin access required" });
});

test("requireAdmin lets an admin proceed to the protected handler", async () => {
  const { response, state } = responseFor("admin-1");
  let nextCalls = 0;
  const { createRequireAdmin } = await loadRequireAdmin();

  await createRequireAdmin(async (userId) => userId === "admin-1")(
    {} as Request,
    response,
    (() => {
      nextCalls += 1;
    }) as NextFunction,
  );

  assert.equal(nextCalls, 1);
  assert.equal(state.statusCode, undefined);
  assert.equal(state.body, undefined);
});

test("all privacy and data routes apply requireAdmin after requireAuth", () => {
  const source = readFileSync(join(backendRoot, "src/routes/user.ts"), "utf8");

  assert.match(
    source,
    /userRouter\.get\("\/data-export", requireAuth, requireAdmin,/,
  );
  assert.match(
    source,
    /userRouter\.get\("\/data-deletion-requests", requireAuth, requireAdmin,/,
  );
  assert.match(
    source,
    /userRouter\.post\("\/data-deletion-requests", requireAuth, requireAdmin,/,
  );
  assert.match(
    source,
    /userRouter\.delete\(\s*"\/data-deletion-requests\/:requestId",\s*requireAuth,\s*requireAdmin,/,
  );
});
