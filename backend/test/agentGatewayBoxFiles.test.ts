import {
  createFakeDb,
  createFakeUpstream,
  createMemoryRefreshLock,
  FAKE_UPSTREAM_ACCESS_TOKEN,
  seedPerUserPracticePantherConnector,
  seedManagedBoxConnector,
  seedOAuthToken,
  seedTool,
  seedUser,
  setGatewayEnv,
  TEST_OPS_TOKEN,
  TEST_STATUS_TOKEN,
  withApp,
  type FakeDb,
} from "./helpers/agentGatewayFakes";
import {
  BOX_API_HOST,
  BOX_DOWNLOAD_HOST,
  BOX_ERROR_BODY_CANARY,
  BOX_SIGNED_URL_CANARY,
  BOX_UPLOAD_HOST,
  createFakeBox,
  sha1Of,
  type FakeBox,
} from "./helpers/agentGatewayBoxFake";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test, { after } from "node:test";
import { inspect } from "node:util";
import express from "express";
import {
  agentBoxFilesStatus,
  agentBoxMaxDownloadBytes,
  agentBoxMaxUploadBytes,
  agentBoxMaxUploadsPerWindow,
  agentBoxMaxVersionsPerDay,
  agentBoxUploadsEnabled,
  isBoxFileName,
  isBoxId,
  normalizeSha1,
} from "../src/lib/agentGateway/boxFiles";
import {
  agentTokenScopeOf,
  authenticateAgentToken,
  generateAgentFileToken,
  generateAgentToken,
  hashAgentToken,
  looksLikeAgentFileToken,
  looksLikeAgentToken,
  mintAgentToken,
  revokeAgentTokens,
} from "../src/lib/agentGateway/tokens";
import type { ConnectorRow } from "../src/lib/mcp/types";
import { redactSensitiveText } from "../src/lib/safeError";
import { createAgentMcpRouter } from "../src/routes/agentMcp";

// ---------------------------------------------------------------------------
// Secret hygiene: every console line, every JSON response body and every
// response header of this file is kept, and checked at the end for the
// tokens, the users' Box access tokens, Box's own error bodies, signed
// download addresses and the content of the files.
// ---------------------------------------------------------------------------
const capturedLogs: string[] = [];
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};
for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => {
    capturedLogs.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 10 })))
        .join(" "),
    );
  };
}
const responseBodies: string[] = [];
const responseHeaders: string[] = [];
const mintedTokens: string[] = [];
const auditSnapshots: string[] = [];

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MINUTE = 60_000;
const MB = 1024 * 1024;
const GARRETT = "garrett.lewis@podlaskilegal.com";
const JERAD = "jerad.marks@podlaskilegal.com";
const KRISTA = "krista.hall@podlaskilegal.com";
const CONTENT_CANARY = "privileged-content-canary-5e81";
const NAME_CANARY = "Manning lease name-canary-77c2";

const BOX_ENV_NAMES = [
  "DOCKET_AGENT_BOX_UPLOADS",
  "DOCKET_AGENT_BOX_MAX_DOWNLOAD_MB",
  "DOCKET_AGENT_BOX_MAX_UPLOAD_MB",
  "DOCKET_AGENT_BOX_MAX_UPLOADS_PER_WINDOW",
  "DOCKET_AGENT_BOX_MAX_VERSIONS_PER_DAY",
];

/** The gateway switched on, the Box file settings at their defaults, then `values`. */
function setEnv(values: Record<string, string> = {}): void {
  for (const name of BOX_ENV_NAMES) delete process.env[name];
  setGatewayEnv({ DOCKET_AGENT_OPS_TOKEN: TEST_OPS_TOKEN, ...values });
}

/** The Box access token the fake sign-in of a user holds. */
const boxTokenOf = (userId: string) => `box-access-secret-${userId}-6f2a9c`;

function setup(
  options: {
    /** A clock the test can move. Default: it stands still at NOW. */
    now?: () => number;
    /** Shorter waits for the upload routes than production has. */
    boxUploadTimeouts?: { bodyMs: number; unreadBodyGraceMs: number };
  } = {},
) {
  const db = createFakeDb();
  const upstream = createFakeUpstream(db);
  const box = createFakeBox(db);
  const refreshed: string[] = [];
  /** Every connector row a Box access token was read from. */
  const tokenReads: ConnectorRow[] = [];
  const router = createAgentMcpRouter({
    db: () => db.asDb(),
    now: options.now ?? (() => NOW),
    ...(options.boxUploadTimeouts
      ? { boxUploadTimeouts: options.boxUploadTimeouts }
      : {}),
    withUpstreamClient: upstream.withUpstreamClient,
    withRefreshLock: createMemoryRefreshLock(),
    refreshUpstreamToken: async (connector: ConnectorRow) => {
      refreshed.push(connector.id);
      for (const row of db.table("user_mcp_oauth_tokens")) {
        if (row.connector_id === connector.id) row.expires_at = iso(60 * MINUTE);
      }
    },
    refreshTools: async () => undefined,
    validateServerUrl: async (url) => url,
    boxFetch: box.fetchImpl,
    boxAccessToken: async (connector: ConnectorRow) => {
      tokenReads.push(connector);
      return boxTokenOf(connector.user_id);
    },
  });
  const app = express();
  app.use("/agent-mcp", router);
  // Anything that reaches this proves a request fell through the gateway.
  app.use((_req, res) => res.status(418).json({ fell_through: true }));
  return { db, upstream, box, refreshed, tokenReads, app };
}

/** A Docket user with a live enrolment: the MCP token and the Box file token. */
async function enroll(
  db: FakeDb,
  userId: string,
  email: string,
): Promise<{ token: string; fileToken: string }> {
  seedUser(db, { id: userId, email });
  const { token, fileToken } = await mintAgentToken(userId, db.asDb());
  mintedTokens.push(token, fileToken);
  return { token, fileToken };
}

/** The user's managed Box row, signed in, and a Box account that sees the root. */
function connectBox(db: FakeDb, box: FakeBox, userId: string): ConnectorRow {
  const connector = seedManagedBoxConnector(db, userId);
  seedOAuthToken(db, connector.id, { expiresAt: iso(30 * MINUTE) });
  box.grant(boxTokenOf(userId), "0");
  return connector;
}

type Answer = {
  status: number;
  headers: Headers;
  bytes: Buffer;
  text: string;
  json: any;
};

async function request(
  url: string,
  init: RequestInit & { record?: boolean } = {},
): Promise<Answer> {
  const { record, ...rest } = init;
  const response = await fetch(url, rest);
  const bytes = Buffer.from(await response.arrayBuffer());
  const isJson = /json/.test(response.headers.get("content-type") ?? "");
  const text = isJson ? bytes.toString("utf8") : "";
  if (record !== false) {
    responseBodies.push(text);
    responseHeaders.push(JSON.stringify([...response.headers]));
  }
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, bytes, text, json };
}

function bearer(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** A call to /agent-mcp/box/files{path}. */
function files(
  baseUrl: string,
  path: string,
  token: string | null,
  init: RequestInit = {},
): Promise<Answer> {
  return request(`${baseUrl}/agent-mcp/box/files${path}`, {
    ...init,
    headers: { ...bearer(token), ...(init.headers as Record<string, string> | undefined) },
  });
}

/** An upload: raw bytes with their sha1 in the header. */
function send(
  baseUrl: string,
  path: string,
  token: string | null,
  bytes: Buffer,
  sha1: string | null = sha1Of(bytes),
): Promise<Answer> {
  return files(baseUrl, path, token, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      ...(sha1 === null ? {} : { "X-Docket-Content-Sha1": sha1 }),
    },
    body: bytes,
  });
}

const newFilePath = (parentId: string, name: string) =>
  `?parent_id=${parentId}&name=${encodeURIComponent(name)}`;

let nextRpcId = 1;
function rpc(baseUrl: string, source: string, token: string | null, method: string) {
  return request(`${baseUrl}/agent-mcp/${source}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...bearer(token),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params: {} }),
  });
}

function ops(
  baseUrl: string,
  path: string,
  init: RequestInit & { token?: string | null; record?: boolean } = {},
): Promise<Answer> {
  const { token = TEST_OPS_TOKEN, headers, ...rest } = init;
  return request(`${baseUrl}/agent-mcp/ops${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...bearer(token),
      ...(headers as Record<string, string> | undefined),
    },
  });
}

function auditRows(db: FakeDb) {
  const rows = db.table("user_mcp_tool_audit_logs");
  auditSnapshots.push(JSON.stringify(rows));
  return rows;
}

function tokenLookups(db: FakeDb): number {
  return db.calls.filter(
    (call) => call.table === "docket_agent_tokens" && call.op === "select",
  ).length;
}

function assertNoStore(answer: Answer) {
  assert.equal(answer.headers.get("cache-control"), "no-store");
}

/** Bytes of a made-up document, with a marker that must never be logged. */
function documentBytes(size: number): Buffer {
  const bytes = randomBytes(size);
  if (size > CONTENT_CANARY.length) bytes.write(CONTENT_CANARY, 0, "utf8");
  return bytes;
}

/** An upload: raw bytes, their sha1, and any other headers. */
function sendWith(
  baseUrl: string,
  path: string,
  token: string | null,
  bytes: Buffer,
  headers: Record<string, string>,
): Promise<Answer> {
  return files(baseUrl, path, token, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Docket-Content-Sha1": sha1Of(bytes),
      ...headers,
    },
    body: bytes,
  });
}

type StalledUpload = {
  /** The gateway's answer. Status 0 when the connection closed without one. */
  answer: Promise<{ status: number; json: any; head: string }>;
  /** Resolves when the connection is closed, by either side. */
  closed: Promise<void>;
  /** The caller gives up and drops the connection. */
  drop: () => void;
};

/**
 * A caller that starts an upload and then stops sending. It is plain TCP,
 * so nothing ends the request or closes the connection on the caller's
 * side: whatever closes it is the gateway. With `declared` the request says
 * how long its body is; with null the body is sent in chunks with no end.
 */
function stalledUpload(
  baseUrl: string,
  path: string,
  token: string,
  options: { declared: number | null; first: Buffer },
): StalledUpload {
  const url = new URL(baseUrl);
  const socket = net.connect(Number(url.port), url.hostname);
  let raw = Buffer.alloc(0);
  let answered!: (answer: { status: number; json: any; head: string }) => void;
  const answer = new Promise<{ status: number; json: any; head: string }>((resolve) => {
    answered = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      answered({ status: 0, json: null, head: "" });
      resolve();
    });
  });
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    raw = Buffer.concat([raw, chunk]);
    const headEnd = raw.indexOf("\r\n\r\n");
    if (headEnd === -1) return;
    const head = raw.subarray(0, headEnd).toString("utf8");
    const length = Number(/^content-length: (\d+)/im.exec(head)?.[1] ?? "0");
    const body = raw.subarray(headEnd + 4);
    if (body.length < length) return;
    const text = body.subarray(0, length).toString("utf8");
    responseBodies.push(text);
    responseHeaders.push(head);
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    answered({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? "0"), json, head });
  });
  socket.write(
    [
      `POST /agent-mcp/box/files${path} HTTP/1.1`,
      `Host: ${url.host}`,
      `Authorization: Bearer ${token}`,
      "Content-Type: application/octet-stream",
      `X-Docket-Content-Sha1: ${sha1Of(options.first)}`,
      options.declared === null
        ? "Transfer-Encoding: chunked"
        : `Content-Length: ${options.declared}`,
      "",
      "",
    ].join("\r\n"),
  );
  if (options.declared === null) {
    socket.write(`${options.first.length.toString(16)}\r\n`);
    socket.write(options.first);
    socket.write("\r\n");
  } else {
    socket.write(options.first);
  }
  return { answer, closed, drop: () => socket.destroy() };
}

/** Waits until `condition` holds. Fails instead of waiting for ever. */
async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Fails instead of hanging when the gateway never answers. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// The second token kind.
// ---------------------------------------------------------------------------

test("a Box file token has its own shape, and each token only passes for its own scope", async () => {
  setEnv();
  const db = createFakeDb();
  seedUser(db, { id: "user-1", email: GARRETT });
  const minted = await mintAgentToken("user-1", db.asDb());

  assert.match(minted.token, /^dka_[A-Za-z0-9_-]{43}$/);
  assert.match(minted.fileToken, /^dkf_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(minted.token.slice(4), minted.fileToken.slice(4));
  assert.equal(agentTokenScopeOf(minted.token), "mcp");
  assert.equal(agentTokenScopeOf(minted.fileToken), "box_files");
  assert.equal(agentTokenScopeOf(TEST_OPS_TOKEN), null);
  assert.equal(agentTokenScopeOf(""), null);
  assert.ok(looksLikeAgentFileToken(generateAgentFileToken()));
  assert.ok(!looksLikeAgentFileToken(generateAgentToken()));
  assert.ok(!looksLikeAgentToken(generateAgentFileToken()));
  assert.ok(!looksLikeAgentFileToken(`dkf_${"a".repeat(42)}`));

  // One row, two hashes, and neither token itself.
  const rows = db.table("docket_agent_tokens");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, hashAgentToken(minted.token));
  assert.equal(rows[0].file_token_hash, hashAgentToken(minted.fileToken));
  assert.ok(!JSON.stringify(db.tables).includes(minted.token));
  assert.ok(!JSON.stringify(db.tables).includes(minted.fileToken));

  const asMcp = await authenticateAgentToken(minted.token, db.asDb());
  const asFiles = await authenticateAgentToken(minted.fileToken, db.asDb(), "box_files");
  assert.deepEqual(asFiles, asMcp);
  assert.equal(asFiles?.userId, "user-1");

  // The wrong scope is refused by shape alone, with no lookup.
  const before = db.calls.length;
  assert.equal(await authenticateAgentToken(minted.fileToken, db.asDb()), null);
  assert.equal(await authenticateAgentToken(minted.fileToken, db.asDb(), "mcp"), null);
  assert.equal(await authenticateAgentToken(minted.token, db.asDb(), "box_files"), null);
  assert.equal(db.calls.length, before);

  // A file token whose characters are an MCP token's (and the other way
  // round) is not that token: each hash is only compared with its own column.
  const swappedToFile = `dkf_${minted.token.slice(4)}`;
  const swappedToMcp = `dka_${minted.fileToken.slice(4)}`;
  assert.equal(await authenticateAgentToken(swappedToFile, db.asDb(), "box_files"), null);
  assert.equal(await authenticateAgentToken(swappedToMcp, db.asDb()), null);
  // A row whose two hashes were swapped by hand still cannot cross over.
  const forged = createFakeDb();
  seedUser(forged, { id: "user-1", email: GARRETT });
  forged.table("docket_agent_tokens").push({
    id: "row-1",
    user_id: "user-1",
    token_hash: hashAgentToken(minted.fileToken),
    file_token_hash: hashAgentToken(minted.token),
    revoked_at: null,
  });
  assert.equal(await authenticateAgentToken(minted.fileToken, forged.asDb(), "box_files"), null);
  assert.equal(await authenticateAgentToken(minted.token, forged.asDb()), null);

  // A row from before the file token existed has no file token at all.
  const old = createFakeDb();
  seedUser(old, { id: "user-1", email: GARRETT });
  old.table("docket_agent_tokens").push({
    id: "row-old",
    user_id: "user-1",
    token_hash: hashAgentToken(minted.token),
    revoked_at: null,
  });
  assert.equal((await authenticateAgentToken(minted.token, old.asDb()))?.userId, "user-1");
  assert.equal(await authenticateAgentToken(minted.fileToken, old.asDb(), "box_files"), null);

  // Rotation and revocation end both.
  const again = await mintAgentToken("user-1", db.asDb());
  assert.equal(await authenticateAgentToken(minted.token, db.asDb()), null);
  assert.equal(await authenticateAgentToken(minted.fileToken, db.asDb(), "box_files"), null);
  assert.equal((await authenticateAgentToken(again.fileToken, db.asDb(), "box_files"))?.userId, "user-1");
  assert.equal(await revokeAgentTokens("user-1", db.asDb()), 1);
  assert.equal(await authenticateAgentToken(again.token, db.asDb()), null);
  assert.equal(await authenticateAgentToken(again.fileToken, db.asDb(), "box_files"), null);

  // A stray file token is redacted wherever the log helpers are used.
  assert.ok(!redactSensitiveText(`failed with ${minted.fileToken}`).includes(minted.fileToken));
});

