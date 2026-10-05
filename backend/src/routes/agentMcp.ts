// Docket Agent gateway: /agent-mcp
//
// Server-to-server only. A Docket Agent session presents a per-user agent
// token and reaches that one user's own PracticePanther, Box and Quo
// connectors through Docket. Docket keeps the sign-ins. PracticePanther and
// Box are the connections the user made in Docket itself, the ones Docket
// chat uses; there is nothing separate to connect for Docket Agent.
//
// - POST /agent-mcp/{source}       MCP (tools only), agent token
// - /agent-mcp/box/files...        Box file bytes, Box file token
//                                  (routes/agentBoxFiles.ts)
// - GET  /agent-mcp/ops/status     status token or ops token
// - POST /agent-mcp/ops/tokens     ops token (mint or rotate)
// - DELETE /agent-mcp/ops/tokens   ops token (revoke)
// - POST /agent-mcp/ops/provision  ops token
//
// The whole surface answers 503 until DOCKET_AGENT_OPS_TOKEN is set.
// Nothing here uses the browser sign-in middleware: the only credentials
// are the tokens above.
//
// Four secrets, four reaches:
// - An agent token (dka_) reaches one user's own sources over MCP.
// - A Box file token (dkf_) fetches and files that same user's Box files
//   and does nothing else. It is the one a session's sandbox holds.
// - The status token (DOCKET_AGENT_STATUS_TOKEN) reads the status and does
//   nothing else. It is the one the Docket Agent Poller holds.
// - The ops token mints, revokes and provisions. It stays with the
//   operator and is never put in a vault.
// Every one of them only works for users on DOCKET_AGENT_ALLOWED_EMAILS.

import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAsyncRouter } from "../middleware/asyncRouteErrors";
import {
  agentGatewayEnabled,
  agentMcpRateLimitMax,
  agentMcpRateLimitWindowMs,
  agentMcpUnauthRateLimitMax,
  isAgentSource,
  type AgentSource,
} from "../lib/agentGateway/config";
import type { AgentGatewayDeps } from "../lib/agentGateway/deps";
import { defaultBoxAccessToken } from "../lib/agentGateway/boxFiles";
import { buildAgentMcpServer } from "../lib/agentGateway/mcpServer";
import {
  provisionAgentConnectors,
  resolveAgentConnector,
} from "../lib/agentGateway/sources";
import {
  agentSourceStatuses,
  agentUserLookupStatus,
  buildAgentStatus,
  findAgentUserByEmail,
  MAX_STATUS_EMAILS,
  type AgentUser,
} from "../lib/agentGateway/status";
import {
  AgentTokenRotationConflictError,
  agentTokenScopeOf,
  authenticateAgentToken,
  hashAgentToken,
  mintAgentToken,
  opsTokenMatches,
  revokeAgentTokens,
  statusTokenMatches,
  touchAgentTokenLastUsed,
  type AgentPrincipal,
} from "../lib/agentGateway/tokens";
import {
  defaultRefreshUpstreamToken,
  defaultWithRefreshLock,
  ensureUpstreamSignIn,
  REQUEST_REFRESH_SKEW_MS,
} from "../lib/agentGateway/upstreamAuth";
import { validateRemoteMcpUrl } from "../lib/mcp/client";
import {
  refreshUserMcpConnectorTools,
  withMcpClient,
} from "../lib/mcp/servers";
import type { ConnectorRow } from "../lib/mcp/types";
import { safeErrorLog } from "../lib/safeError";
import { createServerSupabase } from "../lib/supabase";
import { createAgentBoxFilesRouter } from "./agentBoxFiles";

export type { AgentGatewayDeps };

const MCP_BODY_LIMIT = "1mb";
const OPS_BODY_LIMIT = "16kb";
const OPS_RATE_LIMIT_MAX = 300;
const OPS_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
// An upload body has two minutes to arrive. The hosting ingress cuts a
// request at four, and Box needs part of that for the upload itself.
const BOX_UPLOAD_BODY_TIMEOUT_MS = 2 * 60 * 1000;
// After an answer that did not wait for the upload body, the rest of the
// body may still arrive for this long (so the caller can read the answer).
// Then the connection is cut.
const BOX_UNREAD_BODY_GRACE_MS = 30 * 1000;

