import {
  createFakeDb,
  seedUser,
  setGatewayEnv,
  TEST_OPS_TOKEN,
} from "./helpers/agentGatewayFakes";
import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentTokenRotationConflictError,
  authenticateAgentToken,
  generateAgentToken,
  hashAgentToken,
  looksLikeAgentToken,
  mintAgentToken,
  opsTokenMatches,
  revokeAgentTokens,
} from "../src/lib/agentGateway/tokens";

setGatewayEnv();

const TOKEN_SHAPE = /^dka_[A-Za-z0-9_-]{43}$/;

test("a minted token has the fixed shape and only its hash is stored", async () => {
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });

  const { token, createdAt } = await mintAgentToken("user-1", db.asDb());

  assert.match(token, TOKEN_SHAPE);
  assert.ok(looksLikeAgentToken(token));
  assert.ok(!Number.isNaN(Date.parse(createdAt)));

  const stored = db.table("docket_agent_tokens");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].token_hash, hashAgentToken(token));
  assert.match(stored[0].token_hash, /^[0-9a-f]{64}$/);
  // The token itself is nowhere in the database.
  assert.ok(!JSON.stringify(db.tables).includes(token));
  assert.notEqual(generateAgentToken(), generateAgentToken());
});

test("a minted token authenticates to the right user, email and role", async () => {
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "Garrett.Lewis@PodlaskiLegal.com" });
  seedUser(db, { id: "user-2", email: "jerad.marks@podlaskilegal.com", role: "admin" });

  const first = await mintAgentToken("user-1", db.asDb());
  const second = await mintAgentToken("user-2", db.asDb());

  const one = await authenticateAgentToken(first.token, db.asDb());
  assert.deepEqual(one, {
    tokenId: db.table("docket_agent_tokens")[0].id,
    userId: "user-1",
    email: "garrett.lewis@podlaskilegal.com",
    role: "user",
  });
  const two = await authenticateAgentToken(second.token, db.asDb());
  assert.equal(two?.userId, "user-2");
  assert.equal(two?.role, "admin");
});

test("minting again revokes the first token", async () => {
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });

  const first = await mintAgentToken("user-1", db.asDb());
  const second = await mintAgentToken("user-1", db.asDb());

  assert.notEqual(first.token, second.token);
  assert.equal(await authenticateAgentToken(first.token, db.asDb()), null);
  assert.equal(
    (await authenticateAgentToken(second.token, db.asDb()))?.userId,
    "user-1",
  );
  const rows = db.table("docket_agent_tokens");
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.revoked_at === null).length, 1);
});

test("a revoked token fails, and revoking again returns 0", async () => {
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  const { token } = await mintAgentToken("user-1", db.asDb());

  assert.equal(await revokeAgentTokens("user-1", db.asDb()), 1);
  assert.equal(await authenticateAgentToken(token, db.asDb()), null);
  assert.equal(await revokeAgentTokens("user-1", db.asDb()), 0);
});

test("a failed insert after the revoke is a rotation conflict and leaves no live token", async () => {
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: "garrett.lewis@podlaskilegal.com" });
  const first = await mintAgentToken("user-1", db.asDb());

  db.failOn("docket_agent_tokens", "insert");
  await assert.rejects(
    mintAgentToken("user-1", db.asDb()),
    AgentTokenRotationConflictError,
  );
  // Fails closed: the old token is gone and there is no new one.
  assert.equal(await authenticateAgentToken(first.token, db.asDb()), null);
});

test("a bearer with the wrong shape is rejected without a database call", async () => {
  const db = createFakeDb();
  const wrong = [
    "",
    "dka_",
    "dka_short",
    `dka_${"a".repeat(42)}`,
    `dka_${"a".repeat(44)}`,
    `dkb_${"a".repeat(43)}`,
    `dka_${"a".repeat(42)}!`,
    ` dka_${"a".repeat(43)}`,
    TEST_OPS_TOKEN,
  ];
  for (const bearer of wrong) {
    assert.equal(looksLikeAgentToken(bearer), false, bearer);
    assert.equal(await authenticateAgentToken(bearer, db.asDb()), null, bearer);
  }
  assert.equal(db.calls.length, 0);

  // A well-formed token that was never minted costs one lookup and fails.
  assert.equal(await authenticateAgentToken(generateAgentToken(), db.asDb()), null);
  assert.equal(db.calls.length, 1);
});

test("a deleted user, or a user with a missing or odd role, is rejected", async () => {
  for (const user of [
    { id: "gone", email: "gone@podlaskilegal.com", status: "deleted" },
    { id: "no-role", email: "norole@podlaskilegal.com", role: null },
    { id: "odd-role", email: "oddrole@podlaskilegal.com", role: "owner" },
    { id: "no-email", email: "" },
  ]) {
    const db = createFakeDb();
    seedUser(db, user);
    const { token } = await mintAgentToken(user.id, db.asDb());
    assert.equal(await authenticateAgentToken(token, db.asDb()), null, user.id);
  }

  // A token whose user row is gone is rejected too.
  const db = createFakeDb();
  const { token } = await mintAgentToken("missing-user", db.asDb());
  assert.equal(await authenticateAgentToken(token, db.asDb()), null);
});

test("the ops token is checked exactly, and never when the gateway is off", () => {
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN });
  assert.equal(opsTokenMatches(TEST_OPS_TOKEN), true);
  assert.equal(opsTokenMatches(`${TEST_OPS_TOKEN}x`), false);
  assert.equal(opsTokenMatches(TEST_OPS_TOKEN.slice(0, -1)), false);
  assert.equal(opsTokenMatches(TEST_OPS_TOKEN.toUpperCase()), false);
  assert.equal(opsTokenMatches(""), false);
  assert.equal(opsTokenMatches(generateAgentToken()), false);

  // Surrounding spaces in the env var are ignored.
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: `  ${TEST_OPS_TOKEN}\n` });
  assert.equal(opsTokenMatches(TEST_OPS_TOKEN), true);

  // Unset, empty, or under 32 characters: the gateway is off.
  setGatewayEnv();
  assert.equal(opsTokenMatches(TEST_OPS_TOKEN), false);
  assert.equal(opsTokenMatches(""), false);
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: "" });
  assert.equal(opsTokenMatches(""), false);
  const short = "a".repeat(31);
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: short });
  assert.equal(opsTokenMatches(short), false);
  setGatewayEnv();
});