test("with the gateway off the Box file routes answer 503, with or without a token", async () => {
  const { app, db, box } = setup();
  setEnv();
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  box.addFile({ id: "111", name: "a.docx", bytes: documentBytes(100) });

  setGatewayEnv();
  await withApp(app, async (baseUrl) => {
    const answers = [
      await files(baseUrl, "/111", fileToken),
      await files(baseUrl, "/111/content", fileToken),
      await files(baseUrl, "/111/content", null),
      await send(baseUrl, newFilePath("0", "x.docx"), fileToken, documentBytes(10)),
      await send(baseUrl, "/111/versions", fileToken, documentBytes(10)),
      await files(baseUrl, "/111", fileToken, { method: "DELETE" }),
    ];
    for (const answer of answers) {
      assert.equal(answer.status, 503);
      assert.deepEqual(answer.json, { error: "agent_gateway_disabled" });
      assertNoStore(answer);
    }
  });
  assert.equal(box.calls.length, 0);
  assert.equal(auditRows(db).length, 0);
});

test("an MCP token is refused on every Box file route, and a Box file token on the MCP and ops routes", async () => {
  const { app, db, box, upstream } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on", DOCKET_AGENT_STATUS_TOKEN: TEST_STATUS_TOKEN });
  const { token, fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  const pp = seedPerUserPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, pp.id, { expiresAt: iso(30 * MINUTE) });
  seedTool(db, pp.id, "Tasks_GetTasks");
  const boxRow = db.table("user_mcp_connectors").find((row) => row.name === "Box MCP")!;
  seedTool(db, boxRow.id, "search_files_keyword");
  const bytes = documentBytes(2_000);
  box.addFile({ id: "111", name: "a.docx", bytes });
  box.grant(boxTokenOf("user-1"), "111");

  const wrongScope = (answer: Answer, label: string) => {
    assert.equal(answer.status, 403, label);
    assert.deepEqual(answer.json, { error: "wrong_token_scope" }, label);
    assert.equal(
      answer.headers.get("www-authenticate"),
      'Bearer realm="docket-agent", error="insufficient_scope"',
      label,
    );
    assertNoStore(answer);
  };

  await withApp(app, async (baseUrl) => {
    const lookupsBefore = tokenLookups(db);
    // The MCP token (dka_) on the four file routes.
    wrongScope(await files(baseUrl, "/111", token), "metadata");
    wrongScope(await files(baseUrl, "/111/content", token), "download");
    wrongScope(await send(baseUrl, newFilePath("0", "x.docx"), token, bytes), "upload");
    wrongScope(await send(baseUrl, "/111/versions", token, bytes), "new version");
    // The file token (dkf_) on the MCP routes and on every ops route.
    wrongScope(await rpc(baseUrl, "practicepanther", fileToken, "tools/list"), "mcp pp");
    wrongScope(await rpc(baseUrl, "box", fileToken, "tools/list"), "mcp box");
    wrongScope(await rpc(baseUrl, "quo", fileToken, "tools/list"), "mcp quo");
    wrongScope(await ops(baseUrl, "/status", { token: fileToken }), "ops status");
    wrongScope(
      await ops(baseUrl, "/tokens", {
        method: "POST",
        token: fileToken,
        body: JSON.stringify({ email: GARRETT }),
      }),
      "ops mint",
    );
    wrongScope(
      await ops(baseUrl, `/tokens?email=${GARRETT}`, { method: "DELETE", token: fileToken }),
      "ops revoke",
    );
    wrongScope(
      await ops(baseUrl, "/provision", {
        method: "POST",
        token: fileToken,
        body: JSON.stringify({ email: GARRETT }),
      }),
      "ops provision",
    );
    // A token of the wrong kind is known by its shape: no lookup was made.
    assert.equal(tokenLookups(db), lookupsBefore);
    // Nothing was touched by the refused calls.
    assert.equal(box.calls.length, 0);
    assert.equal(upstream.calls.length, 0);
    assert.equal(auditRows(db).length, 0);
    assert.equal(db.table("docket_agent_tokens").filter((row) => !row.revoked_at).length, 1);

    // Other secrets are not file tokens either.
    for (const [label, value] of [
      ["no bearer", null],
      ["ops token", TEST_OPS_TOKEN],
      ["status token", TEST_STATUS_TOKEN],
      ["unknown file token", generateAgentFileToken()],
      ["malformed", "dkf_short"],
      ["the user's Box token", boxTokenOf("user-1")],
    ] as Array<[string, string | null]>) {
      const answer = await files(baseUrl, "/111", value);
      assert.equal(answer.status, 401, label);
      assert.deepEqual(answer.json, { error: "invalid_token" }, label);
      assert.equal(
        answer.headers.get("www-authenticate"),
        'Bearer realm="docket-agent", error="invalid_token"',
        label,
      );
    }
    assert.equal(box.calls.length, 0);

    // Each token works where it belongs.
    assert.equal((await files(baseUrl, "/111", fileToken)).status, 200);
    assert.equal((await rpc(baseUrl, "practicepanther", token, "tools/list")).status, 200);
    assert.equal((await rpc(baseUrl, "box", token, "tools/list")).status, 200);
  });
});

test("minting returns both tokens once; rotating and revoking end both", async () => {
  const { app, db, box } = setup();
  setEnv();
  seedUser(db, { id: "user-1", email: GARRETT });
  connectBox(db, box, "user-1");
  box.addFile({ id: "111", name: "a.docx", bytes: documentBytes(64) });
  box.grant(boxTokenOf("user-1"), "111");
  const pp = seedPerUserPracticePantherConnector(db, "user-1");
  seedOAuthToken(db, pp.id, { expiresAt: iso(30 * MINUTE) });

  await withApp(app, async (baseUrl) => {
    // The mint answer is the one body that may hold a token.
    const minted = await ops(baseUrl, "/tokens", {
      method: "POST",
      body: JSON.stringify({ email: GARRETT }),
      record: false,
    });
    assert.equal(minted.status, 201);
    assert.deepEqual(Object.keys(minted.json).sort(), ["created_at", "email", "file_token", "token"]);
    assert.match(minted.json.token, /^dka_[A-Za-z0-9_-]{43}$/);
    assert.match(minted.json.file_token, /^dkf_[A-Za-z0-9_-]{43}$/);
    assert.equal(minted.json.email, GARRETT);
    assertNoStore(minted);
    mintedTokens.push(minted.json.token, minted.json.file_token);
    const first = minted.json as { token: string; file_token: string };

    // Only hashes are stored: one row for the pair.
    assert.equal(db.table("docket_agent_tokens").length, 1);
    assert.equal(db.table("docket_agent_tokens")[0].file_token_hash, hashAgentToken(first.file_token));
    assert.ok(!JSON.stringify(db.tables).includes(first.token));
    assert.ok(!JSON.stringify(db.tables).includes(first.file_token));

    assert.equal((await files(baseUrl, "/111", first.file_token)).status, 200);
    assert.equal((await rpc(baseUrl, "practicepanther", first.token, "tools/list")).status, 200);

    // Rotation: a new pair, and the old pair stops at once.
    const rotated = await ops(baseUrl, "/tokens", {
      method: "POST",
      body: JSON.stringify({ email: GARRETT }),
      record: false,
    });
    mintedTokens.push(rotated.json.token, rotated.json.file_token);
    assert.notEqual(rotated.json.file_token, first.file_token);
    assert.equal((await files(baseUrl, "/111", first.file_token)).status, 401);
    assert.equal((await files(baseUrl, "/111/content", first.file_token)).status, 401);
    assert.equal((await rpc(baseUrl, "practicepanther", first.token, "tools/list")).status, 401);
    assert.equal((await files(baseUrl, "/111", rotated.json.file_token)).status, 200);
    assert.equal((await rpc(baseUrl, "practicepanther", rotated.json.token, "tools/list")).status, 200);

    // Revocation: one call ends both.
    const revoked = await ops(baseUrl, `/tokens?email=${GARRETT}`, { method: "DELETE" });
    assert.deepEqual(revoked.json, { email: GARRETT, revoked: 1 });
    assert.equal((await files(baseUrl, "/111", rotated.json.file_token)).status, 401);
    assert.equal((await rpc(baseUrl, "practicepanther", rotated.json.token, "tools/list")).status, 401);
    assert.equal(db.table("docket_agent_tokens").filter((row) => !row.revoked_at).length, 0);
  });
  // The ops log lines name no token of either kind.
  for (const line of capturedLogs.filter((item) => item.includes("ops action"))) {
    assert.ok(!line.includes("dka_") && !line.includes("dkf_"));
  }
});

// ---------------------------------------------------------------------------
// Reading: details and exact bytes.
// ---------------------------------------------------------------------------

test("file details: the pinned fields, the user's own Box sign-in, one audit row", async () => {
  const { app, db, box, tokenReads } = setup();
  setEnv();
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  const connector = connectBox(db, box, "user-1");
  const tokenId = db.table("docket_agent_tokens")[0].id;
  box.addFolder("5001", "Manning v. Koenig");
  box.addFolder("5002", "Drafts", "5001");
  const bytes = documentBytes(48_231);
  const name = `${NAME_CANARY} – Ünïcode (v2).docx`;
  box.addFile({ id: "743588051504", name, parentId: "5002", bytes });
  box.grant(boxTokenOf("user-1"), "743588051504");

  await withApp(app, async (baseUrl) => {
    const answer = await files(baseUrl, "/743588051504", fileToken);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, {
      id: "743588051504",
      name,
      size: 48_231,
      sha1: sha1Of(bytes),
      modified_at: "2026-09-30T15:00:00-05:00",
      parent: { id: "5002", name: "Drafts" },
      path: ["All Files", "Manning v. Koenig", "Drafts"],
    });
    assertNoStore(answer);
    // Nothing else Box said about the file is passed on.
    assert.ok(!answer.text.includes(BOX_ERROR_BODY_CANARY));

    for (const bad of ["abc", "12a", "1".repeat(31), "-1", "1.5"]) {
      const invalid = await files(baseUrl, `/${bad}`, fileToken);
      assert.equal(invalid.status, 400, bad);
      assert.deepEqual(invalid.json, { error: "invalid_file_id" });
    }
  });

  // One Box call, to the fixed API host, with this user's own Box token.
  assert.equal(box.calls.length, 1);
  assert.equal(box.calls[0].method, "GET");
  assert.equal(box.calls[0].host, BOX_API_HOST);
  assert.equal(box.calls[0].path, "/2.0/files/743588051504");
  assert.equal(box.calls[0].authorization, `Bearer ${boxTokenOf("user-1")}`);
  assert.deepEqual(tokenReads.map((row) => [row.id, row.user_id]), [[connector.id, "user-1"]]);

  const rows = auditRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool_name, "box_file_metadata");
  assert.equal(rows[0].action_kind, "read");
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[0].origin, "docket_agent");
  assert.equal(rows[0].actor_email, GARRETT);
  assert.equal(rows[0].user_id, "user-1");
  assert.equal(rows[0].agent_token_id, tokenId);
  assert.equal(rows[0].connector_id, connector.id);
  assert.deepEqual(rows[0].target_refs, { file_id: "743588051504", size_bytes: "48231" });
  // Never the file's name.
  assert.ok(!JSON.stringify(rows).includes("name-canary"));
});

