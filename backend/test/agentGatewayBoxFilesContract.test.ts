// Source-text and schema checks for the Docket Agent Box file routes, in the
// same style as agentGatewayContract.test.ts. They pin what must not drift:
// the two Box hosts, the handful of Box calls, the four routes, the token
// scope checks and the settings.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const backendRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(backendRoot, "..");

function source(path: string) {
  return readFileSync(resolve(backendRoot, path), "utf8");
}

function section(text: string, start: string, end: string) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

/** Collapses whitespace so SQL can be compared across files. */
function squash(text: string) {
  return text.replace(/\s+/g, " ");
}

test("the migration and both fresh schemas hold the Box file token column", () => {
  const files = {
    migration: squash(source("migrations/20261001_docket_agent_gateway.sql")),
    schema: squash(source("schema.sql")),
    azure: squash(source("migrations/azure_postgres_schema.sql")),
  };
  for (const [name, sql] of Object.entries(files)) {
    const table = section(sql, "create table if not exists public.docket_agent_tokens (", ");");
    // Its own unique column on the same row as the agent token's hash.
    assert.match(table, /token_hash text not null unique,.* file_token_hash text unique, created_at/, name);
    // Still one live row per user: one revocation ends both tokens.
    assert.match(
      sql,
      /create unique index if not exists idx_docket_agent_tokens_one_active on public\.docket_agent_tokens\(user_id\) where revoked_at is null;/,
      name,
    );
    // Hashes only. No column holds a token.
    assert.doesNotMatch(table, /\b(file_)?token text\b/, name);
  }
  // A database that ran an earlier copy of the migration gets the column too.
  assert.match(
    files.migration,
    /alter table public\.docket_agent_tokens add column if not exists file_token_hash text unique;/,
  );
  assert.match(files.migration, /begin;[\s\S]*commit;\s*$/);
});

test("a token is only ever compared with the hash column of its own scope", () => {
  const tokens = source("src/lib/agentGateway/tokens.ts");
  assert.match(tokens, /const AGENT_FILE_TOKEN_SHAPE = \/\^dkf_\[A-Za-z0-9_-\]\{43\}\$\/;/);
  assert.match(
    tokens,
    /const TOKEN_HASH_COLUMNS: Record<AgentTokenScope, string> = \{\s*mcp: "token_hash",\s*box_files: "file_token_hash",\s*\};/,
  );
  const authenticate = section(tokens, "export async function authenticateAgentToken(", "\n}\n");
  assert.match(authenticate, /scope: AgentTokenScope = "mcp",/);
  // The shape decides the scope before any lookup.
  assert.match(authenticate, /if \(agentTokenScopeOf\(bearer\) !== scope\) return null;/);
  assert.ok(
    authenticate.indexOf("agentTokenScopeOf(bearer) !== scope") <
      authenticate.indexOf('.from("docket_agent_tokens")'),
  );
  assert.match(authenticate, /\.eq\(TOKEN_HASH_COLUMNS\[scope\], hashAgentToken\(bearer\)\)/);
  assert.match(authenticate, /\.is\("revoked_at", null\)/);
  assert.match(authenticate, /if \(!isAgentEmailAllowed\(email\)\) return null;/);

  // Both hashes go into one row; neither token does.
  const mint = section(tokens, "export async function mintAgentToken(", "\n}\n");
  assert.match(
    mint,
    /\.insert\(\{\s*user_id: userId,\s*token_hash: hashAgentToken\(token\),\s*file_token_hash: hashAgentToken\(fileToken\),\s*\}\)/,
  );
  assert.ok(mint.indexOf("revokeAgentTokens(userId, db)") < mint.indexOf(".insert("));
  // Revocation is by row, so it cannot end one token and leave the other.
  const revoke = section(tokens, "export async function revokeAgentTokens(", "\n}\n");
  assert.doesNotMatch(revoke, /token_hash/);

  // A stray file token is redacted like an agent token.
  assert.match(source("src/lib/safeError.ts"), /\/\\bdkf_\[A-Za-z0-9_-\]\{20,\}\\b\/g,/);
});