const METHOD_NOT_ALLOWED_BODY = {
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed." },
  id: null,
};

function defaultDeps(): AgentGatewayDeps {
  return {
    db: () => createServerSupabase(),
    now: () => Date.now(),
    withUpstreamClient: (connector, run, db) => withMcpClient(connector, run, db),
    refreshUpstreamToken: defaultRefreshUpstreamToken,
    withRefreshLock: defaultWithRefreshLock,
    refreshTools: refreshUserMcpConnectorTools,
    validateServerUrl: validateRemoteMcpUrl,
    boxAccessToken: defaultBoxAccessToken,
    boxFetch: (input, init) => fetch(input, init),
    boxUploadTimeouts: {
      bodyMs: BOX_UPLOAD_BODY_TIMEOUT_MS,
      unreadBodyGraceMs: BOX_UNREAD_BODY_GRACE_MS,
    },
  };
}

/** The bearer value of the Authorization header, or null. */
function bearerOf(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * The values of a query key that may be repeated (?email=a&email=b).
 * One value arrives as a string and a few as an array. Past the query
 * parser's array limit (20) they arrive as an object keyed by position, so
 * that shape is read too. Otherwise a long list would look like no list.
 */
function repeatedQueryValues(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw)
      : raw === undefined
        ? []
        : [raw];
  return values.filter((value): value is string => typeof value === "string");
}

function rejectAgentToken(res: Response): void {
  res
    .status(401)
    .set(
      "WWW-Authenticate",
      'Bearer realm="docket-agent", error="invalid_token"',
    )
    .json({ error: "invalid_token" });
}

/**
 * A token of the other kind. An MCP token never opens the Box file routes,
 * and a Box file token never opens the MCP routes or the ops routes. It is
 * told from its shape alone, so the refusal costs no database lookup.
 */
function rejectWrongTokenScope(res: Response): void {
  res
    .status(403)
    .set(
      "WWW-Authenticate",
      'Bearer realm="docket-agent", error="insufficient_scope"',
    )
    .json({ error: "wrong_token_scope" });
}

function rejectSourceNotConnected(
  res: Response,
  source: AgentSource,
  state: "not_connected" | "needs_reconnect",
): void {
  res
    .status(401)
    .set(
      "WWW-Authenticate",
      'Bearer realm="docket-agent", error="invalid_token", error_description="source_not_connected"',
    )
    .json({ error: "source_not_connected", source, state });
}

