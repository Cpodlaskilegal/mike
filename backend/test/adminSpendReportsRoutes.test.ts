import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const backendRoot = new URL("..", import.meta.url).pathname;

test("the account spend dashboard is an admin-only user route", () => {
  const source = readFileSync(join(backendRoot, "src/routes/user.ts"), "utf8");

  assert.match(
    source,
    /userRouter\.get\(\s*"\/admin\/spend-reports",\s*requireAuth,\s*requireAdmin,/,
  );
  assert.match(
    source,
    /userRouter\.post\(\s*"\/admin\/spend-reports\/:reportId\/deliver",\s*requireAuth,\s*requireAdmin,/,
  );
});