test("a download is the exact bytes of the file, with the headers and one audit row", async () => {
  const { app, db, box } = setup();
  setEnv();
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  const connector = connectBox(db, box, "user-1");
  const tokenId = db.table("docket_agent_tokens")[0].id;
  // Several megabytes, and not a whole number of chunks.
  const bytes = documentBytes(3 * MB + 12_345);
  const name = `${NAME_CANARY} – Ünïcode, "quoted" (v2).docx`;
  const file = box.addFile({ id: "111", name, bytes });
  box.grant(boxTokenOf("user-1"), "111");
  const empty = box.addFile({ id: "112", name: "empty.txt", bytes: Buffer.alloc(0) });
  const small = box.addFile({ id: "113", name: "small.txt", bytes: Buffer.from("one line\n") });
  box.grant(boxTokenOf("user-1"), empty.id, small.id);

  await withApp(app, async (baseUrl) => {
    const answer = await files(baseUrl, "/111/content", fileToken);
    assert.equal(answer.status, 200);
    // Byte for byte, and by sha1.
    assert.equal(answer.bytes.length, bytes.length);
    assert.ok(answer.bytes.equals(bytes));
    assert.equal(sha1Of(answer.bytes), sha1Of(bytes));
    assert.equal(answer.headers.get("content-type"), "application/octet-stream");
    assert.equal(answer.headers.get("content-length"), String(bytes.length));
    assert.equal(answer.headers.get("x-docket-file-sha1"), sha1Of(bytes));
    assert.equal(answer.headers.get("x-docket-file-size"), String(bytes.length));
    const headerName = answer.headers.get("x-docket-file-name")!;
    assert.match(headerName, /^[A-Za-z0-9\-_.!~*'()%]+$/);
    assert.equal(decodeURIComponent(headerName), name);
    assertNoStore(answer);

    for (const [id, expected] of [
      ["112", Buffer.alloc(0)],
      ["113", Buffer.from("one line\n")],
    ] as Array<[string, Buffer]>) {
      const other = await files(baseUrl, `/${id}/content`, fileToken);
      assert.equal(other.status, 200, id);
      assert.ok(other.bytes.equals(expected), id);
      assert.equal(other.headers.get("content-length"), String(expected.length), id);
      assert.equal(other.headers.get("x-docket-file-sha1"), sha1Of(expected), id);
    }

    for (const bad of ["abc", "1x", "", "1&version=2"]) {
      const invalid = await files(baseUrl, `/111/content?version=${bad}`, fileToken);
      assert.equal(invalid.status, 400, bad);
      assert.deepEqual(invalid.json, { error: "invalid_version" });
    }
  });

  // The Box calls of the first download: details, content, the signed address.
  const first = box.calls.slice(0, 3);
  assert.deepEqual(
    first.map((call) => [call.method, call.host, call.path]),
    [
      ["GET", BOX_API_HOST, "/2.0/files/111"],
      ["GET", BOX_API_HOST, "/2.0/files/111/content"],
      ["GET", BOX_DOWNLOAD_HOST, `/d/1/${BOX_SIGNED_URL_CANARY}/111/${file.versions[0].id}/download`],
    ],
  );
  assert.equal(first[0].authorization, `Bearer ${boxTokenOf("user-1")}`);
  assert.equal(first[1].authorization, `Bearer ${boxTokenOf("user-1")}`);
  // The signed address gets no Authorization header at all.
  assert.equal(first[2].authorization, null);
  assert.equal(first[1].headers["accept-encoding"], "identity");

  const rows = auditRows(db);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].tool_name, "box_file_download");
  assert.equal(rows[0].action_kind, "read");
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[0].origin, "docket_agent");
  assert.equal(rows[0].actor_email, GARRETT);
  assert.equal(rows[0].agent_token_id, tokenId);
  assert.equal(rows[0].connector_id, connector.id);
  assert.equal(rows[0].result_size_chars, bytes.length);
  assert.deepEqual(rows[0].target_refs, {
    file_id: "111",
    version_id: file.versions[0].id,
    size_bytes: String(bytes.length),
  });
  assert.ok(!JSON.stringify(rows).includes("name-canary"));
  assert.ok(!JSON.stringify(rows).includes(CONTENT_CANARY));
});

test("a download is streamed: bytes reach the caller while Box is still sending", async () => {
  const { app, db, box } = setup();
  setEnv();
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  const bytes = documentBytes(4 * MB);
  box.addFile({ id: "111", name: "big.pdf", bytes });
  box.grant(boxTokenOf("user-1"), "111");
  // Box stops after the first megabyte until the test lets it go on. A
  // gateway that kept the whole file before answering would never answer.
  let release!: () => void;
  box.state.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  box.state.gateAfterBytes = MB;

  await withApp(app, async (baseUrl) => {
    try {
      const response = await within(
        fetch(`${baseUrl}/agent-mcp/box/files/111/content`, { headers: bearer(fileToken) }),
        10_000,
        "the answer did not start while Box was still sending",
      );
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (received < MB / 2) {
        const chunk = await within(reader.read(), 10_000, "no bytes arrived before Box finished");
        assert.equal(chunk.done, false);
        chunks.push(chunk.value!);
        received += chunk.value!.byteLength;
      }
      // Half a megabyte is with the caller. Box has sent only the first.
      assert.equal(box.state.downloadFinished, false);
      assert.ok(received < bytes.length);

      release();
      for (;;) {
        const chunk = await within(reader.read(), 10_000, "the rest never arrived");
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      assert.ok(Buffer.concat(chunks).equals(bytes));
      assert.equal(box.state.downloadFinished, true);
    } finally {
      release();
    }
  });
});

test("when the caller goes away the download stops and is recorded as failed", async () => {
  const { app, db, box } = setup();
  setEnv();
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  const bytes = documentBytes(4 * MB);
  box.addFile({ id: "111", name: "big.pdf", bytes });
  box.grant(boxTokenOf("user-1"), "111");
  let release!: () => void;
  box.state.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  box.state.gateAfterBytes = MB;

  await withApp(app, async (baseUrl) => {
    try {
      const caller = new AbortController();
      const response = await within(
        fetch(`${baseUrl}/agent-mcp/box/files/111/content`, {
          headers: bearer(fileToken),
          signal: caller.signal,
        }),
        10_000,
        "the answer did not start",
      );
      const reader = response.body!.getReader();
      await within(reader.read(), 10_000, "no bytes arrived");
      caller.abort();
      await reader.read().catch(() => undefined);
      // Give the gateway a moment to see the closed connection, then let
      // Box go on: the gateway must stop reading, not finish the file.
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      const deadline = Date.now() + 10_000;
      while (!db.table("user_mcp_tool_audit_logs").length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
    }
  });
  const rows = auditRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool_name, "box_file_download");
  assert.equal(rows[0].status, "error");
  assert.equal(rows[0].error_message, "box_download_failed");
  // Less than the file was sent, and Box was not read to the end.
  assert.ok(rows[0].result_size_chars < bytes.length);
  assert.equal(box.state.downloadFinished, false);
  assert.ok(capturedLogs.some((line) => line.includes("[agent-gateway] box download stopped")));
});

test("a download honours version: an earlier version by its id, the current one by default", async () => {
  const { app, db, box } = setup();
  setEnv();
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  const v1 = documentBytes(700_000);
  const v2 = documentBytes(650_001);
  const file = box.addFile({ id: "111", name: "Complaint.docx", bytes: v1, versionId: "9001" });
  file.versions.push({ id: "9002", bytes: v2, modifiedAt: "2026-10-01T09:00:00-05:00" });
  box.grant(boxTokenOf("user-1"), "111");

  await withApp(app, async (baseUrl) => {
    const current = await files(baseUrl, "/111/content", fileToken);
    assert.ok(current.bytes.equals(v2));
    assert.equal(current.headers.get("x-docket-file-sha1"), sha1Of(v2));

    const earlier = await files(baseUrl, "/111/content?version=9001", fileToken);
    assert.equal(earlier.status, 200);
    assert.ok(earlier.bytes.equals(v1));
    assert.equal(earlier.headers.get("x-docket-file-sha1"), sha1Of(v1));
    assert.equal(earlier.headers.get("x-docket-file-size"), String(v1.length));
    assert.equal(earlier.headers.get("content-length"), String(v1.length));

    // The id of the current version is the current file.
    const named = await files(baseUrl, "/111/content?version=9002", fileToken);
    assert.ok(named.bytes.equals(v2));

    const unknown = await files(baseUrl, "/111/content?version=424242", fileToken);
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, { error: "box_not_found" });
  });

  // Box was asked for that version, by its id, on the fixed host.
  const versioned = box.calls.filter((call) => call.search.includes("version=9001"));
  assert.deepEqual(
    versioned.map((call) => [call.host, call.path, call.search]),
    [[BOX_API_HOST, "/2.0/files/111/content", "?version=9001"]],
  );
  const rows = auditRows(db);
  assert.deepEqual(rows.map((row) => row.status), ["ok", "ok", "ok", "error"]);
  assert.equal(rows[1].target_refs.version_id, "9001");
  assert.equal(rows[1].target_refs.size_bytes, String(v1.length));
  assert.equal(rows[0].target_refs.version_id, "9002");
  assert.equal(rows[3].error_message, "box_not_found");
});

test("a file over the size cap answers 413 before any bytes are asked for", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_MAX_DOWNLOAD_MB: "1" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  box.addFile({ id: "111", name: "over.pdf", bytes: documentBytes(MB + 1) });
  box.addFile({ id: "112", name: "at-the-cap.pdf", bytes: documentBytes(MB) });
  box.grant(boxTokenOf("user-1"), "111", "112");

  await withApp(app, async (baseUrl) => {
    const over = await files(baseUrl, "/111/content", fileToken);
    assert.equal(over.status, 413);
    assert.deepEqual(over.json, { error: "file_too_large", size: MB + 1, max_bytes: MB });
    // Only the details were read. The content was never requested.
    assert.deepEqual(box.calls.map((call) => call.path), ["/2.0/files/111"]);

    const atCap = await files(baseUrl, "/112/content", fileToken);
    assert.equal(atCap.status, 200);
    assert.equal(atCap.bytes.length, MB);
  });
  const rows = auditRows(db);
  assert.equal(rows[0].status, "error");
  assert.equal(rows[0].error_message, "file_too_large");
  assert.equal(rows[0].result_size_chars, 0);
  assert.equal(rows[1].status, "ok");

  // The default cap is 200 MB; nonsense values fall back to it.
  setEnv();
  assert.equal(agentBoxMaxDownloadBytes(), 200 * MB);
  for (const value of ["0", "-5", "abc", ""]) {
    setEnv({ DOCKET_AGENT_BOX_MAX_DOWNLOAD_MB: value });
    assert.equal(agentBoxMaxDownloadBytes(), 200 * MB, value);
  }
});

test("a redirect is followed only to Box's download hosts, and the Box token never leaves Box's API hosts", async () => {
  const { app, db, box } = setup();
  setEnv();
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  const bytes = documentBytes(10_000);
  box.addFile({ id: "111", name: "a.docx", bytes });
  box.grant(boxTokenOf("user-1"), "111");

  const refused = [
    "https://evil.example/steal",
    "https://dl.boxcloud.com.evil.example/d/1/x/download",
    "https://evilboxcloud.com/d/1/x/download",
    "https://boxcloud.com/d/1/x/download",
    "http://dl.boxcloud.com/d/1/x/download",
    "https://user:secret@dl.boxcloud.com/d/1/x/download",
    "https://dl.boxcloud.com:8443/d/1/x/download",
    "https://127.0.0.1/d/1/x/download",
    "/d/1/x/download",
    "//evil.example/x",
  ];
  await withApp(app, async (baseUrl) => {
    for (const location of refused) {
      box.state.redirectTo = location;
      const before = box.calls.length;
      const answer = await files(baseUrl, "/111/content", fileToken);
      assert.equal(answer.status, 502, location);
      assert.deepEqual(answer.json, { error: "box_download_redirect_refused" }, location);
      // Details, then the content call. The redirect was not followed.
      assert.deepEqual(
        box.calls.slice(before).map((call) => call.host),
        [BOX_API_HOST, BOX_API_HOST],
        location,
      );
    }
    box.state.redirectTo = null;
    const ok = await files(baseUrl, "/111/content", fileToken);
    assert.ok(ok.bytes.equals(bytes));
  });

  // Across the whole test: no request to any host but Box's three, and the
  // user's Box token only ever on the API host.
  for (const call of box.calls) {
    assert.ok([BOX_API_HOST, BOX_DOWNLOAD_HOST].includes(call.host), call.host);
    if (call.host !== BOX_API_HOST) assert.equal(call.authorization, null);
  }
  assert.ok(box.calls.some((call) => call.host === BOX_DOWNLOAD_HOST));
  const rows = auditRows(db);
  assert.equal(rows.length, refused.length + 1);
  assert.equal(rows[0].error_message, "box_download_redirect_refused");
  assert.equal(rows.at(-1)!.status, "ok");
});

test("bytes that are not the file Box described never arrive as a complete answer", async () => {
  const { app, db, box } = setup();
  setEnv();
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  const big = documentBytes(2 * MB);
  const small = Buffer.from("a short and exact sentence\n");
  box.addFile({ id: "111", name: "big.docx", bytes: big });
  box.addFile({ id: "112", name: "small.txt", bytes: small });
  box.grant(boxTokenOf("user-1"), "111", "112");

  await withApp(app, async (baseUrl) => {
    // Same length, one byte different, in the last chunk.
    const corrupted = Buffer.from(big);
    corrupted[corrupted.length - 10] ^= 0xff;
    box.state.serveBytes = corrupted;
    const response = await fetch(`${baseUrl}/agent-mcp/box/files/111/content`, {
      headers: bearer(fileToken),
    });
    let got: Buffer | null = null;
    try {
      got = Buffer.from(await response.arrayBuffer());
    } catch {
      got = null; // the connection was cut
    }
    assert.ok(got === null || got.length < big.length, "a full wrong body was delivered");

    // A small file is checked before a single byte is sent: a clean error.
    const wrongSmall = Buffer.from(small);
    wrongSmall[3] ^= 0x01;
    box.state.serveBytes = wrongSmall;
    const answer = await files(baseUrl, "/112/content", fileToken);
    assert.equal(answer.status, 502);
    assert.deepEqual(answer.json, { error: "box_download_mismatch" });

    // More bytes than Box said the file has.
    box.state.serveBytes = Buffer.concat([small, Buffer.from("extra")]);
    const longer = await files(baseUrl, "/112/content", fileToken);
    assert.equal(longer.status, 502);
    assert.deepEqual(longer.json, { error: "box_download_mismatch" });

    box.state.serveBytes = null;
    const fine = await files(baseUrl, "/112/content", fileToken);
    assert.ok(fine.bytes.equals(small));
  });
  const rows = auditRows(db);
  assert.deepEqual(rows.map((row) => row.status), ["error", "error", "error", "ok"]);
  for (const row of rows.slice(0, 3)) assert.equal(row.error_message, "box_download_mismatch");
  // The two that were caught while streaming left a log line, with ids only.
  assert.equal(
    capturedLogs.filter((line) => line.includes("box download did not match Box's sha1 or size")).length,
    2,
  );
});

// ---------------------------------------------------------------------------
// Whose Box sign-in is used.
// ---------------------------------------------------------------------------