export function createAgentMcpRouter(
  overrides: Partial<AgentGatewayDeps> = {},
): Router {
  const deps: AgentGatewayDeps = { ...defaultDeps(), ...overrides };
  const router = createAsyncRouter();

  // 1. Every answer is uncacheable. 2. Off means off: nothing else is
  // revealed, with or without credentials.
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!agentGatewayEnabled()) {
      return void res.status(503).json({ error: "agent_gateway_disabled" });
    }
    next();
  });

  router.use("/ops", createOpsRouter(deps));

  // Two limits, in this order.
  //
  // 1. Before the token is looked at: one budget per caller address for
  //    requests that do not carry a valid agent token. Without this, a
  //    caller who sends a new made-up bearer on every request would never
  //    be limited, and each request would cost a database lookup on the
  //    pool the web app uses.
  //    Sessions share outbound addresses with strangers, so a bearer that
  //    was valid a moment ago does not pass through this limit at all: a
  //    flood from the same address cannot lock a working session out.
  //    That only skips this limit. The token is still checked against the
  //    database on every request, so a revoked token stops at once.
  const recentlyValid = new Map<string, number>(); // bearer hash -> until
  const unauthLimiter = rateLimit({
    windowMs: agentMcpRateLimitWindowMs(),
    limit: () => agentMcpUnauthRateLimitMax(),
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
    skip: (req) => {
      const bearer = bearerOf(req);
      if (!bearer) return false;
      const until = recentlyValid.get(hashAgentToken(bearer));
      return until !== undefined && until > deps.now();
    },
    // Only a request that ends without a valid token counts.
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) =>
      res.locals.agentPrincipal !== undefined,
    message: { error: "rate_limited" },
  });

  // 2. After the token is known: one budget per token, keyed by the
  //    token's own id. Never by the header text: "Bearer x", "bearer x" and
  //    "Bearer  x" are one token and share one budget.
  const tokenLimiter = rateLimit({
    windowMs: agentMcpRateLimitWindowMs(),
    limit: () => agentMcpRateLimitMax(),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (_req, res) =>
      `token:${(res.locals.agentPrincipal as AgentPrincipal).tokenId}`,
    message: { error: "rate_limited" },
  });

  // An unknown source or a wrong method is answered before any token work.
  const checkRoute: RequestHandler = (req, res, next) => {
    if (!isAgentSource(req.params.source)) {
      return void res.status(404).json({ error: "unknown_source" });
    }
    // There is no server-to-client stream and no session to end.
    if (req.method !== "POST") {
      return void res
        .status(405)
        .set("Allow", "POST")
        .json(METHOD_NOT_ALLOWED_BODY);
    }
    next();
  };

  /** Answers 401, or puts the token's owner in res.locals and goes on. */
  const admit = (
    bearer: string | null,
    principal: AgentPrincipal | null,
    res: Response,
    next: () => void,
  ): void => {
    if (!bearer || !principal) {
      if (bearer) recentlyValid.delete(hashAgentToken(bearer));
      return void rejectAgentToken(res);
    }
    // The map only ever holds tokens that passed the check: about two
    // entries per enrolled user. Entries past their time are dropped here.
    const now = deps.now();
    for (const [hash, until] of recentlyValid) {
      if (until <= now) recentlyValid.delete(hash);
    }
    recentlyValid.set(hashAgentToken(bearer), now + agentMcpRateLimitWindowMs());
    res.locals.agentPrincipal = principal;
    next();
  };

  /** The MCP routes: an agent token (dka_). A Box file token is refused. */
  const requireAgentToken: RequestHandler = async (req, res, next) => {
    const bearer = bearerOf(req);
    if (bearer && agentTokenScopeOf(bearer) === "box_files") {
      return void rejectWrongTokenScope(res);
    }
    const principal = bearer
      ? await authenticateAgentToken(bearer, deps.db())
      : null;
    admit(bearer, principal, res, next);
  };

  /** The Box file routes: a Box file token (dkf_). An agent token is refused. */
  const requireFileToken: RequestHandler = async (req, res, next) => {
    const bearer = bearerOf(req);
    if (bearer && agentTokenScopeOf(bearer) === "mcp") {
      return void rejectWrongTokenScope(res);
    }
    const principal = bearer
      ? await authenticateAgentToken(bearer, deps.db(), "box_files")
      : null;
    admit(bearer, principal, res, next);
  };

  // The Box file token has a budget of its own, of the same size: a run of
  // downloads cannot use up the session's MCP calls, or the other way round.
  // This is the budget for requests. Uploads have a much smaller one on top
  // of it, kept by the file routes themselves (routes/agentBoxFiles.ts).
  const fileTokenLimiter = rateLimit({
    windowMs: agentMcpRateLimitWindowMs(),
    limit: () => agentMcpRateLimitMax(),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (_req, res) =>
      `files:${(res.locals.agentPrincipal as AgentPrincipal).tokenId}`,
    message: { error: "rate_limited" },
  });

  const mcpJson = express.json({ limit: MCP_BODY_LIMIT });

  const serveSource: RequestHandler = async (req, res, next) => {
    const source = req.params.source as AgentSource;
    const principal = res.locals.agentPrincipal as AgentPrincipal;
    const db = deps.db();

    const resolved = await resolveAgentConnector(principal.userId, source, db);
    if (!resolved.ok) {
      return void rejectSourceNotConnected(res, source, "not_connected");
    }
    const connector = resolved.connector;
    // The sign-in provider is built from the row's owner, so the row must
    // be the token user's own. Checked once more here; fail closed.
    if (connector.user_id !== principal.userId) {
      return void rejectSourceNotConnected(res, source, "not_connected");
    }

    const signIn = await ensureUpstreamSignIn(
      connector,
      db,
      { refresh: "if_near_expiry", skewMs: REQUEST_REFRESH_SKEW_MS },
      deps,
    );
    if (signIn.state !== "connected") {
      return void rejectSourceNotConnected(res, source, signIn.state);
    }

    // The body is parsed only now, so a caller without a valid token cannot
    // make the server parse a large body.
    mcpJson(req, res, (parseError?: unknown) => {
      if (parseError) return next(parseError);
      handleMcpRequest(req, res, { principal, source, connector }, deps).catch(
        next,
      );
    });
  };

  router.all(
    "/:source",
    unauthLimiter,
    checkRoute,
    requireAgentToken,
    tokenLimiter,
    serveSource,
  );

  // Box file bytes. The same per-address limit for callers without a valid
  // token comes first, as on the MCP route. "/box/files" has two parts, so
  // the one-part "/:source" route above never sees it.
  router.use(
    "/box/files",
    unauthLimiter,
    createAgentBoxFilesRouter({
      deps,
      requireFileToken,
      tokenLimiter: fileTokenLimiter,
      rejectSourceNotConnected,
    }),
  );

  router.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  router.use(agentErrorHandler);
  return router;
}

