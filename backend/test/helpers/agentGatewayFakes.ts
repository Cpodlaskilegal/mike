// Shared fakes for the Docket Agent gateway tests: an in-memory database
// that speaks the same small query language as src/lib/supabase.ts, a fake
// upstream MCP server, and an Express helper. No real database, no network.
//
// Import this file FIRST in a test. It sets the dummy environment the
// backend modules need before they are loaded.

process.env.DATABASE_URL ||= "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import type { ConnectorRow, Db, ToolCacheRow } from "../../src/lib/mcp/types";

export const PER_USER_PP_URL = "https://warm-pulse-vyvir.run.mcp-use.com/mcp";
export const LEGACY_SHARED_PP_URL = "https://wild-spark-qn7iy.run.mcp-use.com/mcp";
export const BOX_URL = "https://mcp.box.com/";
export const QUO_URL = "https://quo-mcp.example.invalid/mcp";
export const TEST_OPS_TOKEN = "ops-test-token-0123456789abcdef0123456789abcdef";
export const TEST_STATUS_TOKEN =
  "status-test-token-fedcba9876543210fedcba9876543210";
export const FAKE_UPSTREAM_ACCESS_TOKEN = "upstream-access-secret-5f1c9e7a2b";

const GATEWAY_ENV_NAMES = [
  "DOCKET_AGENT_OPS_TOKEN",
  "DOCKET_AGENT_STATUS_TOKEN",
  "DOCKET_AGENT_ALLOWED_EMAILS",
  "RATE_LIMIT_AGENT_MCP_UNAUTH_MAX",
  "DOCKET_AGENT_PRACTICEPANTHER_MCP_URL",
  "DOCKET_AGENT_QUO_MCP_URL",
  "DOCKET_AGENT_PRACTICEPANTHER_WRITES",
  "DOCKET_AGENT_BOX_ORGANIZE",
  "DOCKET_AGENT_BOX_UPLOADS",
  "DOCKET_AGENT_EMAIL_DOMAIN",
  "RATE_LIMIT_AGENT_MCP_MAX",
  "RATE_LIMIT_AGENT_MCP_WINDOW_MINUTES",
  "PRACTICEPANTHER_MCP_SERVER_URL",
  "PRACTICEPANTHER_MCP_ENABLED",
  "BOX_MCP_SERVER_URL",
  "BOX_MCP_ENABLED",
];

// The addresses the test world's operator has put on
// DOCKET_AGENT_ALLOWED_EMAILS. A new fake database starts a new world with
// nobody on the list, as on a fresh backend. `seedUser` adds to it.
const allowedEmails = new Set<string>();

/**
 * Puts the gateway env back to "nothing set", then applies `values`. The
 * list of allowed users belongs to the test world, not to one call: it
 * stays as `seedUser` and `allowAgentEmails` left it, unless `values`
 * names DOCKET_AGENT_ALLOWED_EMAILS itself.
 */