test("another user's token never uses this user's Box sign-in", async () => {
  const { app, db, box, tokenReads, upstream } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const a = await enroll(db, "user-a", GARRETT);
  const b = await enroll(db, "user-b", JERAD);
  const c = await enroll(db, "user-c", "third@podlaskilegal.com");
  const rowA = connectBox(db, box, "user-a");
  const rowB = connectBox(db, box, "user-b");
  // user-c is enrolled but has no Box row of his own.
  const bytesA = documentBytes(5_000);
  const bytesB = documentBytes(6_000);
  box.addFolder("7001", "A's folder");
  box.addFolder("7002", "B's folder");
  box.addFile({ id: "111", name: "a-only.docx", parentId: "7001", bytes: bytesA });
  box.addFile({ id: "222", name: "b-only.docx", parentId: "7002", bytes: bytesB });
  box.grant(boxTokenOf("user-a"), "111", "7001");
  box.grant(boxTokenOf("user-b"), "222", "7002");

  await withApp(app, async (baseUrl) => {
    // Each reads his own file.
    assert.ok((await files(baseUrl, "/111/content", a.fileToken)).bytes.equals(bytesA));
    assert.ok((await files(baseUrl, "/222/content", b.fileToken)).bytes.equals(bytesB));
    // A asks for B's file: Box, asked as A, does not know it.
    for (const path of ["/222", "/222/content"]) {
      const answer = await files(baseUrl, path, a.fileToken);
      assert.equal(answer.status, 404, path);
      assert.deepEqual(answer.json, { error: "box_not_found" });
    }
    // A cannot file into B's folder or over B's file.
    const intoB = await send(baseUrl, newFilePath("7002", "from-a.docx"), a.fileToken, bytesA);
    assert.equal(intoB.status, 404);
    const overB = await send(baseUrl, "/222/versions", a.fileToken, bytesA);
    assert.equal(overB.status, 404);
    assert.equal(box.files.get("222")!.versions.length, 1);
    assert.equal(box.files.size, 2);

    // C has no Box row. He does not get A's or B's.
    for (const path of ["/111", "/111/content", "/222/content"]) {
      const answer = await files(baseUrl, path, c.fileToken);
      assert.equal(answer.status, 401, path);
      assert.deepEqual(answer.json, { error: "source_not_connected", source: "box", state: "not_connected" });
      assert.equal(
        answer.headers.get("www-authenticate"),
        'Bearer realm="docket-agent", error="invalid_token", error_description="source_not_connected"',
      );
    }
    const upload = await send(baseUrl, newFilePath("7001", "from-c.docx"), c.fileToken, bytesA);
    assert.equal(upload.status, 401);
  });

  // A Box token was only ever read from the caller's own row, and every Box
  // request carried the caller's own Box token.
  const owner: Record<string, string> = { [rowA.id]: "user-a", [rowB.id]: "user-b" };
  for (const row of tokenReads) assert.equal(row.user_id, owner[row.id]);
  assert.ok(!tokenReads.some((row) => row.user_id === "user-c"));
  const byUser: Record<string, Set<string>> = {};
  for (const row of auditRows(db)) {
    (byUser[row.user_id] ??= new Set()).add(row.connector_id);
  }
  assert.deepEqual([...byUser["user-a"]], [rowA.id]);
  assert.deepEqual([...byUser["user-b"]], [rowB.id]);
  assert.equal(byUser["user-c"], undefined);
  // Requests for B's things made by A carried A's Box token, never B's.
  const forB = box.calls.filter((call) => call.path.includes("/222") && call.authorization);
  assert.ok(forB.length >= 3);
  assert.equal(
    forB.filter((call) => call.authorization === `Bearer ${boxTokenOf("user-b")}`).length,
    2, // B's own download: details and content
  );
  assert.equal(upstream.calls.length, 0);
});

test("a user who is not on the allowed list is refused, and a sign-in that is gone answers 401", async () => {
  const { app, db, box, refreshed } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  const other = await enroll(db, "user-2", JERAD);
  const connector = connectBox(db, box, "user-1");
  connectBox(db, box, "user-2");
  const bytes = documentBytes(1_000);
  box.addFile({ id: "111", name: "a.docx", bytes });
  box.grant(boxTokenOf("user-1"), "111");
  box.grant(boxTokenOf("user-2"), "111");

  await withApp(app, async (baseUrl) => {
    assert.equal((await files(baseUrl, "/111", fileToken)).status, 200);

    // The operator takes garrett off the list. His token row is untouched.
    setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on", DOCKET_AGENT_ALLOWED_EMAILS: JERAD });
    const before = box.calls.length;
    for (const answer of [
      await files(baseUrl, "/111", fileToken),
      await files(baseUrl, "/111/content", fileToken),
      await send(baseUrl, newFilePath("0", "x.docx"), fileToken, bytes),
      await send(baseUrl, "/111/versions", fileToken, bytes),
    ]) {
      assert.equal(answer.status, 401);
      assert.deepEqual(answer.json, { error: "invalid_token" });
    }
    assert.equal(box.calls.length, before);
    assert.equal(db.table("docket_agent_tokens").filter((row) => !row.revoked_at).length, 2);
    // The other user is not affected.
    assert.equal((await files(baseUrl, "/111", other.fileToken)).status, 200);

    // A deleted Docket user's file token is dead too.
    db.table("app_users").find((row) => row.id === "user-2")!.docket_data_status = "deleted";
    assert.equal((await files(baseUrl, "/111", other.fileToken)).status, 401);

    // Back on the list. A sign-in that expired and cannot be refreshed.
    setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on", DOCKET_AGENT_ALLOWED_EMAILS: GARRETT });
    const tokenRow = db.table("user_mcp_oauth_tokens").find((row) => row.connector_id === connector.id)!;
    tokenRow.expires_at = iso(-5 * MINUTE);
    tokenRow.encrypted_refresh_token = null;
    const expired = await files(baseUrl, "/111/content", fileToken);
    assert.equal(expired.status, 401);
    assert.deepEqual(expired.json, { error: "source_not_connected", source: "box", state: "needs_reconnect" });

    // A sign-in near expiry is refreshed first, once, under the lock.
    tokenRow.expires_at = iso(2 * MINUTE);
    tokenRow.encrypted_refresh_token = "refresh-secret";
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => files(baseUrl, "/111", fileToken)),
    );
    for (const answer of answers) assert.equal(answer.status, 200);
    assert.deepEqual(refreshed, [connector.id]);

    // Box itself refuses the stored token: the user has to connect again.
    box.state.failNext.push({ match: () => true, status: 401, code: "unauthorized" });
    const refusedByBox = await files(baseUrl, "/111", fileToken);
    assert.equal(refusedByBox.status, 401);
    assert.deepEqual(refusedByBox.json, { error: "source_not_connected", source: "box", state: "needs_reconnect" });

    // Box switched off for the whole backend: no Box file route works.
    setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on", BOX_MCP_ENABLED: "false", DOCKET_AGENT_ALLOWED_EMAILS: GARRETT });
    const off = await files(baseUrl, "/111", fileToken);
    assert.equal(off.status, 401);
    assert.deepEqual(off.json, { error: "source_not_connected", source: "box", state: "not_connected" });
    assert.deepEqual(agentBoxFilesStatus(), { download: false, upload: false });
  });
});

test("a Box 403 or 404 is passed on as 403 or 404, without anything Box said", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  const bytes = documentBytes(1_000);
  // A new version must differ from what Box holds, or nothing is sent at all.
  const revised = documentBytes(1_000);
  box.addFile({ id: "111", name: "a.docx", bytes });
  box.grant(boxTokenOf("user-1"), "111");

  const cases: Array<[number, string, number, Record<string, unknown>]> = [
    [403, "access_denied_insufficient_permissions", 403, { error: "box_forbidden" }],
    [404, "not_found", 404, { error: "box_not_found" }],
    [429, "rate_limit_exceeded", 429, { error: "box_rate_limited" }],
    [500, "internal_server_error", 502, { error: "box_error" }],
    [503, "unavailable", 502, { error: "box_error" }],
  ];
  // [what is called, the call, which Box request fails, did that request carry the bytes]
  const calls: Array<[string, (baseUrl: string) => Promise<Answer>, (path: string, method: string) => boolean, boolean]> = [
    ["details", (baseUrl) => files(baseUrl, "/111", fileToken), (path) => path === "/2.0/files/111", false],
    ["download: details", (baseUrl) => files(baseUrl, "/111/content", fileToken), (path) => path === "/2.0/files/111", false],
    ["download: content", (baseUrl) => files(baseUrl, "/111/content", fileToken), (path) => path.endsWith("/content"), false],
    ["upload: preflight", (baseUrl) => send(baseUrl, newFilePath("0", "n.docx"), fileToken, bytes), (_path, method) => method === "OPTIONS", false],
    ["upload: the upload", (baseUrl) => send(baseUrl, newFilePath("0", "n.docx"), fileToken, bytes), (_path, method) => method === "POST", true],
    ["new version: details", (baseUrl) => send(baseUrl, "/111/versions", fileToken, revised), (path, method) => path === "/2.0/files/111" && method === "GET", false],
    ["new version", (baseUrl) => send(baseUrl, "/111/versions", fileToken, revised), (_path, method) => method === "POST", true],
  ];

  await withApp(app, async (baseUrl) => {
    for (const [label, run, match, carriedBytes] of calls) {
      for (const [boxStatus, code, status, plainBody] of cases) {
        // Box breaking while it holds the bytes may still have stored them.
        const body =
          carriedBytes && boxStatus >= 500 ? { error: "box_upload_uncertain" } : plainBody;
        box.state.failNext.push({
          match: (call) => match(call.path, call.method),
          status: boxStatus,
          code,
        });
        const answer = await run(baseUrl);
        assert.equal(answer.status, status, `${label} ${boxStatus}`);
        assert.deepEqual(answer.json, body, `${label} ${boxStatus}`);
        assert.ok(!answer.text.includes(BOX_ERROR_BODY_CANARY));
        assertNoStore(answer);
        assert.equal(box.state.failNext.length, 0, `${label} ${boxStatus} was not reached`);
      }
    }
  });
  // Nothing was stored by any of the refused uploads.
  assert.equal(box.files.size, 1);
  assert.equal(box.files.get("111")!.versions.length, 1);
  const rows = auditRows(db);
  assert.equal(rows.length, calls.length * cases.length);
  for (const row of rows) {
    assert.equal(row.status, "error");
    assert.match(
      row.error_message,
      /^box_(forbidden|not_found|rate_limited|error|upload_uncertain: the outcome is uncertain)$/,
    );
  }
  assert.ok(!JSON.stringify(rows).includes(BOX_ERROR_BODY_CANARY));
});

// ---------------------------------------------------------------------------
// Filing: a new file, a new version.
// ---------------------------------------------------------------------------

test("uploads are off by default: both upload routes answer 403 and Box is not asked", async () => {
  const { app, db, box } = setup();
  setEnv();
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  const connector = connectBox(db, box, "user-1");
  const bytes = documentBytes(2_000);
  box.addFile({ id: "111", name: "a.docx", bytes });
  box.grant(boxTokenOf("user-1"), "111");
  assert.equal(agentBoxUploadsEnabled(), false);

  await withApp(app, async (baseUrl) => {
    for (const value of [undefined, "off", "", "true", "1", "yes", "ON "]) {
      setEnv(value === undefined ? {} : { DOCKET_AGENT_BOX_UPLOADS: value });
      const on = value === "ON ";
      assert.equal(agentBoxUploadsEnabled(), on, String(value));
      if (on) continue;
      for (const answer of [
        await send(baseUrl, newFilePath("0", "new.docx"), fileToken, bytes),
        await send(baseUrl, "/111/versions", fileToken, bytes),
        // Off is answered before anything else about the request is looked at.
        await send(baseUrl, "?parent_id=nope", fileToken, bytes, "not-a-sha1"),
      ]) {
        assert.equal(answer.status, 403, String(value));
        assert.deepEqual(answer.json, { error: "box_uploads_off" });
        assertNoStore(answer);
      }
    }
    // Reading still works while uploads are off.
    assert.equal((await files(baseUrl, "/111/content", fileToken)).status, 200);
  });
  assert.ok(box.calls.every((call) => call.method === "GET"));
  assert.equal(box.files.size, 1);
  assert.equal(box.files.get("111")!.versions.length, 1);
  assert.equal(box.uploads.length, 0);

  // Each refusal is on record, against the user's own Box row.
  const refusals = auditRows(db).filter((row) => row.status === "error");
  assert.equal(refusals.length, 18);
  for (const row of refusals) {
    assert.equal(row.error_message, "Denied by Docket Agent gateway: box_uploads_off");
    assert.equal(row.action_kind, "mutation");
    assert.equal(row.origin, "docket_agent");
    assert.equal(row.actor_email, GARRETT);
    assert.equal(row.connector_id, connector.id);
    assert.ok(["box_file_upload", "box_file_new_version"].includes(row.tool_name));
  }
});

test("a new file is uploaded with the user's own Box sign-in, after a pending audit row", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  const connector = connectBox(db, box, "user-1");
  const tokenId = db.table("docket_agent_tokens")[0].id;
  box.addFolder("5001", "Work product");
  box.grant(boxTokenOf("user-1"), "5001");
  const bytes = documentBytes(1 * MB + 4_321);
  const name = `${NAME_CANARY} – redline & notes (v2) 100%.docx`;

  await withApp(app, async (baseUrl) => {
    db.events.length = 0;
    const answer = await send(baseUrl, newFilePath("5001", name), fileToken, bytes);
    assert.equal(answer.status, 201);
    const created = [...box.files.values()].find((file) => file.name === name)!;
    assert.ok(created, "the file is in Box under the exact name");
    assert.deepEqual(answer.json, {
      id: created.id,
      name,
      size: bytes.length,
      sha1: sha1Of(bytes),
      parent: { id: "5001", name: "Work product" },
    });
    assertNoStore(answer);
    // Box holds exactly the bytes that were sent.
    assert.equal(created.parentId, "5001");
    assert.equal(created.versions.length, 1);
    assert.ok(created.versions[0].bytes.equals(bytes));

    // The sha1 header may be upper case.
    const second = await send(
      baseUrl,
      newFilePath("5001", "second.docx"),
      fileToken,
      bytes,
      sha1Of(bytes).toUpperCase(),
    );
    assert.equal(second.status, 201);
  });

  // Order: the pending audit row, then Box (is the name free, then the
  // bytes), then the row is closed.
  assert.deepEqual(
    db.events
      .filter((event) => event.startsWith("box:") || event.includes("user_mcp_tool_audit_logs"))
      .slice(0, 4),
    [
      "db:insert:user_mcp_tool_audit_logs:pending",
      `box:OPTIONS ${BOX_API_HOST}/2.0/files/content`,
      `box:POST ${BOX_UPLOAD_HOST}/api/2.0/files/content`,
      "db:update:user_mcp_tool_audit_logs:ok",
    ],
  );
  // What Box was sent: the attributes part first, the name and folder, the
  // sha1 for Box to check, and the user's own Box token. Fixed hosts.
  assert.deepEqual(box.uploads[0].partNames, ["attributes", "file"]);
  assert.deepEqual(box.uploads[0].attributes, { name, parent: { id: "5001" } });
  assert.equal(box.uploads[0].contentMd5, sha1Of(bytes));
  assert.ok(box.uploads[0].bytes.equals(bytes));
  for (const call of box.calls) {
    assert.ok([BOX_API_HOST, BOX_UPLOAD_HOST].includes(call.host));
    assert.equal(call.authorization, `Bearer ${boxTokenOf("user-1")}`);
    assert.ok(["OPTIONS", "POST"].includes(call.method));
  }

  const rows = auditRows(db);
  assert.equal(rows.length, 2);
  const created = [...box.files.values()].find((file) => file.name === name)!;
  assert.equal(rows[0].tool_name, "box_file_upload");
  assert.equal(rows[0].action_kind, "mutation");
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[0].origin, "docket_agent");
  assert.equal(rows[0].actor_email, GARRETT);
  assert.equal(rows[0].user_id, "user-1");
  assert.equal(rows[0].agent_token_id, tokenId);
  assert.equal(rows[0].connector_id, connector.id);
  assert.equal(rows[0].result_size_chars, bytes.length);
  assert.deepEqual(rows[0].target_refs, {
    folder_id: "5001",
    size_bytes: String(bytes.length),
    file_id: created.id,
    version_id: created.versions[0].id,
  });
  // Never the file's name and never its bytes.
  assert.ok(!JSON.stringify(rows).includes("name-canary"));
  assert.ok(!JSON.stringify(rows).includes(CONTENT_CANARY));
});

