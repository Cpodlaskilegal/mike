import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

test("accepts only the configured delegated Docket API scope", async () => {
  const { hasDelegatedScope } = await import("../src/middleware/auth");

  assert.equal(hasDelegatedScope("openid access_as_user profile"), true);
  assert.equal(hasDelegatedScope("access_as_user"), true);
  assert.equal(hasDelegatedScope("access_as_user.extra"), false);
  assert.equal(hasDelegatedScope("Mail.Read"), false);
  assert.equal(hasDelegatedScope(undefined), false);
  assert.equal(hasDelegatedScope(["access_as_user"]), false);
  assert.equal(hasDelegatedScope("custom_scope", "custom_scope"), true);
});