test("the router sends each token kind to its own routes and nowhere else", () => {
  const router = source("src/routes/agentMcp.ts");

  const mcp = section(router, "const requireAgentToken: RequestHandler", "\n  };\n");
  assert.match(
    mcp,
    /if \(bearer && agentTokenScopeOf\(bearer\) === "box_files"\) \{\s*return void rejectWrongTokenScope\(res\);/,
  );
  assert.match(mcp, /authenticateAgentToken\(bearer, deps\.db\(\)\)/);

  const filesGate = section(router, "const requireFileToken: RequestHandler", "\n  };\n");
  assert.match(
    filesGate,
    /if \(bearer && agentTokenScopeOf\(bearer\) === "mcp"\) \{\s*return void rejectWrongTokenScope\(res\);/,
  );
  assert.match(filesGate, /authenticateAgentToken\(bearer, deps\.db\(\), "box_files"\)/);
  // The file scope is asked for in exactly one place.
  assert.equal(router.split('deps.db(), "box_files")').length - 1, 1);
  assert.equal(router.split("requireFileToken").length - 1, 2);

  const opsGate = section(router, "const requireOpsToken: RequestHandler", "ops.use(requireOpsToken);");
  assert.match(
    opsGate,
    /if \(bearer && agentTokenScopeOf\(bearer\) === "box_files"\) \{\s*return void rejectWrongTokenScope\(res\);/,
  );
  assert.ok(opsGate.indexOf("rejectWrongTokenScope") < opsGate.indexOf("opsTokenMatches(bearer)"));

  const wrongScope = section(router, "function rejectWrongTokenScope(", "\n}\n");
  assert.match(wrongScope, /\.status\(403\)/);
  assert.match(wrongScope, /\.json\(\{ error: "wrong_token_scope" \}\)/);

  // The mount: the per-address limit first, then the file router with the
  // file token check and the per-token limit. After the gate, before the 404.
  assert.match(
    router,
    /router\.use\(\s*"\/box\/files",\s*unauthLimiter,\s*createAgentBoxFilesRouter\(\{\s*deps,\s*requireFileToken,\s*tokenLimiter: fileTokenLimiter,\s*rejectSourceNotConnected,\s*\}\),\s*\);/,
  );
  const mount = router.indexOf('"/box/files",');
  assert.ok(router.indexOf("agentGatewayEnabled()") < mount);
  assert.ok(mount < router.indexOf('res.status(404).json({ error: "not_found" })'));
  const perToken = section(router, "const fileTokenLimiter = rateLimit({", "});");
  assert.match(perToken, /`files:\$\{\(res\.locals\.agentPrincipal as AgentPrincipal\)\.tokenId\}`/);
  assert.match(perToken, /limit: \(\) => agentMcpRateLimitMax\(\)/);
  assert.doesNotMatch(perToken, /authorization|createHash|req\.ip/);

  // Minting returns the pair; the ops log names neither.
  assert.match(router, /token: minted\.token,\s*file_token: minted\.fileToken,\s*email: user\.email,/);
  const log = section(router, "function logOpsAction(", "\n  }\n");
  assert.doesNotMatch(log, /token/i);
});

test("the Box file router has four routes, each behind the method check, the file token and the limit", () => {
  const router = source("src/routes/agentBoxFiles.ts");
  assert.doesNotMatch(router, /requireAuth|requireAdmin|middleware\/auth/);
  assert.match(router, /createAsyncRouter\(\)/);

  const guard = section(router, "const guard = (", "];");
  assert.match(guard, /onlyMethod\(method\),\s*requireFileToken,\s*tokenLimiter,/);
  const routes = [...router.matchAll(/router\.(\w+)\(\s*("[^"]*")\s*,([^;]*);/g)].map((match) => [
    match[1],
    match[2],
    match[3].replace(/\s+/g, " ").trim(),
  ]);
  assert.deepEqual(routes, [
    ["all", '"/"', '...guard("POST"), uploadNewFile)'],
    ["all", '"/:fileId"', '...guard("GET"), metadata)'],
    ["all", '"/:fileId/content"', '...guard("GET"), download)'],
    ["all", '"/:fileId/versions"', '...guard("POST"), uploadNewVersion)'],
  ]);
  // No other way onto the router.
  assert.equal(router.split("router.").length - 1, 4);
  assert.doesNotMatch(router, /"(DELETE|PUT|PATCH)"/);

  // Uploads: the switch first; a body that says it is too large is refused
  // before a place is taken; then the place and the upload budget; then the
  // sha1 of what arrived, then the pending audit row, and only then Box.
  // A new version is sent only after the look at the file as it is, the
  // same-bytes check and the count of the day's versions.
  const upload = section(router, "async function upload(", "\n  }\n\n");
  const order = [
    "normalizeSha1(req.headers[SHA1_HEADER])",
    "declaredLength(req) > maxBytes",
    "uploadsInFlight.take(principal.tokenId)",
    "uploadBudget.take(",
    "openUserBox(res, action)",
    "readRawBody(req, maxBytes, deps.boxUploadTimeouts.bodyMs)",
    'createHash("sha1").update(body).digest("hex")',
    "sha1 !== claimedSha1",
    "beginUploadAudit(call, refs, body.length)",
    "preflightBoxNewFile(deps.boxFetch",
    "getBoxFile(deps.boxFetch",
    "current.sha1 === sha1 && current.size === body.length",
    "recentNewVersions(call, target.fileId, auditId, maxPerDay)",
    "recent >= maxPerDay",
    "ifMatch = current.etag",
    "uploadToBox(deps.boxFetch",
  ].map((marker) => {
    const index = upload.indexOf(marker);
    assert.notEqual(index, -1, marker);
    return index;
  });
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(upload, /if \(!auditId\) \{[\s\S]*?return void res\.status\(503\)\.json\(\{ error: "audit_unavailable" \}\);/);
  for (const handler of ["uploadNewFile", "uploadNewVersion"]) {
    const body = section(router, `const ${handler}: RequestHandler`, "\n  };\n");
    assert.ok(body.indexOf("await uploadsOff(") !== -1, handler);
    assert.ok(body.indexOf("await uploadsOff(") < body.indexOf("await upload("), handler);
  }
  const off = section(router, "async function uploadsOff(", "\n  }\n");
  assert.match(off, /if \(agentBoxUploadsEnabled\(\)\) return false;/);
  assert.match(off, /res\.status\(403\)\.json\(\{ error: "box_uploads_off" \}\);/);

  // The user's own Box row and the locked refresh, as on the MCP route.
  const open = section(router, "async function openUserBox(", "\n  }\n");
  assert.match(open, /ownBoxConnector\(principal, db\)/);
  assert.match(open, /refresh: "if_near_expiry", skewMs: REQUEST_REFRESH_SKEW_MS/);
  assert.match(open, /deps\.boxAccessToken\(connector, db\)/);
  const own = section(router, "async function ownBoxConnector(", "\n  }\n");
  assert.match(own, /resolveAgentConnector\(principal\.userId, "box", db\)/);
  assert.match(own, /resolved\.connector\.user_id === principal\.userId/);

  // The audit rows carry the marker and never a name.
  const row = section(router, "function auditRow(", "\n  }\n");
  assert.match(row, /origin: "docket_agent",/);
  assert.match(row, /actor_email: call\.principal\.email,/);
  assert.match(row, /agent_token_id: call\.principal\.tokenId,/);
  assert.match(row, /tool_name: call\.action,/);
  assert.doesNotMatch(row, /name:(?! call\.action)/);
  assert.doesNotMatch(router, /console\.\w+\([^)]*\bname\b/);
});

test("uploads are kept few: places, a deadline for the body, a budget, and a limit per file", () => {
  const router = source("src/routes/agentBoxFiles.ts");
  const box = source("src/lib/agentGateway/boxFiles.ts");

  // A few places in all, and fewer for one token, so one token cannot hold
  // them all.
  const inAll = Number(/const MAX_UPLOADS_IN_FLIGHT = (\d+);/.exec(router)?.[1]);
  const perToken = Number(/const MAX_UPLOADS_IN_FLIGHT_PER_TOKEN = (\d+);/.exec(router)?.[1]);
  assert.equal(inAll, 4);
  assert.equal(perToken, 2);
  assert.ok(perToken < inAll);
  assert.match(
    router,
    /const uploadsInFlight = createInFlight\(\s*MAX_UPLOADS_IN_FLIGHT,\s*MAX_UPLOADS_IN_FLIGHT_PER_TOKEN,\s*\);/,
  );
  const places = section(router, "function createInFlight(", "\n}\n");
  assert.match(places, /if \(inAll >= maxInAll \|\| mine >= maxPerToken\) return null;/);
  // The place is keyed by the token's own row and always given back.
  const upload = section(router, "async function upload(", "\n  }\n\n");
  assert.match(upload, /const release = uploadsInFlight\.take\(principal\.tokenId\);/);
  assert.match(upload, /\} finally \{\s*release\(\);\s*\}\s*$/);
  // Downloads: so many per token.
  assert.match(router, /const MAX_DOWNLOADS_IN_FLIGHT_PER_TOKEN = 16;/);
  const download = section(router, "const download: RequestHandler", "\n  };\n");
  assert.match(download, /const release = downloadsInFlight\.take\(principal\.tokenId\);/);
  assert.match(download, /try \{\s*await sendFile\(res, fileId, wantedVersion\);\s*\} finally \{\s*release\(\);\s*\}/);

  // The body is read by the gateway's own reader, which stops at the limit
  // and at the deadline. Not by a parser that reads a refused body to its end.
  assert.doesNotMatch(router, /express\.raw|body-parser|bodyParser/);
  const reader = section(router, "function readRawBody(", "\n}\n");
  assert.match(reader, /if \(received > maxBytes\) return finish\("too_large"\);/);
  assert.match(reader, /const deadline = setTimeout\(\(\) => finish\("timed_out"\), timeoutMs\);/);
  assert.match(reader, /if \(encoding !== "identity"\) return resolve\("unreadable"\);/);
  assert.match(upload, /if \(body === "timed_out"\) \{[\s\S]*?\.status\(408\)\s*\.set\("Connection", "close"\)\s*\.json\(\{ error: "upload_timeout" \}\);/);
  // Every answer of the two upload routes cuts a body that keeps coming.
  for (const handler of ["uploadNewFile", "uploadNewVersion"]) {
    const body = section(router, `const ${handler}: RequestHandler`, "\n  };\n");
    const cut = body.indexOf("cutUnreadBody(req, res, deps.boxUploadTimeouts.unreadBodyGraceMs);");
    assert.notEqual(cut, -1, handler);
    assert.ok(cut < body.indexOf("await uploadsOff("), handler);
  }
  // The waits as deployed: two minutes for a body, thirty seconds of grace.
  const gateway = source("src/routes/agentMcp.ts");
  assert.match(gateway, /const BOX_UPLOAD_BODY_TIMEOUT_MS = 2 \* 60 \* 1000;/);
  assert.match(gateway, /const BOX_UNREAD_BODY_GRACE_MS = 30 \* 1000;/);
  assert.match(
    gateway,
    /boxUploadTimeouts: \{\s*bodyMs: BOX_UPLOAD_BODY_TIMEOUT_MS,\s*unreadBodyGraceMs: BOX_UNREAD_BODY_GRACE_MS,\s*\},/,
  );

  // The upload budget: its own count per token, far below the one for reading.
  assert.match(
    upload,
    /uploadBudget\.take\(\s*principal\.tokenId,\s*agentBoxMaxUploadsPerWindow\(\),\s*agentMcpRateLimitWindowMs\(\),\s*\)/,
  );
  assert.match(upload, /\.status\(429\)\s*\.set\("Retry-After", String\(budget\.wait\)\)\s*\.json\(\{ error: "upload_rate_limited" \}\);/);
  assert.match(box, /const DEFAULT_MAX_UPLOADS_PER_WINDOW = 30;/);
  assert.match(box, /const DEFAULT_MAX_VERSIONS_PER_DAY = 10;/);

  // New versions of one file per day, counted from the audit rows of the
  // token's own user, uploads with an unknown outcome included.
  const count = section(router, "async function recentNewVersions(", "\n  }\n");
  assert.match(count, /\.eq\("user_id", call\.principal\.userId\)/);
  assert.match(count, /\.eq\("tool_name", "box_file_new_version"\)/);
  assert.match(count, /\.eq\("action_kind", "mutation"\)/);
  assert.match(count, /\.contains\("target_refs", \{ file_id: fileId \}\)/);
  assert.match(count, /\.gt\("created_at", since\)/);
  assert.match(count, /\.in\("error_message", MAYBE_STORED_ERRORS\)/);
  assert.match(upload, /if \(recent === null\) \{\s*return void \(await stop\(503, \{ error: "audit_unavailable" \}\)\);/);

  // A new version is tied to the file as it was read: If-Match, and Box's
  // 412 is a conflict, not a success.
  const send = section(box, "export async function uploadToBox(", "\n}\n");
  assert.match(send, /\.\.\.\(input\.kind === "new_version" && input\.ifMatch\s*\? \{ "If-Match": input\.ifMatch \}\s*: \{\}\),/);
  const failure = section(box, "async function failureFor(", "\n}\n");
  assert.match(failure, /if \(status === 412\) return \{ ok: false, status: 409, error: "box_file_changed" \};/);
  assert.match(upload, /if \(!current\.etag\) return void \(await stop\(502, \{ error: "box_error" \}\)\);/);
});

test("Box is only ever called on its two fixed hosts, with a handful of calls", () => {
  const box = source("src/lib/agentGateway/boxFiles.ts");
  const router = source("src/routes/agentBoxFiles.ts");

  // Every address in the file is one of the two hosts.
  const hosts = new Set([...box.matchAll(/https:\/\/([A-Za-z0-9.-]+)/g)].map((match) => match[1]));
  assert.deepEqual([...hosts].sort(), ["api.box.com", "upload.box.com"]);
  assert.match(box, /const BOX_API_ORIGIN = "https:\/\/api\.box\.com";/);
  assert.match(box, /const BOX_UPLOAD_ORIGIN = "https:\/\/upload\.box\.com";/);
  assert.doesNotMatch(router, /https?:\/\//);
  // The gateway makes no Box request of its own outside that file.
  assert.doesNotMatch(router, /\bfetch\(|fetchImpl\(|boxFetch\(/);
  assert.equal(router.split("deps.boxFetch").length - 1, 7);

  // Every request is built from a fixed origin, or is the checked redirect.
  const requests = [...box.matchAll(/fetchImpl\(\s*([^,]+),/g)].map((match) =>
    match[1].replace(/\s+/g, " ").trim(),
  );
  assert.deepEqual(requests, [
    "`${BOX_API_ORIGIN}${path}`",
    "`${BOX_API_ORIGIN}/2.0/files/${fileId}/content${ versionId ? `?version=${versionId}` : \"\" }`",
    "next",
    "`${BOX_API_ORIGIN}/2.0/files/content`",
    "`${BOX_UPLOAD_ORIGIN}${path}?fields=${UPLOAD_FIELDS}`",
  ]);
  // Never a redirect followed by fetch itself.
  assert.equal(box.split('redirect: "manual"').length - 1, requests.length);
  assert.doesNotMatch(box, /redirect: "(follow|error)"/);
  // The methods: read, ask, add. Nothing that deletes or replaces.
  const methods = [...box.matchAll(/method: "([A-Z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(methods, ["GET", "GET", "GET", "OPTIONS", "POST"]);
  assert.doesNotMatch(box, /"(DELETE|PUT|PATCH)"/);
  // The only paths: file details, a version's details, content, and the two uploads.
  assert.doesNotMatch(box, /shared_link|collaborations|\/metadata|\/copy|\/trash|\/folders/);

  // The redirect hop: checked by Docket chat's own rule, and sent with no
  // Authorization header.
  const download = section(box, "export async function openBoxDownload(", "\n}\n");
  assert.match(download, /next = boxDownloadUrl\(location\);/);
  const hop = section(download, "response = await fetchImpl(next, {", "});");
  assert.match(hop, /headers: plain,/);
  assert.doesNotMatch(hop, /authorization/i);
  assert.equal(download.split("authorization(accessToken)").length - 1, 1);
  assert.match(box, /import \{ downloadUrl as boxDownloadUrl \} from "\.\.\/mcp\/boxFileContent";/);
  const rule = section(source("src/lib/mcp/boxFileContent.ts"), "export function downloadUrl(", "\n}\n");
  assert.match(rule, /url\.protocol !== "https:" \|\|\s*!url\.hostname\.endsWith\("\.boxcloud\.com"\) \|\|\s*url\.username \|\|\s*url\.password \|\|\s*\(url\.port && url\.port !== "443"\)/);

  // A new version sends no name and no folder: nothing is renamed or moved.
  const upload = section(box, "export async function uploadToBox(", "\n}\n");
  assert.match(
    upload,
    /input\.kind === "new_file"\s*\? \{ name: input\.name, parent: \{ id: input\.parentId \} \}\s*: \{\},/,
  );
  assert.match(upload, /"Content-MD5": input\.sha1,/);
  // Box's own words never leave the file: failures are fixed strings.
  const failure = section(box, "async function failureFor(", "\n}\n");
  assert.match(failure, /if \(status === 403\) return \{ ok: false, status: 403, error: "box_forbidden" \};/);
  assert.match(failure, /if \(status === 404\) return \{ ok: false, status: 404, error: "box_not_found" \};/);
  assert.match(failure, /await discard\(response\);/);

  // The stored sign-in is read, never refreshed here.
  const read = section(box, "export async function defaultBoxAccessToken(", "\n}\n");
  assert.match(read, /await provider\.tokens\(\)/);
  assert.doesNotMatch(box, /oauthBearerToken|runMcpOAuth|refresh_token/);
});

test(".env.example and the README name the Box file settings, and the code reads no others", () => {
  const envExample = source(".env.example");
  const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
  const names = [
    "DOCKET_AGENT_BOX_UPLOADS",
    "DOCKET_AGENT_BOX_MAX_DOWNLOAD_MB",
    "DOCKET_AGENT_BOX_MAX_UPLOAD_MB",
    "DOCKET_AGENT_BOX_MAX_UPLOADS_PER_WINDOW",
    "DOCKET_AGENT_BOX_MAX_VERSIONS_PER_DAY",
  ];
  for (const name of names) {
    assert.match(envExample, new RegExp(`^# ${name}=`, "m"), name);
    assert.ok(readme.includes(name), `README.md names ${name}`);
  }
  // The defaults as documented: uploads off, 200 MB down, 50 MB up.
  assert.match(envExample, /^# DOCKET_AGENT_BOX_UPLOADS=off$/m);
  assert.match(envExample, /^# DOCKET_AGENT_BOX_MAX_DOWNLOAD_MB=200$/m);
  assert.match(envExample, /^# DOCKET_AGENT_BOX_MAX_UPLOAD_MB=50$/m);
  // 30 uploads per window per token, 10 new versions of one file per day.
  assert.match(envExample, /^# DOCKET_AGENT_BOX_MAX_UPLOADS_PER_WINDOW=30$/m);
  assert.match(envExample, /^# DOCKET_AGENT_BOX_MAX_VERSIONS_PER_DAY=10$/m);

  const box = source("src/lib/agentGateway/boxFiles.ts");
  const read = new Set<string>();
  for (const match of box.matchAll(/(?:process\.env\.|envInt\(")([A-Z_]+)/g)) read.add(match[1]);
  assert.deepEqual([...read].sort(), [...names].sort());
  assert.doesNotMatch(source("src/routes/agentBoxFiles.ts"), /process\.env/);
  assert.match(box, /const DEFAULT_MAX_DOWNLOAD_MB = 200;/);
  assert.match(box, /const DEFAULT_MAX_UPLOAD_MB = 50;/);
  const uploads = section(box, "export function agentBoxUploadsEnabled()", "\n}\n");
  assert.match(uploads, /=== "on"/);

  // The status answer carries the switch.
  const status = source("src/lib/agentGateway/status.ts");
  assert.match(status, /box_files: \{ download: boolean; upload: boolean \};/);
  assert.match(status, /box_files: agentBoxFilesStatus\(\),/);
});