test("a name that is taken answers 409 with the existing id, and nothing is changed", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  box.addFolder("5001", "Work product");
  const existingBytes = documentBytes(3_000);
  const existing = box.addFile({ id: "111", name: "Motion.docx", parentId: "5001", bytes: existingBytes });
  box.grant(boxTokenOf("user-1"), "5001", "111");
  const newBytes = documentBytes(4_000);
  const snapshot = () =>
    JSON.stringify(
      [...box.files.values()].map((file) => [
        file.id,
        file.name,
        file.parentId,
        file.versions.map((version) => [version.id, sha1Of(version.bytes)]),
      ]),
    );
  const before = snapshot();

  await withApp(app, async (baseUrl) => {
    // Box says so when asked whether the name is free: no bytes are sent.
    const taken = await send(baseUrl, newFilePath("5001", "Motion.docx"), fileToken, newBytes);
    assert.equal(taken.status, 409);
    assert.deepEqual(taken.json, { error: "name_exists", id: "111" });
    assert.ok(!box.calls.some((call) => call.host === BOX_UPLOAD_HOST));
    assert.equal(snapshot(), before);

    // Another file took the name between the question and the upload: Box
    // refuses the upload itself. It never overwrites.
    box.state.preflightBlind = true;
    const raced = await send(baseUrl, newFilePath("5001", "Motion.docx"), fileToken, newBytes);
    assert.equal(raced.status, 409);
    assert.deepEqual(raced.json, { error: "name_exists", id: "111" });
    assert.equal(snapshot(), before);
    box.state.preflightBlind = false;

    // The same name in another folder is another file.
    const elsewhere = await send(baseUrl, newFilePath("0", "Motion.docx"), fileToken, newBytes);
    assert.equal(elsewhere.status, 201);
  });
  assert.ok(existing.versions[0].bytes.equals(existingBytes));
  assert.equal(existing.versions.length, 1);
  const rows = auditRows(db);
  assert.deepEqual(rows.map((row) => [row.status, row.error_message]), [
    ["error", "name_exists"],
    ["error", "name_exists"],
    ["ok", null],
  ]);
});

test("an upload whose sha1 does not match what arrived is refused before Box is asked anything", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  const bytes = documentBytes(20_000);
  const other = documentBytes(20_000);
  box.addFile({ id: "111", name: "a.docx", bytes });
  box.grant(boxTokenOf("user-1"), "111");

  await withApp(app, async (baseUrl) => {
    for (const path of [newFilePath("0", "new.docx"), "/111/versions"]) {
      const mismatch = await send(baseUrl, path, fileToken, bytes, sha1Of(other));
      assert.equal(mismatch.status, 400, path);
      assert.deepEqual(mismatch.json, { error: "sha1_mismatch" });

      // The header is required and must be a sha1.
      for (const sha1 of [null, "", "abc", sha1Of(bytes).slice(1), `${sha1Of(bytes)}0`, "z".repeat(40)]) {
        const answer = await send(baseUrl, path, fileToken, bytes, sha1);
        assert.equal(answer.status, 400, `${path} ${String(sha1)}`);
        assert.deepEqual(answer.json, { error: "invalid_sha1" });
      }

      const empty = await send(baseUrl, path, fileToken, Buffer.alloc(0));
      assert.equal(empty.status, 400, path);
      assert.deepEqual(empty.json, { error: "empty_body" });
    }

    // The folder id and the name are checked too.
    for (const query of ["", "?name=a.docx", "?parent_id=abc&name=a.docx", "?parent_id=1&parent_id=2&name=a.docx", "?parent_id=1/2&name=a.docx"]) {
      const answer = await send(baseUrl, query, fileToken, bytes);
      assert.equal(answer.status, 400, query);
      assert.deepEqual(answer.json, { error: "invalid_parent_id" });
    }
    for (const name of ["", "a/b.docx", "a\\b.docx", "..", ".", " lead.docx", "trail.docx ", "x".repeat(256), "tab\there.docx", "nul\u0000.docx"]) {
      const answer = await send(baseUrl, newFilePath("0", name), fileToken, bytes);
      assert.equal(answer.status, 400, JSON.stringify(name));
      assert.deepEqual(answer.json, { error: "invalid_name" });
    }
    const noName = await send(baseUrl, "?parent_id=0", fileToken, bytes);
    assert.deepEqual(noName.json, { error: "invalid_name" });
    const badId = await send(baseUrl, "/abc/versions", fileToken, bytes);
    assert.equal(badId.status, 400);
    assert.deepEqual(badId.json, { error: "invalid_file_id" });
  });

  // Box was never asked anything.
  assert.equal(box.calls.length, 0);
  assert.equal(box.uploads.length, 0);
  assert.equal(box.files.get("111")!.versions.length, 1);
  // The mismatches and the empty bodies are on record; nothing was pending.
  const rows = auditRows(db);
  assert.deepEqual(
    rows.map((row) => [row.tool_name, row.status, row.error_message]),
    [
      ["box_file_upload", "error", "sha1_mismatch"],
      ["box_file_upload", "error", "empty_body"],
      ["box_file_new_version", "error", "sha1_mismatch"],
      ["box_file_new_version", "error", "empty_body"],
    ],
  );
  assert.ok(isBoxFileName("Lease – final (v2).docx"));
  assert.ok(!isBoxFileName(42));
  assert.ok(isBoxId("0") && !isBoxId("") && !isBoxId(7));
  assert.equal(normalizeSha1(` ${"AB".repeat(20)} `), "ab".repeat(20));
  assert.equal(normalizeSha1(undefined), null);
});

test("an upload over the size limit answers 413 and Box is not asked", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on", DOCKET_AGENT_BOX_MAX_UPLOAD_MB: "1" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  box.addFile({ id: "111", name: "a.docx", bytes: documentBytes(100) });
  box.grant(boxTokenOf("user-1"), "111");
  const over = documentBytes(MB + 1);
  const atLimit = documentBytes(MB);

  await withApp(app, async (baseUrl) => {
    for (const path of [newFilePath("0", "over.docx"), "/111/versions"]) {
      const answer = await send(baseUrl, path, fileToken, over);
      assert.equal(answer.status, 413, path);
      assert.deepEqual(answer.json, { error: "payload_too_large", max_bytes: MB });
    }
    assert.equal(box.calls.length, 0);
    const ok = await send(baseUrl, newFilePath("0", "at-limit.docx"), fileToken, atLimit);
    assert.equal(ok.status, 201);
  });
  assert.equal(box.files.get("111")!.versions.length, 1);
  const rows = auditRows(db);
  assert.deepEqual(rows.map((row) => [row.status, row.error_message]), [
    ["error", "payload_too_large"],
    ["error", "payload_too_large"],
    ["ok", null],
  ]);

  // The default is 50 MB, which is also the most Box takes in one request:
  // a larger setting does not raise it.
  setEnv();
  assert.equal(agentBoxMaxUploadBytes(), 50 * MB);
  setEnv({ DOCKET_AGENT_BOX_MAX_UPLOAD_MB: "500" });
  assert.equal(agentBoxMaxUploadBytes(), 50 * MB);
  setEnv({ DOCKET_AGENT_BOX_MAX_UPLOAD_MB: "10" });
  assert.equal(agentBoxMaxUploadBytes(), 10 * MB);
});

test("a new version is added to the existing file; the earlier version and the name are kept", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  const connector = connectBox(db, box, "user-1");
  box.addFolder("5001", "Work product");
  const v1 = documentBytes(300_000);
  const v2 = documentBytes(310_000);
  const file = box.addFile({ id: "111", name: "Complaint.docx", parentId: "5001", bytes: v1, versionId: "9001" });
  box.grant(boxTokenOf("user-1"), "111", "5001");

  await withApp(app, async (baseUrl) => {
    db.events.length = 0;
    const answer = await send(baseUrl, "/111/versions", fileToken, v2);
    assert.equal(answer.status, 201);
    assert.equal(file.versions.length, 2);
    const newVersionId = file.versions[1].id;
    assert.deepEqual(answer.json, {
      id: "111",
      name: "Complaint.docx",
      size: v2.length,
      sha1: sha1Of(v2),
      parent: { id: "5001", name: "Work product" },
      version_id: newVersionId,
    });
    assert.notEqual(newVersionId, "9001");

    // Box kept the earlier version, byte for byte, and the file's name and place.
    assert.ok(file.versions[0].bytes.equals(v1));
    assert.ok(file.versions[1].bytes.equals(v2));
    assert.equal(file.name, "Complaint.docx");
    assert.equal(file.parentId, "5001");
    assert.equal(box.files.size, 1);

    // Both can be fetched exactly.
    assert.ok((await files(baseUrl, "/111/content", fileToken)).bytes.equals(v2));
    assert.ok((await files(baseUrl, "/111/content?version=9001", fileToken)).bytes.equals(v1));
  });

  // The pending row first, then Box: what the file is now (a read), then one
  // request to the fixed upload host.
  assert.deepEqual(
    db.events
      .filter((event) => event.startsWith("box:") || event.includes("user_mcp_tool_audit_logs"))
      .slice(0, 4),
    [
      "db:insert:user_mcp_tool_audit_logs:pending",
      `box:GET ${BOX_API_HOST}/2.0/files/111`,
      `box:POST ${BOX_UPLOAD_HOST}/api/2.0/files/111/content`,
      "db:update:user_mcp_tool_audit_logs:ok",
    ],
  );
  // No name and no folder is sent with a new version: nothing is renamed or moved.
  assert.deepEqual(box.uploads[0].attributes, {});
  assert.equal(box.uploads[0].contentMd5, sha1Of(v2));
  // The upload is tied to the state of the file that was just read.
  const versionPost = box.calls.find((call) => call.method === "POST")!;
  assert.equal(versionPost.headers["if-match"], "1");

  const row = auditRows(db)[0];
  assert.equal(row.tool_name, "box_file_new_version");
  assert.equal(row.action_kind, "mutation");
  assert.equal(row.status, "ok");
  assert.equal(row.origin, "docket_agent");
  assert.equal(row.actor_email, GARRETT);
  assert.equal(row.connector_id, connector.id);
  assert.equal(row.result_size_chars, v2.length);
  assert.deepEqual(row.target_refs, {
    file_id: "111",
    size_bytes: String(v2.length),
    version_id: file.versions[1].id,
  });
});

test("an upload is not sent when its audit row cannot be written", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  const bytes = documentBytes(5_000);
  box.addFile({ id: "111", name: "a.docx", bytes });
  box.grant(boxTokenOf("user-1"), "111");

  await withApp(app, async (baseUrl) => {
    for (const path of [newFilePath("0", "new.docx"), "/111/versions"]) {
      db.failOn("user_mcp_tool_audit_logs", "insert");
      const answer = await send(baseUrl, path, fileToken, bytes);
      assert.equal(answer.status, 503, path);
      assert.deepEqual(answer.json, { error: "audit_unavailable" });
    }
  });
  // Fail closed: Box was not asked anything, not even whether the name is free.
  assert.equal(box.calls.length, 0);
  assert.equal(box.files.size, 1);
  assert.equal(box.files.get("111")!.versions.length, 1);
  assert.equal(auditRows(db).length, 0);
});

test("an upload whose answer is lost is reported as uncertain, never as done", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  const bytes = documentBytes(5_000);

  await withApp(app, async (baseUrl) => {
    box.state.dropUploadAnswer = true;
    const lost = await send(baseUrl, newFilePath("0", "lost.docx"), fileToken, bytes);
    assert.equal(lost.status, 502);
    assert.deepEqual(lost.json, { error: "box_upload_uncertain" });
    box.state.dropUploadAnswer = false;

    // Box answers with other content than was sent. (Box checks the sha1
    // itself, so this should not happen. If it does, it is not a 201.)
    box.state.corruptUploads = true;
    const wrong = await send(baseUrl, newFilePath("0", "wrong.docx"), fileToken, bytes);
    assert.equal(wrong.status, 502);
    assert.equal(wrong.json.error, "box_upload_unverified");
    assert.match(wrong.json.id, /^\d+$/);
  });
  const rows = auditRows(db);
  assert.deepEqual(rows.map((row) => [row.status, row.error_message]), [
    ["error", "box_upload_uncertain: the outcome is uncertain"],
    ["error", "box_upload_unverified"],
  ]);
  assert.ok(capturedLogs.some((line) => line.includes("[agent-gateway] box file call failed")));
});

// ---------------------------------------------------------------------------
// Limits on filing. The Box file token is the one a session's sandbox holds,
// so a session that was talked into misbehaving must not be able to shut the
// other users out, or to bury a document under a run of new versions.
// ---------------------------------------------------------------------------