export function setGatewayEnv(values: Record<string, string> = {}): void {
  for (const name of GATEWAY_ENV_NAMES) delete process.env[name];
  process.env.DOCKET_AGENT_ALLOWED_EMAILS = [...allowedEmails].join(",");
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

/** Adds addresses to DOCKET_AGENT_ALLOWED_EMAILS. */
export function allowAgentEmails(...emails: string[]): void {
  for (const email of emails) allowedEmails.add(email.toLowerCase());
  process.env.DOCKET_AGENT_ALLOWED_EMAILS = [...allowedEmails].join(",");
}

type Row = Record<string, any>;
type Filter = { kind: string; column: string; value: unknown };
type Failure = { table: string; op: string; remaining: number };

const UNIQUE_RULES: Record<string, Array<(row: Row) => string | null>> = {
  docket_agent_tokens: [
    (row) => `hash:${row.token_hash}`,
    // One live token per user.
    (row) => (row.revoked_at == null ? `live:${row.user_id}` : null),
  ],
  user_mcp_connectors: [
    // One connector per user per Docket Agent source.
    (row) =>
      row.tool_policy && "docketAgentSource" in row.tool_policy
        ? `agent:${row.user_id}:${row.tool_policy.docketAgentSource}`
        : null,
  ],
  user_mcp_oauth_tokens: [(row) => `connector:${row.connector_id}`],
};

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function containsValue(actual: unknown, wanted: unknown): boolean {
  if (wanted && typeof wanted === "object" && !Array.isArray(wanted)) {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(wanted).every(([key, value]) =>
      containsValue((actual as Row)[key], value),
    );
  }
  return actual === wanted;
}

function matches(row: Row, filter: Filter): boolean {
  const actual = row[filter.column];
  if (filter.kind === "eq") return actual === filter.value;
  if (filter.kind === "neq") return actual !== filter.value;
  if (filter.kind === "gt") return String(actual) > String(filter.value);
  if (filter.kind === "in") {
    return Array.isArray(filter.value) && filter.value.includes(actual);
  }
  if (filter.kind === "is") {
    return filter.value === null ? actual == null : actual === filter.value;
  }
  if (filter.kind === "contains") return containsValue(actual, filter.value);
  throw new Error(`fake db: unsupported filter ${filter.kind}`);
}

class FakeQuery implements PromiseLike<{ data: any; error: any }> {
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private rows: Row[] = [];
  private updates: Row = {};
  private filters: Filter[] = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private maxRows: number | null = null;
  private singleMode: "single" | "maybeSingle" | null = null;
  private conflictColumns: string[] = [];

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(_columns = "*") {
    return this;
  }
  insert(row: Row | Row[]) {
    this.op = "insert";
    this.rows = (Array.isArray(row) ? row : [row]).map((item) => clone(item));
    return this;
  }
  update(values: Row) {
    this.op = "update";
    this.updates = clone(values);
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  upsert(row: Row | Row[], options?: { onConflict?: string }) {
    this.op = "upsert";
    this.rows = (Array.isArray(row) ? row : [row]).map((item) => clone(item));
    this.conflictColumns =
      options?.onConflict?.split(",").map((column) => column.trim()) ?? [];
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }
  neq(column: string, value: unknown) {
    this.filters.push({ kind: "neq", column, value });
    return this;
  }
  gt(column: string, value: unknown) {
    this.filters.push({ kind: "gt", column, value });
    return this;
  }
  in(column: string, value: unknown[]) {
    this.filters.push({ kind: "in", column, value });
    return this;
  }
  is(column: string, value: unknown) {
    this.filters.push({ kind: "is", column, value });
    return this;
  }
  contains(column: string, value: unknown) {
    this.filters.push({ kind: "contains", column, value });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }
  limit(count: number) {
    this.maxRows = count;
    return this;
  }
  single() {
    this.singleMode = "single";
    return this;
  }
  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this;
  }

  then<A = { data: any; error: any }, B = never>(
    onfulfilled?: ((value: { data: any; error: any }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: any) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }

  private execute(): { data: any; error: any } {
    this.db.calls.push({ table: this.table, op: this.op });
    if (this.db.takeFailure(this.table, this.op)) {
      return { data: null, error: { message: `fake ${this.op} failure` } };
    }
    const table = this.db.table(this.table);
    const selected = () => table.filter((row) => this.filters.every((f) => matches(row, f)));
    let result: Row[];

    if (this.op === "select") {
      result = selected();
      for (const order of [...this.orders].reverse()) {
        result = [...result].sort((a, b) => {
          const left = String(a[order.column] ?? "");
          const right = String(b[order.column] ?? "");
          return (left < right ? -1 : left > right ? 1 : 0) * (order.ascending ? 1 : -1);
        });
      }
      if (this.maxRows != null) result = result.slice(0, this.maxRows);
    } else if (this.op === "insert" || this.op === "upsert") {
      result = [];
      for (const input of this.rows) {
        const existing =
          this.op === "upsert" && this.conflictColumns.length
            ? table.find((row) =>
                this.conflictColumns.every((column) => row[column] === input[column]),
              )
            : undefined;
        if (existing) {
          Object.assign(existing, input);
          result.push(existing);
          continue;
        }
        const now = new Date().toISOString();
        const row: Row = {
          id: randomUUID(),
          created_at: now,
          updated_at: now,
          ...(this.table === "docket_agent_tokens"
            ? { revoked_at: null, last_used_at: null }
            : {}),
          ...input,
        };
        const conflict = this.db.uniqueConflict(this.table, row);
        if (conflict) {
          return { data: null, error: { message: `duplicate key: ${conflict}` } };
        }
        table.push(row);
        result.push(row);
      }
      this.db.events.push(`db:${this.op}:${this.table}:${String(result[0]?.status ?? "")}`);
    } else if (this.op === "update") {
      result = selected();
      for (const row of result) Object.assign(row, this.updates);
      this.db.events.push(`db:update:${this.table}:${String(this.updates.status ?? "")}`);
    } else {
      result = selected();
      const removed = new Set(result);
      const kept = table.filter((row) => !removed.has(row));
      table.length = 0;
      table.push(...kept);
    }

    const data = result.map((row) => clone(row));
    if (this.singleMode) {
      if (!data.length && this.singleMode === "single") {
        return { data: null, error: { message: "No rows found" } };
      }
      return { data: data[0] ?? null, error: null };
    }
    return { data, error: null };
  }
}

export class FakeDb {
  readonly tables: Record<string, Row[]> = {};
  /** Every query that ran, in order. */
  readonly calls: Array<{ table: string; op: string }> = [];
  /** Writes and upstream calls in order, to check what happened first. */
  readonly events: string[] = [];
  private readonly failures: Failure[] = [];

  from(table: string) {
    return new FakeQuery(this, table);
  }
  table(name: string): Row[] {
    this.tables[name] ??= [];
    return this.tables[name];
  }
  /** Makes the next `times` queries of this kind on this table fail. */
  failOn(table: string, op: string, times = 1): void {
    this.failures.push({ table, op, remaining: times });
  }
  takeFailure(table: string, op: string): boolean {
    const failure = this.failures.find(
      (item) => item.table === table && item.op === op && item.remaining > 0,
    );
    if (!failure) return false;
    failure.remaining -= 1;
    return true;
  }
  uniqueConflict(tableName: string, candidate: Row): string | null {
    for (const rule of UNIQUE_RULES[tableName] ?? []) {
      const key = rule(candidate);
      if (key && this.table(tableName).some((row) => rule(row) === key)) return key;
    }
    return null;
  }
  asDb(): Db {
    return this as unknown as Db;
  }
}

export function createFakeDb(): FakeDb {
  allowedEmails.clear();
  delete process.env.DOCKET_AGENT_ALLOWED_EMAILS;
  return new FakeDb();
}

/**
 * A Docket user. Unless `allowed: false`, his address is also put on the
 * list of users Docket Agent may act for, as the operator would do before
 * enrolling him.
 */
export function seedUser(
  db: FakeDb,
  user: {
    id: string;
    email: string;
    role?: unknown;
    status?: string;
    allowed?: boolean;
  },
): void {
  db.table("app_users").push({
    id: user.id,
    email: user.email,
    role: user.role === undefined ? "user" : user.role,
    docket_data_status: user.status ?? "active",
  });
  if (user.allowed !== false && typeof user.email === "string") {
    allowAgentEmails(user.email);
  }
}

export function seedConnector(
  db: FakeDb,
  connector: Partial<ConnectorRow> & { id: string; user_id: string },
): ConnectorRow {
  const row: ConnectorRow = {
    name: "Connector",
    transport: "streamable_http",
    server_url: PER_USER_PP_URL,
    auth_type: "oauth",
    enabled: false,
    tool_policy: {},
    encrypted_auth_config: null,
    auth_config_iv: null,
    auth_config_tag: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...connector,
  };
  db.table("user_mcp_connectors").push(row);
  return row;
}

/** The marked PracticePanther row provisioning would create. */
export function seedAgentPracticePantherConnector(
  db: FakeDb,
  userId: string,
  overrides: Partial<ConnectorRow> = {},
): ConnectorRow {
  return seedConnector(db, {
    id: `pp-agent-${userId}`,
    user_id: userId,
    name: "PracticePanther (Docket Agent)",
    server_url: PER_USER_PP_URL,
    tool_policy: { docketAgentSource: "practicepanther" },
    ...overrides,
  });
}

/** The PracticePanther row Docket chat manages (the old shared connector). */
export function seedManagedPracticePantherConnector(
  db: FakeDb,
  userId: string,
): ConnectorRow {
  return seedConnector(db, {
    id: `pp-managed-${userId}`,
    user_id: userId,
    name: "PracticePanther MCP",
    server_url: LEGACY_SHARED_PP_URL,
    auth_type: "none",
    enabled: true,
    tool_policy: { managedBy: "backend", managedConnector: "practicepanther" },
  });
}

/** The Box row Docket chat manages. Docket Agent shares it, read-only. */
export function seedManagedBoxConnector(
  db: FakeDb,
  userId: string,
  overrides: Partial<ConnectorRow> = {},
): ConnectorRow {
  return seedConnector(db, {
    id: `box-managed-${userId}`,
    user_id: userId,
    name: "Box MCP",
    server_url: BOX_URL,
    enabled: true,
    tool_policy: { managedBy: "backend", managedConnector: "box" },
    ...overrides,
  });
}

/**
 * A stored upstream sign-in. The fake keeps the "encrypted" token as the
 * plain test secret on purpose, so a leak of the row would show in the
 * secret checks.
 */
export function seedOAuthToken(
  db: FakeDb,
  connectorId: string,
  options: {
    expiresAt?: string | null;
    accessToken?: boolean;
    refreshToken?: boolean;
  } = {},
): void {
  const hasAccess = options.accessToken !== false;
  db.table("user_mcp_oauth_tokens").push({
    id: randomUUID(),
    connector_id: connectorId,
    encrypted_access_token: hasAccess ? FAKE_UPSTREAM_ACCESS_TOKEN : null,
    access_token_iv: hasAccess ? "iv" : null,
    access_token_tag: hasAccess ? "tag" : null,
    encrypted_refresh_token: options.refreshToken === false ? null : "refresh-secret",
    refresh_token_iv: options.refreshToken === false ? null : "iv",
    refresh_token_tag: options.refreshToken === false ? null : "tag",
    token_type: "Bearer",
    scope: null,
    expires_at: options.expiresAt === undefined ? null : options.expiresAt,
    client_id: "docket-client",
  });
}

export function seedTool(
  db: FakeDb,
  connectorId: string,
  toolName: string,
  overrides: Partial<ToolCacheRow> = {},
): ToolCacheRow {
  const row: ToolCacheRow = {
    id: `tool-${connectorId}-${toolName}`,
    connector_id: connectorId,
    tool_name: toolName,
    openai_tool_name: `mcp_${toolName.toLowerCase()}`,
    title: null,
    description: `Runs ${toolName}.`,
    input_schema: { type: "object", properties: {} },
    output_schema: null,
    annotations: {},
    enabled: true,
    requires_confirmation: false,
    last_seen_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
  db.table("user_mcp_connector_tools").push(row);
  return row;
}

export type UpstreamCall = {
  connector: ConnectorRow;
  name: string;
  args: unknown;
};

/** Stands in for the upstream MCP server and Docket's MCP client. */
export function createFakeUpstream(db?: FakeDb) {
  const calls: UpstreamCall[] = [];
  const connectors: ConnectorRow[] = [];
  const state: {
    respond: (name: string, args: unknown) => unknown;
    connectError: Error | null;
  } = {
    respond: (name) => ({ content: [{ type: "text", text: `result of ${name}` }] }),
    connectError: null,
  };
  async function withUpstreamClient<T>(
    connector: ConnectorRow,
    run: (client: { callTool: any }) => Promise<T>,
  ): Promise<T> {
    connectors.push(connector);
    if (state.connectError) throw state.connectError;
    return run({
      callTool: async (params: { name: string; arguments?: unknown }) => {
        calls.push({ connector, name: params.name, args: params.arguments });
        db?.events.push(`upstream:${params.name}`);
        return state.respond(params.name, params.arguments);
      },
    });
  }
  return { calls, connectors, state, withUpstreamClient };
}

/** An in-memory stand-in for the refresh lock: one run per connector at a time. */
export function createMemoryRefreshLock() {
  const tails = new Map<string, Promise<unknown>>();
  return function withRefreshLock<T>(
    connectorId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = tails.get(connectorId) ?? Promise.resolve();
    const next = previous.then(run, run);
    tails.set(
      connectorId,
      next.catch(() => undefined),
    );
    return next;
  };
}

/** Runs an Express app on a free local port for the length of `run`. */
export async function withApp(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, "close");
  }
}