async function handleMcpRequest(
  req: Request,
  res: Response,
  target: {
    principal: AgentPrincipal;
    source: AgentSource;
    connector: ConnectorRow;
  },
  deps: AgentGatewayDeps,
): Promise<void> {
  const db = deps.db();
  // A stateless transport cannot be reused, so both are made per request.
  const server = buildAgentMcpServer({ ...target, db, deps });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no session id
    enableJsonResponse: true, // always application/json
  });
  res.on("close", () => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  touchAgentTokenLastUsed(target.principal.tokenId, db, deps.now());
}

function createOpsRouter(deps: AgentGatewayDeps): Router {
  const ops = createAsyncRouter();

  ops.use(
    rateLimit({
      windowMs: OPS_RATE_LIMIT_WINDOW_MS,
      limit: OPS_RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
      message: { error: "rate_limited" },
    }),
  );

  // The ops token only opens /agent-mcp/ops. An agent token never does.
  // The status token opens one route of it: GET /status. It cannot mint,
  // revoke or provision.
  const requireOpsToken: RequestHandler = (req, res, next) => {
    const bearer = bearerOf(req);
    // A Box file token is known by its shape and is refused as such.
    if (bearer && agentTokenScopeOf(bearer) === "box_files") {
      return void rejectWrongTokenScope(res);
    }
    const statusOnly = req.method === "GET" && req.path === "/status";
    const ok =
      !!bearer &&
      (opsTokenMatches(bearer) || (statusOnly && statusTokenMatches(bearer)));
    if (!ok) {
      return void res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="docket-agent-ops"')
        .json({ error: "invalid_ops_token" });
    }
    next();
  };
  ops.use(requireOpsToken);
  ops.use(express.json({ limit: OPS_BODY_LIMIT }));

  /**
   * One log line for every mint, revoke and provision: who it was for, when
   * and from where. Never a token.
   */
  function logOpsAction(
    req: Request,
    action: "mint" | "revoke" | "provision",
    email: string,
    extra: Record<string, unknown> = {},
  ): void {
    console.info("[agent-gateway] ops action", {
      action,
      email,
      at: new Date(deps.now()).toISOString(),
      ip: req.ip ?? null,
      ...extra,
    });
  }

  /** Finds the user for an ops call, or answers the error and returns null. */
  async function userFor(rawEmail: unknown, res: Response): Promise<AgentUser | null> {
    const lookup = await findAgentUserByEmail(rawEmail, deps.db());
    if (lookup.ok) return lookup.user;
    res.status(agentUserLookupStatus(lookup.error)).json({ error: lookup.error });
    return null;
  }

  // GET /agent-mcp/ops/status?email=...&keepalive=1
  ops.get("/status", async (req, res) => {
    const emails = repeatedQueryValues(req.query.email);
    if (emails.length > MAX_STATUS_EMAILS) {
      return void res.status(400).json({ error: "too_many_emails" });
    }
    res.json(
      await buildAgentStatus({
        emails,
        keepalive: req.query.keepalive === "1",
        db: deps.db(),
        deps,
      }),
    );
  });

  // POST /agent-mcp/ops/tokens {"email": "..."}
  // Mints the pair: the agent token for the MCP routes and the Box file
  // token for the Box file routes. The only time either is ever returned.
  ops.post("/tokens", async (req, res) => {
    const user = await userFor(req.body?.email, res);
    if (!user) return;
    try {
      const minted = await mintAgentToken(user.id, deps.db());
      logOpsAction(req, "mint", user.email);
      res.status(201).json({
        token: minted.token,
        file_token: minted.fileToken,
        email: user.email,
        created_at: minted.createdAt,
      });
    } catch (err) {
      if (err instanceof AgentTokenRotationConflictError) {
        return void res.status(409).json({ error: "token_rotation_conflict" });
      }
      throw err;
    }
  });

  // DELETE /agent-mcp/ops/tokens?email=...
  ops.delete("/tokens", async (req, res) => {
    const user = await userFor(req.query.email, res);
    if (!user) return;
    const revoked = await revokeAgentTokens(user.id, deps.db());
    logOpsAction(req, "revoke", user.email, { revoked });
    res.json({ email: user.email, revoked });
  });

  // POST /agent-mcp/ops/provision {"email": "..."}
  // Says which connector rows the user's sources will use. PracticePanther
  // and Box are Docket's own rows: nothing is made for them. Only Quo, when
  // it is configured, gets a row here. Connects nothing: the user signs in
  // himself, in Docket.
  ops.post("/provision", async (req, res) => {
    const user = await userFor(req.body?.email, res);
    if (!user) return;
    const db = deps.db();
    const connectors = await provisionAgentConnectors(
      user.id,
      db,
      deps.validateServerUrl,
    );
    const states = await agentSourceStatuses(
      user.id,
      db,
      { refresh: "never", skewMs: 0 },
      deps,
    );
    logOpsAction(req, "provision", user.email, { connectors });
    res.json({
      email: user.email,
      sources: {
        practicepanther: {
          connector: connectors.practicepanther,
          state: states.practicepanther.state,
        },
        box: { connector: connectors.box, state: states.box.state },
        quo: { connector: connectors.quo, state: states.quo.state },
      },
    });
  });

  return ops;
}

/**
 * The gateway's own error boundary. Answers are fixed strings; they never
 * repeat request input. Nothing falls through to the rest of the app.
 */
const agentErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const type =
    error && typeof error === "object"
      ? (error as { type?: unknown }).type
      : undefined;
  if (res.headersSent) {
    console.error("[agent-gateway] error after the answer started", {
      method: req.method,
      error: safeErrorLog(error),
    });
    return void res.end();
  }
  if (type === "entity.too.large") {
    return void res.status(413).json({ error: "payload_too_large" });
  }
  const status =
    error && typeof error === "object"
      ? (error as { status?: unknown }).status
      : undefined;
  if (
    typeof type === "string" &&
    typeof status === "number" &&
    status >= 400 &&
    status < 500
  ) {
    // Every other body-parser refusal: the body could not be read as JSON.
    return void res.status(400).json({ error: "invalid_json" });
  }
  console.error("[agent-gateway] unexpected error", {
    method: req.method,
    error: safeErrorLog(error),
  });
  res.status(500).json({ error: "internal_error" });
};

export const agentMcpRouter = createAgentMcpRouter();