test("one token cannot hold every upload place: the other users still file", async () => {
  const { app, db, box, tokenReads } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const a = await enroll(db, "user-a", GARRETT);
  const b = await enroll(db, "user-b", JERAD);
  const c = await enroll(db, "user-c", KRISTA);
  for (const userId of ["user-a", "user-b", "user-c"]) connectBox(db, box, userId);
  const bytes = documentBytes(5_000);
  const open: StalledUpload[] = [];
  /** An upload that says 1000 bytes, sends one, and then holds its place. */
  const stall = (baseUrl: string, token: string, name: string) => {
    const upload = stalledUpload(baseUrl, newFilePath("0", name), token, {
      declared: 1_000,
      first: Buffer.from("x"),
    });
    open.push(upload);
    return upload;
  };
  /** The sign-in is read once a place is taken: that is how a held place shows. */
  const placesTaken = (count: number) =>
    until(() => tokenReads.length === count, `place ${count} was not taken`);

  await withApp(app, async (baseUrl) => {
    try {
      // User A's session opens four slow uploads. Two get a place.
      stall(baseUrl, a.fileToken, "a1.docx");
      await placesTaken(1);
      stall(baseUrl, a.fileToken, "a2.docx");
      await placesTaken(2);
      // The third and the fourth are refused at once: one token never has
      // more than two of the four places.
      for (const name of ["a3.docx", "a4.docx"]) {
        const refused = await within(stall(baseUrl, a.fileToken, name).answer, 2_000, "no answer");
        assert.equal(refused.status, 503);
        assert.deepEqual(refused.json, { error: "uploads_busy" });
        assert.match(refused.head, /^retry-after: 5$/im);
      }
      assert.equal(tokenReads.length, 2);

      // User B files while A's uploads are still open, and again after.
      for (const name of ["b1.docx", "b2.docx"]) {
        const filed = await within(
          send(baseUrl, newFilePath("0", name), b.fileToken, bytes),
          5_000,
          "user B's upload got no answer while user A's were open",
        );
        assert.equal(filed.status, 201, name);
      }
      assert.equal(tokenReads.length, 4);

      // The limit in all still holds: with two of A's and two of B's held,
      // there is no place for C.
      stall(baseUrl, b.fileToken, "b3.docx");
      await placesTaken(5);
      stall(baseUrl, b.fileToken, "b4.docx");
      await placesTaken(6);
      const full = await send(baseUrl, newFilePath("0", "c1.docx"), c.fileToken, bytes);
      assert.equal(full.status, 503);
      assert.deepEqual(full.json, { error: "uploads_busy" });
      assert.equal(full.headers.get("retry-after"), "5");

      // A caller that goes away gives its place back.
      open[0].drop();
      await until(
        () => db.table("user_mcp_tool_audit_logs").some((row) => row.error_message === "invalid_body"),
        "the dropped upload was not given up",
      );
      const afterDrop = await send(baseUrl, newFilePath("0", "c1.docx"), c.fileToken, bytes);
      assert.equal(afterDrop.status, 201);
    } finally {
      for (const upload of open) upload.drop();
      await Promise.all(open.map((upload) => upload.closed));
    }
  });

  // Only the three real uploads reached Box.
  assert.equal(box.uploads.length, 3);
  assert.deepEqual(
    [...box.files.values()].map((file) => file.name).sort(),
    ["b1.docx", "b2.docx", "c1.docx"],
  );
  auditRows(db);
});

test("an upload body that does not arrive in time is given up, and its place is free again", async () => {
  const { app, db, box } = setup({
    boxUploadTimeouts: { bodyMs: 200, unreadBodyGraceMs: 100 },
  });
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-a", GARRETT);
  connectBox(db, box, "user-a");
  const bytes = documentBytes(5_000);
  const open: StalledUpload[] = [];

  await withApp(app, async (baseUrl) => {
    try {
      // Both of the token's places are held by uploads that stop sending.
      for (const name of ["slow1.docx", "slow2.docx"]) {
        open.push(
          stalledUpload(baseUrl, newFilePath("0", name), fileToken, {
            declared: 1_000,
            first: Buffer.from("x"),
          }),
        );
      }
      for (const upload of open) {
        const answer = await within(upload.answer, 3_000, "the slow upload was never given up");
        assert.equal(answer.status, 408);
        assert.deepEqual(answer.json, { error: "upload_timeout" });
        assert.match(answer.head, /^connection: close$/im);
        assert.match(answer.head, /^cache-control: no-store$/im);
        // The gateway closes the connection. This caller never does.
        await within(upload.closed, 3_000, "the connection was left open");
      }
      // The places are free: the same token files at once.
      const filed = await within(
        send(baseUrl, newFilePath("0", "after.docx"), fileToken, bytes),
        3_000,
        "the places were not given back",
      );
      assert.equal(filed.status, 201);
    } finally {
      for (const upload of open) upload.drop();
    }
  });

  assert.equal(box.uploads.length, 1);
  const rows = auditRows(db);
  assert.deepEqual(
    rows.map((row) => [row.tool_name, row.action_kind, row.status, row.error_message]),
    [
      ["box_file_upload", "mutation", "error", "upload_timeout"],
      ["box_file_upload", "mutation", "error", "upload_timeout"],
      ["box_file_upload", "mutation", "ok", null],
    ],
  );
});

test("a body that is too large is refused at once: it is not read to its end and it takes no place", async () => {
  const { app, db, box, tokenReads } = setup({
    boxUploadTimeouts: { bodyMs: 60_000, unreadBodyGraceMs: 150 },
  });
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on", DOCKET_AGENT_BOX_MAX_UPLOAD_MB: "1" });
  const { fileToken } = await enroll(db, "user-a", GARRETT);
  connectBox(db, box, "user-a");
  box.addFile({ id: "111", name: "a.docx", bytes: documentBytes(100) });
  box.grant(boxTokenOf("user-a"), "111");
  const open: StalledUpload[] = [];

  await withApp(app, async (baseUrl) => {
    try {
      // Five uploads that say 5 MB and send one byte. Each is answered
      // without waiting for the rest, and none of them takes a place: five
      // is more than one token may hold, and more than there are in all.
      for (let i = 0; i < 5; i += 1) {
        open.push(
          stalledUpload(baseUrl, i % 2 ? "/111/versions" : newFilePath("0", `big${i}.docx`), fileToken, {
            declared: 5 * MB,
            first: Buffer.from("x"),
          }),
        );
      }
      for (const upload of open) {
        const answer = await within(upload.answer, 1_000, "the answer waited for the body");
        assert.equal(answer.status, 413);
        assert.deepEqual(answer.json, { error: "payload_too_large", max_bytes: MB });
      }
      // The sign-in was not even looked at.
      assert.equal(tokenReads.length, 0);

      // A body with no declared length is stopped at the first byte past
      // the limit, long before its end.
      const chunked = stalledUpload(baseUrl, newFilePath("0", "chunked.docx"), fileToken, {
        declared: null,
        first: documentBytes(MB + 1),
      });
      open.push(chunked);
      const answer = await within(chunked.answer, 2_000, "the answer waited for the end of the body");
      assert.equal(answer.status, 413);
      assert.deepEqual(answer.json, { error: "payload_too_large", max_bytes: MB });

      // None of these callers closes its connection or sends any more. The
      // gateway cuts each one shortly after its answer.
      for (const upload of open) {
        await within(upload.closed, 3_000, "a connection was left open for an unread body");
      }

      // The places were never taken: a real upload goes through.
      const filed = await send(baseUrl, newFilePath("0", "fits.docx"), fileToken, documentBytes(MB));
      assert.equal(filed.status, 201);
    } finally {
      for (const upload of open) upload.drop();
    }
  });

  assert.equal(box.uploads.length, 1);
  assert.equal(box.files.get("111")!.versions.length, 1);
  const rows = auditRows(db);
  assert.deepEqual(
    rows.map((row) => [row.status, row.error_message]),
    [...Array.from({ length: 6 }, () => ["error", "payload_too_large"]), ["ok", null]],
  );
});

test("one token only has so many downloads open at once", async () => {
  const { app, db, box } = setup();
  setEnv();
  const a = await enroll(db, "user-a", GARRETT);
  const b = await enroll(db, "user-b", JERAD);
  connectBox(db, box, "user-a");
  connectBox(db, box, "user-b");
  const bytes = documentBytes(400_000);
  box.addFile({ id: "111", name: "big.pdf", bytes });
  box.grant(boxTokenOf("user-a"), "111");
  box.grant(boxTokenOf("user-b"), "111");
  // Box stops part of the way through every download until it is let go.
  let release!: () => void;
  box.state.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  box.state.gateAfterBytes = 200_000;
  const start = (baseUrl: string, token: string) =>
    within(
      fetch(`${baseUrl}/agent-mcp/box/files/111/content`, { headers: bearer(token) }),
      10_000,
      "the download did not start",
    );

  await withApp(app, async (baseUrl) => {
    try {
      // Sixteen downloads of user A are under way, none of them finished.
      const under: Response[] = [];
      for (let i = 0; i < 16; i += 1) {
        const response = await start(baseUrl, a.fileToken);
        assert.equal(response.status, 200);
        under.push(response);
      }
      // The next one is told to come back. So is the one after.
      for (let i = 0; i < 2; i += 1) {
        const busy = await within(
          files(baseUrl, "/111/content", a.fileToken),
          5_000,
          "one download too many was let in",
        );
        assert.equal(busy.status, 503);
        assert.deepEqual(busy.json, { error: "downloads_busy" });
        assert.equal(busy.headers.get("retry-after"), "5");
        assertNoStore(busy);
      }
      // File details are not a download, and another user's downloads are
      // his own.
      assert.equal((await files(baseUrl, "/111", a.fileToken)).status, 200);
      const other = await start(baseUrl, b.fileToken);
      assert.equal(other.status, 200);

      release();
      for (const response of [...under, other]) {
        assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes));
      }
      // The places are given back when the downloads end.
      await until(
        () => db.table("user_mcp_tool_audit_logs").filter((row) => row.tool_name === "box_file_download").length === 17,
        "the downloads did not finish",
      );
      const again = await files(baseUrl, "/111/content", a.fileToken);
      assert.equal(again.status, 200);
      assert.ok(again.bytes.equals(bytes));
    } finally {
      release();
    }
  });
  // The two that were turned away asked Box nothing.
  assert.equal(
    box.calls.filter((call) => call.host === BOX_API_HOST && call.path === "/2.0/files/111/content").length,
    18,
  );
  auditRows(db);
});

test("uploads have a small budget of their own, apart from the budget for reading", async () => {
  let now = NOW;
  const { app, db, box } = setup({ now: () => now });
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on", DOCKET_AGENT_BOX_MAX_UPLOADS_PER_WINDOW: "3" });
  const a = await enroll(db, "user-a", GARRETT);
  const b = await enroll(db, "user-b", JERAD);
  connectBox(db, box, "user-a");
  connectBox(db, box, "user-b");
  const stored = documentBytes(2_000);
  box.addFile({ id: "111", name: "a.docx", bytes: stored });
  box.grant(boxTokenOf("user-a"), "111");
  const usedUp = () =>
    capturedLogs.filter((line) => line.includes("[agent-gateway] box upload budget used up")).length;
  const logged = usedUp();

  await withApp(app, async (baseUrl) => {
    // A request that is refused before it is given a place does not count.
    for (let i = 0; i < 5; i += 1) {
      const bad = await send(baseUrl, newFilePath("0", "bad.docx"), a.fileToken, documentBytes(100), "not-a-sha1");
      assert.equal(bad.status, 400);
    }
    for (let i = 0; i < 3; i += 1) {
      const filed = await send(baseUrl, newFilePath("0", `n${i}.docx`), a.fileToken, documentBytes(1_000));
      assert.equal(filed.status, 201, String(i));
    }
    // The fourth upload of the window is refused, whichever upload route it
    // takes, and Box is asked nothing.
    const asked = box.calls.length;
    const rows = db.table("user_mcp_tool_audit_logs").length;
    for (const path of [newFilePath("0", "n3.docx"), "/111/versions", newFilePath("0", "n4.docx")]) {
      const limited = await send(baseUrl, path, a.fileToken, documentBytes(1_000));
      assert.equal(limited.status, 429, path);
      assert.deepEqual(limited.json, { error: "upload_rate_limited" });
      assert.equal(limited.headers.get("retry-after"), "900");
      assertNoStore(limited);
    }
    assert.equal(box.calls.length, asked);
    assert.equal(db.table("user_mcp_tool_audit_logs").length, rows);
    // One log line for the window, not one per refusal. Never a token.
    assert.equal(usedUp() - logged, 1);

    // Reading is not stopped by it, and another user's budget is his own.
    assert.equal((await files(baseUrl, "/111", a.fileToken)).status, 200);
    assert.ok((await files(baseUrl, "/111/content", a.fileToken)).bytes.equals(stored));
    assert.equal(
      (await send(baseUrl, newFilePath("0", "b.docx"), b.fileToken, documentBytes(1_000))).status,
      201,
    );

    // The next window starts a new budget.
    now += 14 * MINUTE;
    const early = await send(baseUrl, newFilePath("0", "n5.docx"), a.fileToken, documentBytes(1_000));
    assert.equal(early.status, 429);
    assert.equal(early.headers.get("retry-after"), "60");
    now += MINUTE;
    const later = await send(baseUrl, newFilePath("0", "n5.docx"), a.fileToken, documentBytes(1_000));
    assert.equal(later.status, 201);
  });
  assert.equal(box.files.get("111")!.versions.length, 1);
  auditRows(db);

  // 30 uploads per window unless set otherwise; the budget for reading is
  // fifty times that.
  setEnv();
  assert.equal(agentBoxMaxUploadsPerWindow(), 30);
  assert.equal(agentBoxMaxVersionsPerDay(), 10);
  setEnv({ DOCKET_AGENT_BOX_MAX_UPLOADS_PER_WINDOW: "0", DOCKET_AGENT_BOX_MAX_VERSIONS_PER_DAY: "junk" });
  assert.equal(agentBoxMaxUploadsPerWindow(), 30);
  assert.equal(agentBoxMaxVersionsPerDay(), 10);
});

