// Source-text and schema checks for the Docket Agent gateway, in the same
// style as practicePantherAccessRoutes.test.ts. They pin the few places
// where the gateway touches existing files.

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

test("the migration and both fresh schemas hold the same gateway objects", () => {
  const files = {
    migration: squash(source("migrations/20261001_docket_agent_gateway.sql")),
    schema: squash(source("schema.sql")),
    azure: squash(source("migrations/azure_postgres_schema.sql")),
  };

  for (const [name, sql] of Object.entries(files)) {
    assert.match(sql, /create table if not exists public\.docket_agent_tokens \(/, name);
    assert.match(sql, /token_hash text not null unique/, name);
    assert.match(
      sql,
      /user_id text not null references public\.app_users\(id\) on delete cascade, token_hash/,
      name,
    );
    assert.match(sql, /revoked_at timestamptz, last_used_at timestamptz/, name);
    assert.match(
      sql,
      /create unique index if not exists idx_docket_agent_tokens_one_active on public\.docket_agent_tokens\(user_id\) where revoked_at is null;/,
      name,
    );
    assert.match(
      sql,
      /create unique index if not exists idx_user_mcp_connectors_docket_agent_source on public\.user_mcp_connectors \(user_id, \(tool_policy->>'docketAgentSource'\)\) where \(tool_policy->>'docketAgentSource'\) is not null;/,
      name,
    );
    assert.match(
      sql,
      /create index if not exists idx_user_mcp_tool_audit_logs_agent_created on public\.user_mcp_tool_audit_logs\(user_id, created_at desc\) where origin = 'docket_agent';/,
      name,
    );
    assert.match(sql, /origin text not null default 'docket'/, name);
    assert.match(sql, /check \(origin in \('docket', 'docket_agent'\)\)/, name);
    assert.match(sql, /agent_token_id uuid/, name);
    // No JSON column is added to the audit table (the adapter line is pinned).
    assert.doesNotMatch(sql, /agent_token_id jsonb|origin jsonb/, name);
  }

  // The migration adds to the existing table; it is safe to run twice.
  assert.match(files.migration, /add column if not exists origin text not null default 'docket'/);
  assert.match(files.migration, /add column if not exists agent_token_id uuid/);
  assert.match(files.migration, /^-- Docket Agent gateway\./);
  assert.match(files.migration, /begin;[\s\S]*commit;\s*$/);
  // The check is added the way Docket's own migrations add one: once, and a
  // second run finds it there.
  assert.match(
    files.migration,
    /do \$\$ begin alter table public\.user_mcp_tool_audit_logs add constraint user_mcp_tool_audit_logs_origin_check check \(origin in \('docket', 'docket_agent'\)\); exception when duplicate_object then null; end \$\$;/,
  );

  // It only adds. It runs against the live database while Docket is serving,
  // so: nothing is dropped, renamed, deleted, updated or rewritten, every
  // statement is safe to repeat, and it gives up instead of making Docket's
  // own requests wait for a lock.
  const statements = source("migrations/20261001_docket_agent_gateway.sql")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(statements, /^\s*(drop|truncate|delete|update|insert|rename)\b/im);
  assert.doesNotMatch(
    statements,
    /\bdrop\s|\brename\s|\btruncate\s|alter column|set not null|\busing\s|\bdelete from\b/i,
  );
  assert.match(statements, /begin;\s*set local lock_timeout = '5s';/);
  for (const create of statements.matchAll(/\bcreate\s+(unique\s+)?(table|index)\b[^\n]*/gi)) {
    assert.match(create[0], /if not exists/i, create[0]);
  }
  for (const add of statements.matchAll(/\badd column\b[^\n]*/gi)) {
    assert.match(add[0], /add column if not exists/i, add[0]);
  }
  // No "?" anywhere: some database tools read it as a value to fill in.
  assert.doesNotMatch(statements, /\?/);
  // Only objects of the gateway's own, on two existing tables.
  const touched = [...statements.matchAll(/\bpublic\.([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(touched)].sort(), [
    "app_users", // referenced by the new table only
    "docket_agent_tokens",
    "user_mcp_connectors",
    "user_mcp_tool_audit_logs",
  ]);

  // In the fresh schemas the new columns sit inside the audit table itself.
  for (const name of ["schema.sql", "migrations/azure_postgres_schema.sql"]) {
    const auditTable = section(
      source(name),
      "create table if not exists public.user_mcp_tool_audit_logs (",
      ");",
    );
    assert.match(auditTable, /origin text not null default 'docket'/, name);
    assert.match(auditTable, /agent_token_id uuid/, name);
    assert.match(auditTable, /target_refs jsonb/, name);
  }
  assert.match(
    source("src/lib/supabase.ts"),
    /user_mcp_tool_audit_logs: new Set\(\["target_refs"\]\)/,
  );
});

test("index.ts mounts /agent-mcp before CORS, the general limiter and the 50mb parser", () => {
  const index = source("src/index.ts");
  const mount = index.indexOf('app.use("/agent-mcp", agentMcpRouter);');
  assert.notEqual(mount, -1);
  assert.equal(index.split('"/agent-mcp"').length, 2, "mounted exactly once");

  for (const later of [
    "cors({",
    "app.use(generalLimiter);",
    'app.use(express.json({ limit: "50mb" }));',
    'app.use("/chat", chatRouter);',
    "app.use(apiErrorHandler);",
  ]) {
    const position = index.indexOf(later);
    assert.notEqual(position, -1, later);
    assert.ok(mount < position, `/agent-mcp must be mounted before ${later}`);
  }
  // After helmet, so the security headers still apply.
  assert.ok(index.indexOf("helmet({") < mount);
  assert.match(index, /import \{ agentMcpRouter \} from "\.\/routes\/agentMcp";/);
});

test("the gateway router has its own credentials and never the browser sign-in", () => {
  const router = source("src/routes/agentMcp.ts");
  assert.doesNotMatch(router, /requireAuth/);
  assert.doesNotMatch(router, /requireAdmin/);
  assert.doesNotMatch(router, /middleware\/auth/);
  assert.match(router, /createAsyncRouter\(\)/);
  assert.match(router, /opsTokenMatches\(bearer\)/);
  assert.match(router, /authenticateAgentToken\(bearer, deps\.db\(\)\)/);
  assert.match(router, /sessionIdGenerator: undefined/);
  assert.match(router, /enableJsonResponse: true/);
  assert.match(router, /export function createAgentMcpRouter\(/);
  assert.match(router, /export const agentMcpRouter = createAgentMcpRouter\(\);/);
  // The gate runs before anything else is registered on the router.
  const gate = router.indexOf("agentGatewayEnabled()");
  assert.ok(gate !== -1 && gate < router.indexOf('router.use("/ops"'));
  // The order on the MCP route: the per-address limit for callers without
  // a valid token, the route check, the token, the per-token limit, the work.
  assert.match(
    router,
    /router\.all\(\s*"\/:source",\s*unauthLimiter,\s*checkRoute,\s*requireAgentToken,\s*tokenLimiter,\s*serveSource,\s*\);/,
  );
  // The body is parsed after the token and the connector were checked.
  const handler = section(router, "const serveSource: RequestHandler", "router.all(");
  assert.doesNotMatch(handler, /authenticateAgentToken\(/);
  assert.ok(handler.indexOf("ensureUpstreamSignIn(") < handler.indexOf("mcpJson(req, res"));
  assert.ok(handler.indexOf("ensureUpstreamSignIn(") !== -1);
});

test("the MCP rate limits are keyed by address before the token and by token id after", () => {
  const router = source("src/routes/agentMcp.ts");
  const unauth = section(router, "const unauthLimiter = rateLimit({", "});");
  assert.match(unauth, /keyGenerator: \(req\) => ipKeyGenerator\(req\.ip \?\? ""\)/);
  assert.match(unauth, /limit: \(\) => agentMcpUnauthRateLimitMax\(\)/);
  // Only a request that ends without a valid token counts.
  assert.match(unauth, /skipSuccessfulRequests: true/);
  assert.match(unauth, /res\.locals\.agentPrincipal !== undefined/);
  const perToken = section(router, "const tokenLimiter = rateLimit({", "});");
  assert.match(perToken, /tokenId/);
  assert.doesNotMatch(perToken, /authorization|createHash|req\.ip/);
  // The header text is never a rate-limit key.
  assert.doesNotMatch(router, /update\(header\)/);
  assert.doesNotMatch(router, /import crypto/);
});

test("the status token opens the status route and nothing else", () => {
  const router = source("src/routes/agentMcp.ts");
  const gate = section(router, "const requireOpsToken: RequestHandler", "ops.use(requireOpsToken);");
  assert.match(gate, /const statusOnly = req\.method === "GET" && req\.path === "\/status";/);
  assert.match(gate, /opsTokenMatches\(bearer\) \|\| \(statusOnly && statusTokenMatches\(bearer\)\)/);
  // It is checked nowhere else.
  assert.equal(router.split("statusTokenMatches(").length - 1, 1);
  // Mint, revoke and provision each write one ops log line.
  for (const action of ["mint", "revoke", "provision"]) {
    assert.match(router, new RegExp(`logOpsAction\\(req, "${action}", user\\.email`), action);
  }
  const log = section(router, "function logOpsAction(", "\n  }\n");
  assert.doesNotMatch(log, /token/i);
});

test("only users on the allowed list are found, and a token is checked against it on every use", () => {
  const status = source("src/lib/agentGateway/status.ts");
  const find = section(status, "export async function findAgentUserByEmail(", "\n}\n");
  assert.match(find, /if \(!isAgentEmailAllowed\(email\)\) \{\s*return \{ ok: false, error: "email_not_allowed" \};/);
  // Before the database is asked.
  assert.ok(find.indexOf("isAgentEmailAllowed(") < find.indexOf('.from("app_users")'));
  const toUser = section(status, "function toAgentUser(", "\n}\n");
  assert.match(toUser, /!isAgentEmailAllowed\(email\)/);

  const tokens = source("src/lib/agentGateway/tokens.ts");
  const authenticate = section(tokens, "export async function authenticateAgentToken(", "\n}\n");
  assert.match(authenticate, /if \(!isAgentEmailAllowed\(email\)\) return null;/);

  const config = source("src/lib/agentGateway/config.ts");
  const allowed = section(config, "export function agentAllowedEmails()", "\n}\n");
  assert.match(allowed, /process\.env\.DOCKET_AGENT_ALLOWED_EMAILS \?\? ""/);
});

test("the ops token is compared in constant time and never with ===", () => {
  const tokens = source("src/lib/agentGateway/tokens.ts");
  const compare = section(tokens, "function sameSecret(", "\n}\n");
  assert.match(compare, /timingSafeEqual\(a, b\)/);
  assert.match(compare, /createHash\("sha256"\)/);
  assert.doesNotMatch(compare, /===|!==|==/);
  // Both secrets go through that one comparison.
  for (const name of ["opsTokenMatches", "statusTokenMatches"]) {
    const body = section(tokens, `export function ${name}(`, "\n}\n");
    assert.match(body, /sameSecret\(presented, /, name);
    assert.doesNotMatch(body, /===|!==|==/, name);
  }
  // Nowhere in the gateway is the ops token compared directly.
  for (const path of [
    "src/lib/agentGateway/tokens.ts",
    "src/lib/agentGateway/config.ts",
    "src/routes/agentMcp.ts",
  ]) {
    const text = source(path);
    assert.doesNotMatch(text, /agentOpsToken\(\)\s*[!=]==?/, path);
    assert.doesNotMatch(text, /[!=]==?\s*agentOpsToken\(\)/, path);
    assert.doesNotMatch(text, /DOCKET_AGENT_OPS_TOKEN[^\n]*[!=]==/, path);
    assert.doesNotMatch(text, /agentStatusToken\(\)\s*[!=]==?/, path);
    assert.doesNotMatch(text, /[!=]==?\s*agentStatusToken\(\)/, path);
  }
  // Only a hash of an agent token is ever written.
  assert.match(tokens, /token_hash: hashAgentToken\(token\)/);
  assert.doesNotMatch(tokens, /insert\(\{[^}]*\btoken\b\s*[,}]/);
});

test("user.ts keeps Docket's own connector guards and adds only Disconnect for the user's PracticePanther sign-in", () => {
  const user = source("src/routes/user.ts");

  // Docket's own rules for who may start a sign-in and refresh a tool list
  // are exactly as Docket has them. A user connects PracticePanther the
  // normal way; the gateway opens nothing there.
  const oauth = section(
    user,
    "// POST /user/mcp-connectors/:connectorId/oauth/start",
    "// POST /user/mcp-connectors/:connectorId/oauth/disconnect",
  );
  assert.match(
    oauth,
    /connector\.managedBy !== "box" &&\s*connector\.managedBy !== "practicepanther" &&\s*!\(await isAdminUser\(db, userId\)\)/,
  );
  const refresh = section(
    user,
    "// POST /user/mcp-connectors/:connectorId/refresh-tools",
    "// PATCH /user/mcp-connectors/:connectorId/tools/:toolId",
  );
  assert.match(
    refresh,
    /if \(current\.managedBy === null && !\(await isAdminUser\(db, userId\)\)\) \{/,
  );
  assert.doesNotMatch(user, /docketAgentSource|agentSource/);
  assert.match(user, /userRouter\.post\("\/mcp-connectors", requireAuth, requireAdmin,/);
  const patchAndDelete = user.match(
    /"\/mcp-connectors\/:connectorId",\s*requireAuth,\s*requireAdmin,/g,
  );
  assert.equal(patchAndDelete?.length, 2, "update and delete stay admin-only");

  // The one addition: a user can remove his own PracticePanther sign-in.
  // Docket's page lets him connect it but not take it away again, and a
  // sign-in made with the wrong PracticePanther account could not be
  // cleared. No admin needed. The row check is in the library.
  const disconnect = section(
    user,
    "// POST /user/mcp-connectors/:connectorId/oauth/disconnect",
    "// GET /user/mcp-connectors/oauth/callback",
  );
  assert.match(
    disconnect,
    /"\/mcp-connectors\/:connectorId\/oauth\/disconnect",\s*requireAuth,\s*async \(req, res\) =>/,
  );
  assert.doesNotMatch(disconnect, /requireAdmin|isAdminUser/);
  assert.match(
    disconnect,
    /disconnectPracticePantherSignIn\(\s*userId,\s*req\.params\.connectorId,\s*db,\s*withSignInLock,\s*\)/,
  );
  // Its error answer is a fixed text, never the cause.
  assert.doesNotMatch(disconnect, /json\(\{ detail \}\)/);
  const disconnectFn = section(
    source("src/lib/agentGateway/sources.ts"),
    "export async function disconnectPracticePantherSignIn(",
    "\n}\n",
  );
  assert.match(disconnectFn, /\.eq\("user_id", userId\)\s*\.eq\("id", connectorId\)/);
  assert.match(disconnectFn, /!row \|\| row\.user_id !== userId/);
  assert.match(disconnectFn, /!isPrimaryPracticePantherConnector\(row\)/);
  // The sign-in goes while the refresh lock is held. Never the row, never
  // the tool list, never an agent token.
  assert.match(disconnectFn, /await withSignInLock\(row\.id, async \(\) => \{/);
  assert.match(disconnectFn, /from\("user_mcp_oauth_tokens"\)\s*\.delete\(\)\s*\.eq\("connector_id", row\.id\)/);
  assert.doesNotMatch(disconnectFn, /from\("user_mcp_connectors"\)\s*\.delete/);
  assert.doesNotMatch(disconnectFn, /user_mcp_connector_tools|docket_agent_tokens/);

  // The lock it is given has the same name as the refresh lock.
  const auth = source("src/lib/agentGateway/upstreamAuth.ts");
  const signInLock = section(auth, "export function withSignInLock<T>(", "\n}\n");
  assert.match(signInLock, /withPostgresAdvisoryLock\(`docket-agent-oauth:\$\{connectorId\}`, run\)/);

  // Only Quo has a connector row of the gateway's own.
  const marker = source("src/lib/mcp/agentSource.ts");
  assert.match(marker, /export type DocketAgentMarkedSource = "quo";/);
  assert.match(marker, /=== "quo" \? "quo" : null/);
});

test("servers.ts adds the audit marker only for a Docket Agent call", () => {
  const servers = source("src/lib/mcp/servers.ts");
  const columns = section(servers, "function auditContextColumns(", "\n}\n");
  assert.match(
    columns,
    /\.\.\.\(context\.origin\s*\?\s*\{\s*origin: context\.origin,\s*agent_token_id: context\.agentTokenId \?\? null,\s*\}\s*:\s*\{\}\)/,
  );
  // "origin" appears only inside the context.origin branch.
  const outside = columns.replace(/\.\.\.\(context\.origin[\s\S]*?:\s*\{\}\)/, "");
  assert.doesNotMatch(outside, /origin|agent_token_id/);
  assert.match(servers, /export async function withMcpClient</);

  // A Docket Agent call posts no audit note into PracticePanther and its
  // arguments are sent as they came, although it now runs on the row Docket
  // manages. Chat calls never set origin, so for chat nothing changed.
  const execute = section(servers, "export async function executeResolvedMcpToolCall(", "\n}\n");
  assert.match(
    execute,
    /const isPracticePanther =\s*backendManagedBy\(params\.connector\) === "practicepanther" &&\s*context\.origin !== "docket_agent";/,
  );
  assert.equal(execute.split("context.origin").length - 1, 1);
  assert.equal(servers.split("docket_agent").length - 1, 1);

  const types = source("src/lib/mcp/types.ts");
  const context = section(types, "export type McpExecutionContext = {", "};");
  assert.match(context, /origin\?: "docket_agent";/);
  assert.match(context, /agentTokenId\?: string \| null;/);
});

test("Docket's own MCP client renews a sign-in early, under the gateway's lock, before it connects", () => {
  const servers = source("src/lib/mcp/servers.ts");
  const client = section(servers, "export async function withMcpClient<T>(", "\n}\n");
  // After the address check, before the sign-in is read for the connection.
  const order = [
    "await validateRemoteMcpUrl(connector.server_url);",
    "await refreshSignInBeforeUse(connector, db);",
    "new DbMcpOAuthProvider(",
    "new StreamableHTTPClientTransport(",
    "await client.connect(transport",
  ].map((text) => client.indexOf(text));
  for (const position of order) assert.notEqual(position, -1);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(servers.split("refreshSignInBeforeUse(").length - 1, 1);
  assert.match(
    servers,
    /import \{ refreshSignInBeforeUse \} from "\.\.\/agentGateway\/upstreamAuth";/,
  );
  // Nothing else of the gateway is known to Docket's client code.
  assert.equal(servers.split("agentGateway").length - 1, 1);

  // It is the same check, the same lock and the same refresh the gateway
  // uses, and it never throws into the caller.
  const auth = source("src/lib/agentGateway/upstreamAuth.ts");
  const early = section(auth, "export async function refreshSignInBeforeUse(", "\n}\n");
  // Nothing at all for a connector without an OAuth sign-in, and nothing
  // at all while the gateway is switched off: Docket's own path is then
  // what it was, and unsetting DOCKET_AGENT_OPS_TOKEN switches this off.
  assert.match(
    early,
    /if \(connector\.auth_type !== "oauth" \|\| !agentGatewayEnabled\(\)\) return;\n  try \{/,
  );
  assert.match(auth, /import \{ agentGatewayEnabled \} from "\.\/config";/);
  assert.match(
    early,
    /await ensureUpstreamSignIn\(\s*connector,\s*db,\s*\{ refresh: "if_near_expiry", skewMs: REQUEST_REFRESH_SKEW_MS \},\s*deps,\s*\);/,
  );
  assert.match(early, /try \{[\s\S]*\} catch \(err\) \{[\s\S]*safeErrorLog\(err\)/);
  assert.doesNotMatch(early, /throw /);
  const defaults = section(auth, "const defaultEarlyRefreshDeps", "};");
  assert.match(defaults, /refreshUpstreamToken: defaultRefreshUpstreamToken,/);
  assert.match(defaults, /withRefreshLock: defaultWithRefreshLock,/);
  // No import cycle: the refresh code does not load Docket's client code.
  assert.doesNotMatch(auth, /from "\.\.\/mcp\/servers"/);
});

test("the PracticePanther source is Docket's own per-user connector, never the shared one", () => {
  const config = source("src/lib/agentGateway/config.ts");
  const defaults = source("src/lib/mcp/defaults.ts");
  const legacyHost = /"https:\/\/(wild-spark-[a-z0-9]+\.run\.mcp-use\.com)\/mcp"/.exec(defaults)?.[1];
  assert.ok(legacyHost, "the shared connector's host is still in defaults.ts");

  // The gateway has no PracticePanther address of its own. It takes the one
  // Docket runs on, and only while Docket runs on per-user sign-in.
  assert.doesNotMatch(config, /DOCKET_AGENT_PRACTICEPANTHER_MCP_URL|warm-pulse/);
  const urlFn = section(config, "export function agentPracticePantherMcpUrl()", "\n}\n");
  assert.match(urlFn, /if \(managedMcpAuthType\("practicepanther"\) !== "oauth"\) return null;/);
  assert.match(urlFn, /const url = practicePantherMcpServerUrl\(\);/);
  assert.match(urlFn, /if \(!url \|\| isLegacySharedPracticePantherUrl\(url\)\) return null;/);
  assert.doesNotMatch(urlFn, /process\.env/);
  // The old shared host is named once, as the thing to refuse.
  assert.match(
    config,
    new RegExp(`LEGACY_SHARED_PRACTICEPANTHER_HOST =\\s*"${legacyHost.replaceAll(".", "\\.")}"`),
  );
  assert.equal(config.split(legacyHost).length - 1, 1);

  const sources = source("src/lib/agentGateway/sources.ts");
  const resolve = section(sources, "async function resolvePracticePantherConnector(", "\n}\n");
  // The user's own row, at the per-user address, an OAuth connector, and the
  // one Docket itself calls its PracticePanther connector.
  assert.match(resolve, /\.eq\("user_id", userId\)\s*\.eq\("server_url", allowedUrl\)/);
  assert.match(resolve, /candidate\.user_id === userId &&/);
  assert.match(resolve, /backendManagedBy\(row\) !== "practicepanther"/);
  assert.match(resolve, /row\.auth_type !== "oauth"/);
  assert.match(resolve, /!isPrimaryPracticePantherConnector\(row\)/);
  // The gateway writes no PracticePanther row, under any name.
  assert.doesNotMatch(resolve, /\.insert\(|\.update\(|\.delete\(/);
  assert.match(sources, /const MARKED_CONNECTOR_NAMES: Record<DocketAgentMarkedSource, string> = \{\s*quo: "Quo \(Docket Agent\)",\s*\};/);
  assert.doesNotMatch(sources, /ensureDefaultMcpConnectors/);
  // Quo's own row is still made switched off, so chat never loads it.
  assert.match(sources, /enabled: false/);
  for (const path of [
    "src/lib/agentGateway/sources.ts",
    "src/lib/agentGateway/config.ts",
    "src/routes/agentMcp.ts",
    "src/routes/user.ts",
  ]) {
    assert.doesNotMatch(source(path), /PracticePanther \(Docket Agent\)/, path);
  }
});

test("Docket's own PracticePanther policy file is unchanged in size", async () => {
  const policy = await import("../src/lib/mcp/practicePantherAccessPolicy");
  // As Docket's own main has it since the per-user cutover (#20, 2026-09-28),
  // which added the connector's real task, matter and message-read names.
  assert.equal(policy.ADMIN_ONLY_PRACTICEPANTHER_TOOLS.length, 36);
  assert.equal(policy.READ_ALL_PRACTICEPANTHER_TOOLS.length, 35);
  assert.equal(policy.WRITE_WITH_APPROVAL_PRACTICEPANTHER_TOOLS.length, 38);
  assert.equal(policy.PRACTICEPANTHER_POLICY_VERSION, "2026-09-28.1");

  // The gateway's lists are written the same literal way, so the Docket
  // Agent build can read both files alike: one name per line, nothing else
  // between the brackets.
  const gatewayPolicy = source("src/lib/agentGateway/policy.ts");
  assert.match(gatewayPolicy, /export const AGENT_PRACTICEPANTHER_WRITE_TOOLS = \[\n(  "[A-Za-z_]+",\n){21}\] as const;/);
  assert.match(gatewayPolicy, /export const AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS = \[\n(  "[A-Za-z_]+",\n){10}\] as const;/);
  assert.match(gatewayPolicy, /export const AGENT_PRACTICEPANTHER_SEND_TOOLS = \[\n(  "[A-Za-z_]+",\n){2}\] as const;/);
  assert.match(gatewayPolicy, /export const AGENT_PRACTICEPANTHER_EXTRA_READ_TOOLS = \[\n(  "[A-Za-z_]+",\n){4}\] as const;/);
  assert.match(gatewayPolicy, /export const AGENT_BOX_ORGANIZE_TOOLS = \[\n(  "[a-z_]+",\n){9}\] as const;/);
  assert.match(gatewayPolicy, /export const AGENT_QUO_WRITE_TOOLS = \[\n(  "[a-z-]+",\n){4}\] as const;/);
  // The Docket Agent build counts every exported list whose name ends in
  // READ_TOOLS as reads any user may make. Only the extra read list may.
  const readLists = [...gatewayPolicy.matchAll(/export const (AGENT_PRACTICEPANTHER_\w*READ_TOOLS) =/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(readLists, ["AGENT_PRACTICEPANTHER_EXTRA_READ_TOOLS"]);
});

test("Docket chat's own Box and PracticePanther rules are not touched by the gateway lists", () => {
  // Docket's Box rule names reads only. None of the gateway's organize tools
  // is in it, so chat still asks the user before each of them.
  const boxPolicy = source("src/lib/mcp/boxAccessPolicy.ts");
  const readTools = section(boxPolicy, "const BOX_READ_TOOLS = new Set([", "]);");
  for (const name of [
    "create_folder",
    "move_file",
    "move_folder",
    "update_file_properties",
    "update_folder_properties",
    "copy_file",
    "copy_folder",
    "set_file_metadata",
    "set_folder_metadata",
    // The gateway's own extra Box read: chat still asks the user first.
    "get_preview_page",
  ]) {
    assert.ok(!readTools.includes(`"${name}"`), name);
  }
  assert.doesNotMatch(boxPolicy, /agentGateway|DOCKET_AGENT/);
  // Docket's PracticePanther policy still keeps the user list admin-only.
  const ppPolicy = source("src/lib/mcp/practicePantherAccessPolicy.ts");
  const adminOnly = section(ppPolicy, "export const ADMIN_ONLY_PRACTICEPANTHER_TOOLS = [", "] as const;");
  for (const name of ["Users_Me", "Users_GetUser", "Users_GetUsers"]) {
    assert.ok(adminOnly.includes(`"${name}"`), name);
  }
  assert.doesNotMatch(ppPolicy, /agentGateway|DOCKET_AGENT/);
  // Chat's code never reads the gateway's lists or switches.
  for (const path of ["src/lib/mcp/servers.ts", "src/lib/mcp/approvals.ts", "src/routes/chat.ts"]) {
    assert.doesNotMatch(
      source(path),
      /AGENT_BOX_ORGANIZE_TOOLS|AGENT_BOX_EXTRA_READS|AGENT_PRACTICEPANTHER_WRITE_TOOLS|AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS|AGENT_PRACTICEPANTHER_SEND_TOOLS|AGENT_QUO_WRITE_TOOLS|agentGateway\/policy|agentBoxOrganizeEnabled|DOCKET_AGENT_BOX_ORGANIZE/,
      path,
    );
  }

  // The organize switch: off unless the env var says "on", read when asked.
  const config = source("src/lib/agentGateway/config.ts");
  const organize = section(config, "export function agentBoxOrganizeEnabled()", "\n}\n");
  assert.match(organize, /process\.env\.DOCKET_AGENT_BOX_ORGANIZE \?\? ""/);
  assert.match(organize, /=== "on"/);
  // The policy takes the switch as an argument and treats a missing one as off.
  const gatewayPolicy = source("src/lib/agentGateway/policy.ts");
  assert.match(gatewayPolicy, /boxOrganizeEnabled: input\.boxOrganizeEnabled === true,/);
  assert.match(gatewayPolicy, /if \(!input\.boxOrganizeEnabled\) return deny\("organize_off"\);/);
  // The status answer carries it.
  const status = source("src/lib/agentGateway/status.ts");
  assert.match(status, /box_organize: "on" \| "off";/);
  assert.match(status, /box_organize: agentBoxOrganizeStatus\(\),/);
});

test(".env.example and the README name every new env var", () => {
  const envExample = source(".env.example");
  const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
  const names = [
    "DOCKET_AGENT_OPS_TOKEN",
    "DOCKET_AGENT_STATUS_TOKEN",
    "DOCKET_AGENT_ALLOWED_EMAILS",
    "DOCKET_AGENT_QUO_MCP_URL",
    "DOCKET_AGENT_PRACTICEPANTHER_WRITES",
    "DOCKET_AGENT_BOX_ORGANIZE",
    "DOCKET_AGENT_EMAIL_DOMAIN",
    "RATE_LIMIT_AGENT_MCP_MAX",
    "RATE_LIMIT_AGENT_MCP_WINDOW_MINUTES",
    "RATE_LIMIT_AGENT_MCP_UNAUTH_MAX",
  ];
  for (const name of names) {
    // Listed, commented out, with no real value for the secret.
    assert.match(envExample, new RegExp(`^# ${name}=`, "m"), name);
    assert.ok(readme.includes(name), `README.md names ${name}`);
  }
  assert.match(envExample, /^# DOCKET_AGENT_OPS_TOKEN=$/m);
  assert.match(envExample, /^# DOCKET_AGENT_STATUS_TOKEN=$/m);
  // Nobody is allowed by default.
  assert.match(envExample, /^# DOCKET_AGENT_ALLOWED_EMAILS=$/m);
  // Both change switches are documented as off.
  assert.match(envExample, /^# DOCKET_AGENT_PRACTICEPANTHER_WRITES=off$/m);
  assert.match(envExample, /^# DOCKET_AGENT_BOX_ORGANIZE=off$/m);

  // Every env var the gateway code reads is one of the documented names.
  const read = new Set<string>();
  for (const path of ["src/lib/agentGateway/config.ts", "src/routes/agentMcp.ts"]) {
    for (const match of source(path).matchAll(/(?:process\.env\.|envInt\(")([A-Z_]+)/g)) {
      read.add(match[1]);
    }
  }
  assert.deepEqual([...read].sort(), [...names].sort());
  // PracticePanther has no gateway setting: it is Docket's own per-user
  // connector, and both files say so.
  for (const [name, text] of [[".env.example", envExample], ["README.md", readme]] as const) {
    assert.doesNotMatch(text, /DOCKET_AGENT_PRACTICEPANTHER_MCP_URL/, name);
    assert.match(text, /PRACTICEPANTHER_USER_MCP_SERVER_URL/, name);
  }
});

test("the connectors page is Docket's own, plus Disconnect on the user's PracticePanther connection", () => {
  const page = readFileSync(
    resolve(repoRoot, "frontend/src/app/(pages)/account/connectors/page.tsx"),
    "utf8",
  );
  // No Docket Agent row, badge, text or button: a user connects
  // PracticePanther with Docket's own button and needs nothing more.
  assert.doesNotMatch(page, /docketAgentSource|isDocketAgent|Docket Agent only/);
  assert.match(page, /"Connect PracticePanther"/);
  assert.match(page, /\{\(isBackendManaged \|\| isAdmin\) && !isRetiredPracticePanther && \(/);
  assert.match(page, /\{!isBackendManaged && isAdmin && \(/);
  // The one addition: once connected, he can remove the sign-in again.
  assert.match(
    page,
    /\{connector\.authType === "oauth" && connector\.oauthConnected && \(\s*<button\s+type="button"\s+onClick=\{\(\) => void onPracticePantherDisconnect\(connector\.id\)\}/,
  );
  assert.equal(page.split(">\n              Disconnect\n").length - 1, 1);
  assert.match(page, /replaceConnector\(await disconnectMcpConnectorOAuth\(connectorId\)\)/);
  // It sits inside Docket's PracticePanther panel and nowhere else.
  const panel = page.slice(
    page.indexOf('{connector.managedBy === "practicepanther" && ('),
    page.indexOf('{connector.managedBy === "box" && ('),
  );
  assert.match(panel, /onPracticePantherDisconnect\(connector\.id\)/);
  assert.equal(page.split("onPracticePantherDisconnect(").length - 1, 1);
  const api = readFileSync(resolve(repoRoot, "frontend/src/app/lib/docketApi.ts"), "utf8");
  assert.match(api, /`\/user\/mcp-connectors\/\$\{connectorId\}\/oauth\/disconnect`,\s*\{ method: "POST" \}/);
});