test("a run of new versions of one file stops at the day's limit, and the first version is still there", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-a", GARRETT);
  connectBox(db, box, "user-a");
  const genuine = documentBytes(3_000);
  const file = box.addFile({ id: "4001", name: "Lease.docx", bytes: genuine, versionId: "9001" });
  box.grant(boxTokenOf("user-a"), "4001");

  const statuses: string[] = [];
  await withApp(app, async (baseUrl) => {
    // What the review tried: 120 new versions of junk, one after another.
    for (let i = 0; i < 120; i += 1) {
      const answer = await send(baseUrl, "/4001/versions", fileToken, documentBytes(200));
      statuses.push(`${answer.status}${answer.status === 201 ? "" : ` ${answer.json.error}`}`);
    }
  });
  // With the settings as shipped: ten are stored, the next twenty are
  // refused by the limit for one file, and then the upload budget is spent.
  assert.deepEqual(statuses, [
    ...Array.from({ length: 10 }, () => "201"),
    ...Array.from({ length: 20 }, () => "429 version_limit_reached"),
    ...Array.from({ length: 90 }, () => "429 upload_rate_limited"),
  ]);
  assert.equal(file.versions.length, 11);
  assert.equal(box.uploads.length, 10);
  assert.equal(file.versions[0].id, "9001");
  assert.ok(file.versions[0].bytes.equals(genuine));
  const rows = auditRows(db);
  assert.equal(rows.length, 30);
  assert.ok(rows.slice(10).every((row) => row.status === "error" && row.error_message === "version_limit_reached"));
});

test("only so many new versions of one file in a day, counted from the audit rows", async () => {
  const { app, db, box } = setup();
  setEnv({
    DOCKET_AGENT_BOX_UPLOADS: "on",
    DOCKET_AGENT_BOX_MAX_VERSIONS_PER_DAY: "2",
    DOCKET_AGENT_BOX_MAX_UPLOADS_PER_WINDOW: "100",
  });
  const a = await enroll(db, "user-a", GARRETT);
  const b = await enroll(db, "user-b", JERAD);
  connectBox(db, box, "user-a");
  connectBox(db, box, "user-b");
  for (const id of ["111", "222", "333"]) {
    box.addFile({ id, name: `${id}.docx`, bytes: documentBytes(1_000) });
    box.grant(boxTokenOf("user-a"), id);
  }
  box.grant(boxTokenOf("user-b"), "111");
  const versions = (id: string) => box.files.get(id)!.versions.length;
  const version = (baseUrl: string, id: string, token = a.fileToken) =>
    send(baseUrl, `/${id}/versions`, token, documentBytes(1_000));

  await withApp(app, async (baseUrl) => {
    assert.equal((await version(baseUrl, "111")).status, 201);
    assert.equal((await version(baseUrl, "111")).status, 201);
    const posts = () => box.calls.filter((call) => call.method === "POST").length;
    const sent = posts();
    const third = await version(baseUrl, "111");
    assert.equal(third.status, 429);
    assert.deepEqual(third.json, { error: "version_limit_reached", max_per_day: 2 });
    assertNoStore(third);
    // Nothing was sent to the upload host, and the file is as it was.
    assert.equal(posts(), sent);
    assert.equal(versions("111"), 3);

    // The limit is for one file, and for one user's sessions.
    assert.equal((await version(baseUrl, "222")).status, 201);
    assert.equal((await version(baseUrl, "111", b.fileToken)).status, 201);

    // A version Box refused does not count. One whose answer was lost does:
    // it may be there.
    box.state.failNext.push({ match: (call) => call.method === "POST", status: 403, code: "access_denied" });
    assert.equal((await version(baseUrl, "333")).status, 403);
    box.state.dropUploadAnswer = true;
    const lost = await version(baseUrl, "333");
    assert.equal(lost.status, 502);
    assert.deepEqual(lost.json, { error: "box_upload_uncertain" });
    box.state.dropUploadAnswer = false;
    assert.equal((await version(baseUrl, "333")).status, 201);
    assert.equal((await version(baseUrl, "333")).status, 429);
    assert.equal(versions("333"), 3);

    // When the audit rows cannot be read, nothing is sent (fail closed).
    db.failOn("user_mcp_tool_audit_logs", "select");
    const before = posts();
    const blind = await version(baseUrl, "222");
    assert.equal(blind.status, 503);
    assert.deepEqual(blind.json, { error: "audit_unavailable" });
    assert.equal(posts(), before);
    assert.equal(versions("222"), 2);

    // Rows from more than a day ago are not counted. (The stand-in database
    // stamps rows with the real clock; the gateway counts from its own.)
    for (const row of db.table("user_mcp_tool_audit_logs")) {
      row.created_at = iso(-23 * 60 * MINUTE);
    }
    assert.equal((await version(baseUrl, "111")).status, 429);
    for (const row of db.table("user_mcp_tool_audit_logs")) {
      row.created_at = iso(-25 * 60 * MINUTE);
    }
    assert.equal((await version(baseUrl, "111")).status, 201);
    assert.equal(versions("111"), 5);
  });

  const rows = auditRows(db);
  const refused = rows.filter((row) => row.error_message === "version_limit_reached");
  assert.equal(refused.length, 3);
  for (const row of refused) {
    assert.equal(row.tool_name, "box_file_new_version");
    assert.equal(row.action_kind, "mutation");
    assert.equal(row.status, "error");
    assert.equal(row.actor_email, GARRETT);
  }
  assert.equal(rows.filter((row) => row.error_message === "audit_unavailable").length, 1);
  // No upload was left pending.
  assert.ok(rows.every((row) => row.status !== "pending"));
});

test("sending the same bytes again adds no version, so a repeated upload is safe", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on", DOCKET_AGENT_BOX_MAX_VERSIONS_PER_DAY: "2" });
  const { fileToken } = await enroll(db, "user-a", GARRETT);
  connectBox(db, box, "user-a");
  box.addFolder("5001", "Work product");
  const v1 = documentBytes(30_000);
  const v2 = documentBytes(31_000);
  const v3 = documentBytes(32_000);
  const file = box.addFile({ id: "111", name: "Complaint.docx", parentId: "5001", bytes: v1, versionId: "9001" });
  box.grant(boxTokenOf("user-a"), "111", "5001");
  const posts = () => box.calls.filter((call) => call.method === "POST").length;

  await withApp(app, async (baseUrl) => {
    const first = await send(baseUrl, "/111/versions", fileToken, v2);
    assert.equal(first.status, 201);
    assert.equal(file.versions.length, 2);

    // The same bytes again: Box already holds them as the current version.
    const sent = posts();
    const again = await send(baseUrl, "/111/versions", fileToken, v2);
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { ...first.json, unchanged: true });
    assert.equal(again.json.version_id, file.versions[1].id);
    assertNoStore(again);
    assert.equal(posts(), sent);
    assert.equal(file.versions.length, 2);

    // Even the bytes Box held before any upload: nothing to do.
    const other = box.addFile({ id: "222", name: "Other.docx", bytes: v1 });
    box.grant(boxTokenOf("user-a"), "222");
    const same = await send(baseUrl, "/222/versions", fileToken, v1);
    assert.equal(same.status, 200);
    assert.equal(same.json.unchanged, true);
    assert.equal(other.versions.length, 1);

    // The answer to an upload is lost, but Box stored it. Sending it again
    // (what a caller does after "uncertain") finds it there and adds nothing.
    box.state.dropUploadAnswer = true;
    const lost = await send(baseUrl, "/111/versions", fileToken, v3);
    assert.equal(lost.status, 502);
    assert.deepEqual(lost.json, { error: "box_upload_uncertain" });
    box.state.dropUploadAnswer = false;
    assert.equal(file.versions.length, 3);
    for (let i = 0; i < 3; i += 1) {
      const retry = await send(baseUrl, "/111/versions", fileToken, v3);
      assert.equal(retry.status, 200);
      assert.equal(retry.json.unchanged, true);
      assert.equal(retry.json.sha1, sha1Of(v3));
      assert.equal(retry.json.version_id, file.versions[2].id);
    }
    assert.equal(file.versions.length, 3);
    // Those repeats are answered although the day's two versions are used
    // up; a different upload is not.
    const more = await send(baseUrl, "/111/versions", fileToken, documentBytes(500));
    assert.equal(more.status, 429);
    assert.equal(more.json.error, "version_limit_reached");
  });
  assert.ok(file.versions[0].bytes.equals(v1));
  assert.ok(file.versions[1].bytes.equals(v2));
  assert.ok(file.versions[2].bytes.equals(v3));

  // The record says what happened: asked for a new version, nothing changed.
  const unchanged = auditRows(db).filter((row) => row.target_refs.unchanged === "true");
  assert.equal(unchanged.length, 5);
  for (const row of unchanged) {
    assert.equal(row.tool_name, "box_file_new_version");
    assert.equal(row.action_kind, "read");
    assert.equal(row.status, "ok");
    assert.equal(row.error_message, null);
    assert.equal(row.origin, "docket_agent");
    assert.equal(row.actor_email, GARRETT);
  }
  assert.deepEqual(unchanged[0].target_refs, {
    file_id: "111",
    size_bytes: String(v2.length),
    version_id: file.versions[1].id,
    unchanged: "true",
  });
});

test("a new version only goes on top of the file as it was read, and of the version the caller names", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-a", GARRETT);
  connectBox(db, box, "user-a");
  const v1 = documentBytes(10_000);
  const file = box.addFile({ id: "111", name: "Complaint.docx", bytes: v1, versionId: "9001" });
  box.grant(boxTokenOf("user-a"), "111");
  const posts = () => box.calls.filter((call) => call.method === "POST").length;
  const base = (sha1: string) => ({ "X-Docket-Base-Sha1": sha1 });

  await withApp(app, async (baseUrl) => {
    // A partner saves a version between the gateway's look at the file and
    // its upload. Box refuses the upload: it carried the state it was for.
    const partners = documentBytes(10_500);
    box.state.beforeUpload = () => {
      box.state.beforeUpload = null;
      file.versions.push({ id: "9002", bytes: partners, modifiedAt: "2026-10-01T11:59:00-05:00" });
    };
    const raced = await send(baseUrl, "/111/versions", fileToken, documentBytes(11_000));
    assert.equal(raced.status, 409);
    assert.deepEqual(raced.json, { error: "box_file_changed" });
    assert.equal(box.calls.at(-1)!.headers["if-match"], "1");
    assert.equal(file.versions.length, 2);
    assert.ok(file.versions[1].bytes.equals(partners));

    // The caller says which file it started from. It started from v1, and
    // the partner's version is now the current one: nothing is sent.
    const sent = posts();
    const stale = await sendWith(baseUrl, "/111/versions", fileToken, documentBytes(11_000), base(sha1Of(v1)));
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.json, { error: "box_file_changed" });
    assert.equal(posts(), sent);
    assert.equal(file.versions.length, 2);

    // Started from the current one (either case): it goes on top.
    const mine = documentBytes(11_000);
    const ok = await sendWith(baseUrl, "/111/versions", fileToken, mine, base(sha1Of(partners).toUpperCase()));
    assert.equal(ok.status, 201);
    assert.equal(file.versions.length, 3);
    assert.equal(box.calls.at(-1)!.headers["if-match"], "2");
    // Sent again with the same header, which is stale by now: the bytes are
    // already there, so the answer is "unchanged", not a conflict.
    const again = await sendWith(baseUrl, "/111/versions", fileToken, mine, base(sha1Of(partners)));
    assert.equal(again.status, 200);
    assert.equal(again.json.unchanged, true);

    // The header must be a sha1 when it is there at all.
    for (const value of ["abc", "z".repeat(40), `${sha1Of(v1)}0`]) {
      const bad = await sendWith(baseUrl, "/111/versions", fileToken, documentBytes(100), base(value));
      assert.equal(bad.status, 400, value);
      assert.deepEqual(bad.json, { error: "invalid_base_sha1" });
    }
    // It means nothing for a new file.
    const fresh = await sendWith(baseUrl, newFilePath("0", "new.docx"), fileToken, documentBytes(100), base("abc"));
    assert.equal(fresh.status, 201);

    // Without Box's mark of the file's state there is nothing to tie the
    // upload to: it is not sent.
    box.state.omitEtag = true;
    const before = posts();
    const unmarked = await send(baseUrl, "/111/versions", fileToken, documentBytes(100));
    assert.equal(unmarked.status, 502);
    assert.deepEqual(unmarked.json, { error: "box_error" });
    assert.equal(posts(), before);
    box.state.omitEtag = false;
  });
  assert.equal(file.versions.length, 3);
  assert.ok(file.versions[0].bytes.equals(v1));
  const rows = auditRows(db);
  assert.deepEqual(
    rows.map((row) => [row.tool_name, row.status, row.error_message]),
    [
      ["box_file_new_version", "error", "box_file_changed"],
      ["box_file_new_version", "error", "box_file_changed"],
      ["box_file_new_version", "ok", null],
      ["box_file_new_version", "ok", null],
      ["box_file_upload", "ok", null],
      ["box_file_new_version", "error", "box_error"],
    ],
  );
});

test("there is no route to delete, move, rename, copy, share or tag anything", async () => {
  const { app, db, box } = setup();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  connectBox(db, box, "user-1");
  box.addFile({ id: "111", name: "a.docx", bytes: documentBytes(100) });
  box.grant(boxTokenOf("user-1"), "111");
  const body = JSON.stringify({ parent: { id: "0" }, name: "renamed.docx", shared_link: {} });
  const json = { "Content-Type": "application/json" };

  await withApp(app, async (baseUrl) => {
    assert.equal((await files(baseUrl, "/111", fileToken)).status, 200);
    const before = box.calls.length;

    const wrongMethod: Array<[string, string, string]> = [
      ["DELETE", "/111", "GET"],
      ["PUT", "/111", "GET"],
      ["PATCH", "/111", "GET"],
      ["POST", "/111", "GET"],
      ["DELETE", "/111/content", "GET"],
      ["PUT", "/111/content", "GET"],
      ["POST", "/111/content", "GET"],
      ["DELETE", "/111/versions", "POST"],
      ["GET", "/111/versions", "POST"],
      ["PUT", "/111/versions", "POST"],
      ["DELETE", "", "POST"],
      ["PUT", "", "POST"],
      ["GET", "", "POST"],
      ["PATCH", "?parent_id=0&name=a.docx", "POST"],
    ];
    for (const [method, path, allow] of wrongMethod) {
      const answer = await files(baseUrl, path, fileToken, {
        method,
        ...(method === "GET" ? {} : { headers: json, body }),
      });
      assert.equal(answer.status, 405, `${method} ${path}`);
      assert.equal(answer.headers.get("allow"), allow, `${method} ${path}`);
      assert.deepEqual(answer.json, { error: "method_not_allowed" });
    }

    const noSuchRoute = [
      "/111/copy",
      "/111/move",
      "/111/rename",
      "/111/trash",
      "/111/shared_link",
      "/111/collaborations",
      "/111/metadata",
      "/111/metadata/global/properties",
      "/111/versions/9001",
      "/111/versions/current",
      "/111/content/extra",
    ];
    for (const path of noSuchRoute) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const answer = await files(baseUrl, path, fileToken, {
          method,
          ...(method === "GET" ? {} : { headers: json, body }),
        });
        assert.equal(answer.status, 404, `${method} ${path}`);
        assert.deepEqual(answer.json, { error: "not_found" });
      }
    }
    // Nothing next to the file routes either: no folders, no sharing.
    for (const path of ["/box/folders/0", "/box/folders", "/box/shared_links", "/box/collaborations", "/box/file/111"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const answer = await request(`${baseUrl}/agent-mcp${path}`, { method, headers: bearer(fileToken) });
        assert.equal(answer.status, 404, `${method} ${path}`);
        assert.deepEqual(answer.json, { error: "not_found" });
      }
    }
    // None of it reached Box.
    assert.equal(box.calls.length, before);
  });
  assert.equal(box.files.get("111")!.name, "a.docx");
  assert.equal(auditRows(db).length, 1);
});

// ---------------------------------------------------------------------------
// Status and rate limits.
// ---------------------------------------------------------------------------

test("the ops status reports the Box file routes and the upload switch", async () => {
  const { app, db } = setup();
  setEnv({ DOCKET_AGENT_STATUS_TOKEN: TEST_STATUS_TOKEN });
  await enroll(db, "user-1", GARRETT);

  await withApp(app, async (baseUrl) => {
    const off = await ops(baseUrl, "/status");
    assert.equal(off.status, 200);
    assert.deepEqual(off.json.box_files, { download: true, upload: false });
    assert.deepEqual(Object.keys(off.json).sort(), ["box_files", "box_organize", "practicepanther_writes", "problems", "users"]);

    setEnv({ DOCKET_AGENT_STATUS_TOKEN: TEST_STATUS_TOKEN, DOCKET_AGENT_BOX_UPLOADS: "on" });
    // The status token (the poller's) sees it too.
    const on = await ops(baseUrl, "/status?keepalive=1", { token: TEST_STATUS_TOKEN });
    assert.deepEqual(on.json.box_files, { download: true, upload: true });

    // The PracticePanther write switch is a different switch.
    setEnv({ DOCKET_AGENT_PRACTICEPANTHER_WRITES: "on" });
    const ppOnly = await ops(baseUrl, "/status");
    assert.deepEqual(ppOnly.json.box_files, { download: true, upload: false });
    assert.equal(ppOnly.json.practicepanther_writes, "on");

    // Box off for the whole backend: neither direction.
    setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on", BOX_MCP_ENABLED: "false" });
    const boxOff = await ops(baseUrl, "/status");
    assert.deepEqual(boxOff.json.box_files, { download: false, upload: false });
  });
});

test("callers without a valid file token are limited by address, on the same budget as the MCP route", async () => {
  setEnv({ RATE_LIMIT_AGENT_MCP_UNAUTH_MAX: "3" });
  const { app, db, box } = setup();
  const before = tokenLookups(db);

  await withApp(app, async (baseUrl) => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const answer = await files(baseUrl, i % 2 ? "/111" : "/111/content", generateAgentFileToken());
      statuses.push(answer.status);
    }
    assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
    assert.ok(statuses.slice(3).every((status) => status === 429), statuses.join(","));
    // No bearer, an MCP-shaped token, an upload, a wrong method, a missing
    // route: all count against the same budget, and so does the MCP route.
    const limited = [
      await files(baseUrl, "/111", null),
      await files(baseUrl, "/111", generateAgentToken()),
      await send(baseUrl, newFilePath("0", "x.docx"), generateAgentFileToken(), documentBytes(10)),
      await files(baseUrl, "/111", null, { method: "DELETE" }),
      await rpc(baseUrl, "box", generateAgentToken(), "tools/list"),
    ];
    for (const answer of limited) {
      assert.equal(answer.status, 429);
      assert.deepEqual(answer.json, { error: "rate_limited" });
    }
  });
  // The database was asked three times, not twelve.
  assert.equal(tokenLookups(db) - before, 3);
  assert.equal(box.calls.length, 0);
});

test("a file token has its own request budget, and a flood of bad bearers does not lock it out", async () => {
  setEnv({ RATE_LIMIT_AGENT_MCP_MAX: "3", RATE_LIMIT_AGENT_MCP_UNAUTH_MAX: "2" });
  const { app, db, box } = setup();
  const a = await enroll(db, "user-a", GARRETT);
  const b = await enroll(db, "user-b", JERAD);
  connectBox(db, box, "user-a");
  connectBox(db, box, "user-b");
  const pp = seedPerUserPracticePantherConnector(db, "user-a");
  seedOAuthToken(db, pp.id, { expiresAt: iso(30 * MINUTE) });
  box.addFile({ id: "111", name: "a.docx", bytes: documentBytes(100) });
  box.grant(boxTokenOf("user-a"), "111");
  box.grant(boxTokenOf("user-b"), "111");

  await withApp(app, async (baseUrl) => {
    assert.equal((await files(baseUrl, "/111", a.fileToken)).status, 200);
    assert.equal((await rpc(baseUrl, "practicepanther", a.token, "tools/list")).status, 200);
    assert.equal((await files(baseUrl, "/111", b.fileToken)).status, 200);
    // Strangers on the same address use up the address budget.
    for (let i = 0; i < 5; i += 1) await files(baseUrl, "/111", generateAgentFileToken());
    assert.equal((await files(baseUrl, "/111", generateAgentFileToken())).status, 429);
    // The working token still gets through, up to its own budget.
    assert.equal((await files(baseUrl, "/111/content", a.fileToken)).status, 200);
    assert.equal((await files(baseUrl, "/111", a.fileToken)).status, 200);
    const limited = await files(baseUrl, "/111", a.fileToken);
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json, { error: "rate_limited" });
    // The same user's MCP token has a budget of its own, and so has user B.
    assert.equal((await rpc(baseUrl, "practicepanther", a.token, "tools/list")).status, 200);
    assert.equal((await files(baseUrl, "/111", b.fileToken)).status, 200);
  });
});

// ---------------------------------------------------------------------------
// On the wire. The tests above hand the gateway a fake `fetch`. This one uses
// the real one against a loopback server that stands where Box stands, to
// check what is actually sent: the multipart upload, the preflight, the
// redirect and the headers.
// ---------------------------------------------------------------------------

type WireRequest = {
  method: string;
  /** The Box host the gateway addressed, then the path. */
  target: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

test("over real HTTP: the upload is multipart with the attributes first, and the Box token stays off the download host", async () => {
  const stored = documentBytes(900_000);
  const seen: WireRequest[] = [];
  let uploaded: { attributes: any; bytes: Buffer } | null = null;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const target = (req.url ?? "").slice(1);
    seen.push({ method: req.method ?? "", target, headers: req.headers, body });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const file = (bytes: Buffer, name: string) => ({
      type: "file",
      id: "111",
      name,
      size: bytes.length,
      sha1: sha1Of(bytes),
      modified_at: "2026-10-01T10:00:00-05:00",
      parent: { type: "folder", id: "0", name: "All Files" },
      path_collection: { total_count: 1, entries: [{ type: "folder", id: "0", name: "All Files" }] },
      file_version: { type: "file_version", id: "9001" },
    });
    if (req.method === "GET" && target.startsWith("api.box.com/2.0/files/111?")) {
      return json(200, file(stored, "wire.docx"));
    }
    if (req.method === "GET" && target === "api.box.com/2.0/files/111/content") {
      res.writeHead(302, { location: "https://dl.boxcloud.com/d/1/signed/download" });
      return void res.end();
    }
    if (req.method === "GET" && target === "dl.boxcloud.com/d/1/signed/download") {
      res.writeHead(200, { "content-length": String(stored.length) });
      return void res.end(stored);
    }
    if (req.method === "OPTIONS" && target === "api.box.com/2.0/files/content") {
      return json(200, { upload_url: "https://upload.box.com/ignored" });
    }
    if (req.method === "POST" && target.startsWith("upload.box.com/api/2.0/files/content?")) {
      // Read the multipart body the way any server would.
      const form = await new Response(body, {
        headers: { "content-type": String(req.headers["content-type"]) },
      }).formData();
      const bytes = Buffer.from(await (form.get("file") as Blob).arrayBuffer());
      uploaded = { attributes: JSON.parse(String(form.get("attributes"))), bytes };
      return json(201, { total_count: 1, entries: [file(bytes, uploaded.attributes.name)] });
    }
    json(404, { type: "error" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const db = createFakeDb();
  setEnv({ DOCKET_AGENT_BOX_UPLOADS: "on" });
  const { fileToken } = await enroll(db, "user-1", GARRETT);
  const connector = seedManagedBoxConnector(db, "user-1");
  seedOAuthToken(db, connector.id, { expiresAt: iso(30 * MINUTE) });
  const router = createAgentMcpRouter({
    db: () => db.asDb(),
    now: () => NOW,
    withRefreshLock: createMemoryRefreshLock(),
    boxAccessToken: async (row: ConnectorRow) => boxTokenOf(row.user_id),
    // The real fetch. Only the address is changed: the Box host becomes the
    // first part of a loopback path, so the server can tell which was meant.
    boxFetch: (input, init) =>
      fetch(String(input).replace(/^https:\/\//, `http://127.0.0.1:${port}/`), init),
  });
  const app = express();
  app.use("/agent-mcp", router);
  const upload = documentBytes(1 * MB + 77);
  const name = `${NAME_CANARY} wire – ü.docx`;

  try {
    await withApp(app, async (baseUrl) => {
      const down = await files(baseUrl, "/111/content", fileToken);
      assert.equal(down.status, 200);
      assert.ok(down.bytes.equals(stored));
      assert.equal(down.headers.get("x-docket-file-sha1"), sha1Of(stored));

      const up = await send(baseUrl, newFilePath("0", name), fileToken, upload);
      assert.equal(up.status, 201);
      assert.deepEqual(up.json, {
        id: "111",
        name,
        size: upload.length,
        sha1: sha1Of(upload),
        parent: { id: "0", name: "All Files" },
      });
    });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }

  assert.deepEqual(
    seen.map((item) => [item.method, item.target.split("?")[0]]),
    [
      ["GET", "api.box.com/2.0/files/111"],
      ["GET", "api.box.com/2.0/files/111/content"],
      ["GET", "dl.boxcloud.com/d/1/signed/download"],
      ["OPTIONS", "api.box.com/2.0/files/content"],
      ["POST", "upload.box.com/api/2.0/files/content"],
    ],
  );
  const [details, content, signed, preflight, post] = seen;
  // The user's Box token is on the API and upload requests, and on nothing
  // sent to the download host. Nothing of the caller's request is passed on.
  for (const item of [details, content, preflight, post]) {
    assert.equal(item.headers.authorization, `Bearer ${boxTokenOf("user-1")}`);
  }
  assert.equal(signed.headers.authorization, undefined);
  for (const item of seen) {
    assert.ok(!JSON.stringify(item.headers).includes(fileToken));
    assert.equal(item.headers["x-docket-content-sha1"], undefined);
    assert.equal(item.headers.cookie, undefined);
  }
  // The bytes are asked for as stored, not compressed.
  assert.equal(content.headers["accept-encoding"], "identity");
  assert.equal(signed.headers["accept-encoding"], "identity");

  // The preflight: a JSON body with the name, the size and the folder.
  assert.match(String(preflight.headers["content-type"]), /^application\/json/);
  assert.deepEqual(JSON.parse(preflight.body.toString("utf8")), {
    name,
    size: upload.length,
    parent: { id: "0" },
  });

  // The upload: multipart form data, the attributes part before the file
  // part, the sha1 for Box to check, and exactly the bytes.
  assert.match(String(post.headers["content-type"]), /^multipart\/form-data; boundary=/);
  assert.equal(post.headers["content-md5"], sha1Of(upload));
  const raw = post.body.toString("latin1");
  const attributesAt = raw.indexOf('name="attributes"');
  const fileAt = raw.indexOf('name="file"');
  assert.ok(attributesAt !== -1 && fileAt !== -1 && attributesAt < fileAt);
  assert.ok(uploaded, "the upload reached the server");
  assert.deepEqual(uploaded!.attributes, { name, parent: { id: "0" } });
  assert.ok(uploaded!.bytes.equals(upload));
  // The file name is in the attributes only, not in the file part's header.
  assert.ok(raw.slice(fileAt, fileAt + 200).includes('filename="file"'));
});

after(() => {
  Object.assign(console, originalConsole);
});

test("no log line, response body, header or audit row holds a token, a Box secret or file content", () => {
  assert.ok(mintedTokens.length > 20);
  assert.ok(responseBodies.length > 200);
  assert.ok(auditSnapshots.length > 10);
  assert.ok(capturedLogs.length > 0);
  const boxTokens = ["user-1", "user-2", "user-a", "user-b", "user-c"].map(boxTokenOf);
  const secrets = [
    ...mintedTokens,
    ...boxTokens,
    "box-access-secret",
    TEST_OPS_TOKEN,
    TEST_STATUS_TOKEN,
    FAKE_UPSTREAM_ACCESS_TOKEN,
    "refresh-secret",
    BOX_ERROR_BODY_CANARY,
    BOX_SIGNED_URL_CANARY,
    CONTENT_CANARY,
  ];
  for (const secret of secrets) {
    for (const line of capturedLogs) {
      assert.ok(!line.includes(secret), "a secret reached the logs");
    }
    for (const body of responseBodies) {
      assert.ok(!body.includes(secret), "a secret reached a response body");
    }
    for (const headers of responseHeaders) {
      assert.ok(!headers.includes(secret), "a secret reached a response header");
    }
    for (const rows of auditSnapshots) {
      assert.ok(!rows.includes(secret), "a secret reached an audit row");
    }
  }
  // File names stay out of the logs and the audit rows. (They are in the
  // answers that are meant to carry them.)
  for (const line of capturedLogs) assert.ok(!line.includes("name-canary"));
  for (const rows of auditSnapshots) assert.ok(!rows.includes("name-canary"));
  // Nothing fell through the gateway to the rest of the app.
  for (const body of responseBodies) assert.ok(!body.includes("fell_through"));
  // The rate limiters raised no complaint about how they are wired.
  for (const line of capturedLogs) assert.ok(!/ERR_ERL|ValidationError/.test(line), line.slice(0, 200));
});
