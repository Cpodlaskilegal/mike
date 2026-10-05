// Docket Agent gateway: Box files, under /agent-mcp/box/files
//
// - GET  /agent-mcp/box/files/{file_id}            file details
// - GET  /agent-mcp/box/files/{file_id}/content    the exact bytes, streamed
// - POST /agent-mcp/box/files?parent_id=&name=     a NEW file in a folder
// - POST /agent-mcp/box/files/{file_id}/versions   a new VERSION of a file
//
// The credential is the user's Box file token (dkf_...). It opens these four
// routes and nothing else; an MCP token (dka_...) is refused here. Every call
// uses the Box sign-in of the token's own user: the same managed Box
// connector row and the same locked refresh the MCP side uses for Box.
//
// Uploads are off until DOCKET_AGENT_BOX_UPLOADS=on. No other change to Box
// exists on these routes: no delete, move, rename, copy, share link,
// collaboration or metadata write.
//
// Uploads are kept few, because they change Box and are held in memory:
// - a few at once in all, and fewer per token, so one token cannot take
//   every place and shut the other users out;
// - a body that is too large, or too slow, is given up without waiting for
//   the rest of it;
// - a small budget of uploads per token per window, apart from the budget
//   for reading;
// - a limit on new versions of one file per day, and no new version at all
//   when Box already holds the same bytes, so a repeated upload is safe.
//
// One audit row per call, with the user as actor: the action, the file or
// folder id, the size and the outcome. Never a file name and never bytes.

import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Request, RequestHandler, Response, Router } from "express";
import { createAsyncRouter } from "../middleware/asyncRouteErrors";
import {
  agentBoxMaxDownloadBytes,
  agentBoxMaxUploadBytes,
  agentBoxMaxUploadsPerWindow,
  agentBoxMaxVersionsPerDay,
  agentBoxUploadsEnabled,
  getBoxFile,
  getBoxFileVersion,
  isBoxFileName,
  isBoxId,
  normalizeSha1,
  openBoxDownload,
  preflightBoxNewFile,
  uploadToBox,
  type BoxFailure,
  type BoxUploadedFile,
} from "../lib/agentGateway/boxFiles";
import { agentMcpRateLimitWindowMs } from "../lib/agentGateway/config";
import type { AgentGatewayDeps } from "../lib/agentGateway/deps";
import { resolveAgentConnector } from "../lib/agentGateway/sources";
import {
  touchAgentTokenLastUsed,
  type AgentPrincipal,
} from "../lib/agentGateway/tokens";
import {
  ensureUpstreamSignIn,
  REQUEST_REFRESH_SKEW_MS,
} from "../lib/agentGateway/upstreamAuth";
import type { ConnectorRow, Db } from "../lib/mcp/types";
import { safeErrorLog } from "../lib/safeError";

export type AgentBoxFileAction =
  | "box_file_metadata"
  | "box_file_download"
  | "box_file_upload"
  | "box_file_new_version";

export type AgentBoxFilesRouterOptions = {
  deps: AgentGatewayDeps;
  /** Answers 401 or 403, or puts the file token's owner in res.locals. */
  requireFileToken: RequestHandler;
  /** The per-token request budget. */
  tokenLimiter: RequestHandler;
  rejectSourceNotConnected: (
    res: Response,
    source: "box",
    state: "not_connected" | "needs_reconnect",
  ) => void;
};

/** The download is given up when Box sends nothing for this long. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
/** Uploads are held in memory while they are checked, so only a few at once. */
const MAX_UPLOADS_IN_FLIGHT = 4;
/** And never all of them for one token: the other users must still get a turn. */
const MAX_UPLOADS_IN_FLIGHT_PER_TOKEN = 2;
/** Downloads are streamed, not held. Still, one token only has so many open. */
const MAX_DOWNLOADS_IN_FLIGHT_PER_TOKEN = 16;
const BUSY_RETRY_AFTER_SECONDS = "5";
const SHA1_HEADER = "x-docket-content-sha1";
/** Optional, on a new version: the sha1 of the file the caller started from. */
const BASE_SHA1_HEADER = "x-docket-base-sha1";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Added to the audit error of an upload that may or may not have been stored. */
const UNCERTAIN_SUFFIX = ": the outcome is uncertain";
/**
 * The audit errors of an upload that Box may hold all the same. They count
 * towards the new versions of a file per day.
 */
const MAYBE_STORED_ERRORS = [
  `box_upload_uncertain${UNCERTAIN_SUFFIX}`,
  "box_upload_unverified",
];
/** The integer column that holds the size cannot hold more than this. */
const MAX_INT4 = 2_147_483_647;

type AuditRefs = {
  file_id?: string;
  folder_id?: string;
  version_id?: string;
  /** Bytes, as a string like the other values. */
  size_bytes?: string;
  /** "true" on a new version that was not sent: Box already held the bytes. */
  unchanged?: string;
};

type FileCall = {
  principal: AgentPrincipal;
  connector: ConnectorRow;
  db: Db;
  action: AgentBoxFileAction;
  startedAt: number;
};

function onlyMethod(method: "GET" | "POST"): RequestHandler {
  return (req, res, next) => {
    if (req.method !== method) {
      return void res
        .status(405)
        .set("Allow", method)
        .json({ error: "method_not_allowed" });
    }
    next();
  };
}

/** One value of a query key, or null when it is missing or repeated. */
function queryString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The name for a header: percent-encoded UTF-8. */
function encodeHeaderName(name: string): string {
  // A lone surrogate cannot be encoded. It becomes the replacement character.
  return encodeURIComponent(
    name.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      "�",
    ),
  );
}

type RawBody = Buffer | "too_large" | "unreadable" | "timed_out";

/** The body size the request declares, or 0 when it declares none. */
function declaredLength(req: Request): number {
  const length = Number(req.headers["content-length"]);
  return Number.isFinite(length) && length > 0 ? length : 0;
}

/**
 * The request body as raw bytes, whatever its content type. It never waits
 * for a body it is not going to keep: it stops at the first byte past
 * `maxBytes`, and when `timeoutMs` is up. What is still to come after that
 * is thrown away, not held.
 */
function readRawBody(
  req: Request,
  maxBytes: number,
  timeoutMs: number,
): Promise<RawBody> {
  return new Promise((resolve) => {
    // The bytes hashed must be the bytes that were sent: nothing is decoded.
    const encoding = String(req.headers["content-encoding"] ?? "identity")
      .trim()
      .toLowerCase();
    if (encoding !== "identity") return resolve("unreadable");
    // The caller went away before the body was asked for: nothing will come.
    if (req.destroyed) return resolve("unreadable");

    const chunks: Buffer[] = [];
    let received = 0;
    const finish = (result: RawBody) => {
      clearTimeout(deadline);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onBroken);
      req.off("close", onBroken);
      if (!Buffer.isBuffer(result)) {
        chunks.length = 0;
        req.resume();
      }
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) return finish("too_large");
      chunks.push(chunk);
    };
    // An "end" without the whole message is a connection that broke.
    const onEnd = () =>
      finish(req.complete ? Buffer.concat(chunks, received) : "unreadable");
    const onBroken = () => finish("unreadable");
    const deadline = setTimeout(() => finish("timed_out"), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onBroken);
    req.once("close", onBroken);
  });
}

/**
 * For an answer that did not wait for the request body. Once the answer is
 * out, the rest of the body may still arrive for `graceMs` (it is thrown
 * away, and the caller gets to read the answer). After that the connection
 * is cut, so a caller cannot keep it open by sending a body slowly.
 */
function cutUnreadBody(req: Request, res: Response, graceMs: number): void {
  res.once("finish", () => {
    if (req.complete || req.destroyed) return;
    const cut = setTimeout(() => req.destroy(), graceMs);
    cut.unref();
    req.once("end", () => clearTimeout(cut));
    req.once("close", () => clearTimeout(cut));
  });
}

/**
 * Counts what is under way: in all, and per token. One token never holds
 * every place.
 */
function createInFlight(maxInAll: number, maxPerToken: number) {
  let inAll = 0;
  const perToken = new Map<string, number>();
  return {
    /**
     * Takes a place, or returns null when there is none. The function it
     * returns gives the place back; calling it twice gives it back once.
     */
    take(tokenId: string): (() => void) | null {
      const mine = perToken.get(tokenId) ?? 0;
      if (inAll >= maxInAll || mine >= maxPerToken) return null;
      inAll += 1;
      perToken.set(tokenId, mine + 1);
      let given = false;
      return () => {
        if (given) return;
        given = true;
        inAll -= 1;
        const left = (perToken.get(tokenId) ?? 1) - 1;
        if (left > 0) perToken.set(tokenId, left);
        else perToken.delete(tokenId);
      };
    },
  };
}

/** A count per key per window of time, kept in this process. */
function createWindowBudget(now: () => number) {
  const windows = new Map<string, { count: number; until: number; refused: boolean }>();
  return {
    /**
     * Counts one. `wait` is 0 when it fits, else the seconds until the
     * window ends. `first` is true on the first refusal of a window.
     */
    take(key: string, max: number, windowMs: number): { wait: number; first: boolean } {
      const at = now();
      for (const [other, window] of windows) {
        if (window.until <= at) windows.delete(other);
      }
      const window = windows.get(key);
      if (!window) {
        windows.set(key, { count: 1, until: at + windowMs, refused: false });
        return { wait: 0, first: false };
      }
      if (window.count < max) {
        window.count += 1;
        return { wait: 0, first: false };
      }
      const first = !window.refused;
      window.refused = true;
      return { wait: Math.max(1, Math.ceil((window.until - at) / 1000)), first };
    },
  };
}

export function createAgentBoxFilesRouter(
  options: AgentBoxFilesRouterOptions,
): Router {
  const { deps, requireFileToken, tokenLimiter, rejectSourceNotConnected } =
    options;
  const router = createAsyncRouter();
  const uploadsInFlight = createInFlight(
    MAX_UPLOADS_IN_FLIGHT,
    MAX_UPLOADS_IN_FLIGHT_PER_TOKEN,
  );
  const downloadsInFlight = createInFlight(
    Number.POSITIVE_INFINITY,
    MAX_DOWNLOADS_IN_FLIGHT_PER_TOKEN,
  );
  const uploadBudget = createWindowBudget(deps.now);

  function auditRow(
    call: FileCall,
    kind: "read" | "mutation",
    row: { status: "pending" | "ok" | "error"; error?: string | null; refs: AuditRefs; bytes: number },
  ) {
    return {
      user_id: call.principal.userId,
      connector_id: call.connector.id,
      tool_id: null,
      tool_name: call.action,
      openai_tool_name: call.action,
      actor_email: call.principal.email,
      action_kind: kind,
      status: row.status,
      error_message: row.error ?? null,
      duration_ms: Math.max(0, deps.now() - call.startedAt),
      result_size_chars: Math.min(row.bytes, MAX_INT4),
      target_refs: row.refs,
      practicepanther_audit_status: "not_required",
      origin: "docket_agent",
      agent_token_id: call.principal.tokenId,
    };
  }

  /**
   * The one audit row of a call that changes nothing in Box. A failed
   * insert is logged and does not change the answer.
   */
  async function writeAudit(
    call: FileCall,
    kind: "read" | "mutation",
    row: { status: "ok" | "error"; error?: string | null; refs: AuditRefs; bytes?: number },
  ): Promise<void> {
    try {
      const { error } = await call.db
        .from("user_mcp_tool_audit_logs")
        .insert(auditRow(call, kind, { ...row, bytes: row.bytes ?? 0 }));
      if (error) throw new Error("audit insert failed");
    } catch (err) {
      console.error("[agent-gateway] failed to write audit log", {
        userId: call.principal.userId,
        tokenId: call.principal.tokenId,
        action: call.action,
        error: safeErrorLog(err),
      });
    }
  }

  /**
   * The pending audit row of an upload. It is written before Box is asked
   * anything. null means it could not be written: the upload is not sent.
   */
  async function beginUploadAudit(
    call: FileCall,
    refs: AuditRefs,
    bytes: number,
  ): Promise<string | null> {
    try {
      const id = randomUUID();
      const { data, error } = await call.db
        .from("user_mcp_tool_audit_logs")
        .insert({ ...auditRow(call, "mutation", { status: "pending", refs, bytes }), id })
        .select("id")
        .single();
      if (error || !data) return null;
      return String((data as { id?: unknown }).id ?? id);
    } catch {
      return null;
    }
  }

  async function closeUploadAudit(
    call: FileCall,
    auditId: string,
    row: {
      status: "ok" | "error";
      error?: string | null;
      refs: AuditRefs;
      /** Only to say that the call changed nothing after all. */
      kind?: "read";
    },
  ): Promise<void> {
    try {
      const { error } = await call.db
        .from("user_mcp_tool_audit_logs")
        .update({
          ...(row.kind ? { action_kind: row.kind } : {}),
          status: row.status,
          error_message: row.error ?? null,
          duration_ms: Math.max(0, deps.now() - call.startedAt),
          target_refs: row.refs,
          updated_at: new Date(deps.now()).toISOString(),
        })
        .eq("id", auditId);
      if (error) throw new Error("audit update failed");
    } catch (err) {
      console.error("[agent-gateway] failed to close audit log", {
        userId: call.principal.userId,
        tokenId: call.principal.tokenId,
        action: call.action,
        auditId,
        error: safeErrorLog(err),
      });
    }
  }

  /**
   * How many new versions of this file the user's sessions added in the
   * last 24 hours, read from the audit rows, so it holds across restarts
   * and across backend processes. Counted: uploads that were stored, that
   * are still under way, or whose outcome is not known. Not counted: the
   * row of the call that is asking, refusals, and uploads that were not
   * sent because Box already held the bytes. Stops counting at `upTo`.
   * null means the rows could not be read.
   */
  async function recentNewVersions(
    call: FileCall,
    fileId: string,
    ownAuditId: string,
    upTo: number,
  ): Promise<number | null> {
    const since = new Date(deps.now() - DAY_MS).toISOString();
    const rows = () =>
      call.db
        .from("user_mcp_tool_audit_logs")
        .select("id")
        .eq("user_id", call.principal.userId)
        .eq("origin", "docket_agent")
        .eq("tool_name", "box_file_new_version")
        .eq("action_kind", "mutation")
        .contains("target_refs", { file_id: fileId })
        .gt("created_at", since)
        .neq("id", ownAuditId);
    try {
      const sent = await rows().neq("status", "error").limit(upTo);
      if (sent.error || !Array.isArray(sent.data)) return null;
      if (sent.data.length >= upTo) return sent.data.length;
      const unsure = await rows()
        .eq("status", "error")
        .in("error_message", MAYBE_STORED_ERRORS)
        .limit(upTo);
      if (unsure.error || !Array.isArray(unsure.data)) return null;
      return sent.data.length + unsure.data.length;
    } catch {
      return null;
    }
  }

  /** The token user's own managed Box row, or null. Never another user's. */
  async function ownBoxConnector(
    principal: AgentPrincipal,
    db: Db,
  ): Promise<ConnectorRow | null> {
    const resolved = await resolveAgentConnector(principal.userId, "box", db);
    if (!resolved.ok) return null;
    // The sign-in is read from the row's owner, so the row must be the
    // token user's own. Checked once more here; fail closed.
    return resolved.connector.user_id === principal.userId
      ? resolved.connector
      : null;
  }

  /**
   * The call, for a refusal made before the sign-in is looked at. null when
   * the user has no Box row to record it on.
   */
  async function unopenedCall(
    res: Response,
    action: AgentBoxFileAction,
  ): Promise<FileCall | null> {
    const principal = res.locals.agentPrincipal as AgentPrincipal;
    const db = deps.db();
    const connector = await ownBoxConnector(principal, db);
    return connector
      ? { principal, connector, db, action, startedAt: deps.now() }
      : null;
  }

  /**
   * The start of every call: the user's own Box row, a sign-in that is
   * good for a while yet (refreshed under the lock when it is not), and the
   * Box token read from it. Answers 401 and returns null when any is missing.
   */
  async function openUserBox(
    res: Response,
    action: AgentBoxFileAction,
  ): Promise<{ call: FileCall; accessToken: string } | null> {
    const principal = res.locals.agentPrincipal as AgentPrincipal;
    const db = deps.db();
    const startedAt = deps.now();
    touchAgentTokenLastUsed(principal.tokenId, db, startedAt);

    const connector = await ownBoxConnector(principal, db);
    if (!connector) {
      rejectSourceNotConnected(res, "box", "not_connected");
      return null;
    }
    const signIn = await ensureUpstreamSignIn(
      connector,
      db,
      { refresh: "if_near_expiry", skewMs: REQUEST_REFRESH_SKEW_MS },
      deps,
    );
    if (signIn.state !== "connected") {
      rejectSourceNotConnected(res, "box", signIn.state);
      return null;
    }
    const accessToken = await deps.boxAccessToken(connector, db);
    if (!accessToken) {
      rejectSourceNotConnected(res, "box", "needs_reconnect");
      return null;
    }
    return { call: { principal, connector, db, action, startedAt }, accessToken };
  }

  /** Answers a Box call that did not work. Never with Box's own body. */
  function answerBoxFailure(res: Response, call: FileCall, failure: BoxFailure): void {
    if (failure.status >= 500) {
      console.warn("[agent-gateway] box file call failed", {
        userId: call.principal.userId,
        tokenId: call.principal.tokenId,
        action: call.action,
        error: failure.error,
      });
    }
    // Box refused the stored sign-in: the user has to connect Box again.
    if (failure.status === 401) {
      return void rejectSourceNotConnected(res, "box", "needs_reconnect");
    }
    if (failure.retryAfter) res.set("Retry-After", String(failure.retryAfter));
    res
      .status(failure.status)
      .json(
        failure.error === "name_exists"
          ? { error: "name_exists", id: failure.conflictId ?? null }
          : { error: failure.error },
      );
  }

  // GET /agent-mcp/box/files/{file_id}
  const metadata: RequestHandler = async (req, res) => {
    const fileId = req.params.fileId;
    if (!isBoxId(fileId)) {
      return void res.status(400).json({ error: "invalid_file_id" });
    }
    const opened = await openUserBox(res, "box_file_metadata");
    if (!opened) return;
    const { call, accessToken } = opened;

    const found = await getBoxFile(deps.boxFetch, accessToken, fileId);
    if (!found.ok) {
      await writeAudit(call, "read", {
        status: "error",
        error: found.error,
        refs: { file_id: fileId },
      });
      return void answerBoxFailure(res, call, found);
    }
    const file = found.file;
    await writeAudit(call, "read", {
      status: "ok",
      refs: { file_id: fileId, size_bytes: String(file.size) },
    });
    res.json({
      id: file.id,
      name: file.name,
      size: file.size,
      sha1: file.sha1,
      modified_at: file.modified_at,
      parent: file.parent,
      path: file.path,
    });
  };

  // GET /agent-mcp/box/files/{file_id}/content[?version=<box version id>]
  const download: RequestHandler = async (req, res) => {
    const fileId = req.params.fileId;
    if (!isBoxId(fileId)) {
      return void res.status(400).json({ error: "invalid_file_id" });
    }
    const wantedVersion =
      req.query.version === undefined ? null : queryString(req.query.version);
    if (req.query.version !== undefined && !isBoxId(wantedVersion)) {
      return void res.status(400).json({ error: "invalid_version" });
    }
    // One token only has so many downloads open at once.
    const principal = res.locals.agentPrincipal as AgentPrincipal;
    const release = downloadsInFlight.take(principal.tokenId);
    if (!release) {
      return void res
        .status(503)
        .set("Retry-After", BUSY_RETRY_AFTER_SECONDS)
        .json({ error: "downloads_busy" });
    }
    try {
      await sendFile(res, fileId, wantedVersion);
    } finally {
      release();
    }
  };

  /** The download itself, once it has its place. */
  async function sendFile(
    res: Response,
    fileId: string,
    wantedVersion: string | null,
  ): Promise<void> {
    const opened = await openUserBox(res, "box_file_download");
    if (!opened) return;
    const { call, accessToken } = opened;
    const refs: AuditRefs = {
      file_id: fileId,
      ...(wantedVersion ? { version_id: wantedVersion } : {}),
    };
    const fail = async (failure: BoxFailure) => {
      await writeAudit(call, "read", { status: "error", error: failure.error, refs });
      answerBoxFailure(res, call, failure);
    };

    // What Box says the file is: its name, its size and its sha1. The bytes
    // are checked against these on the way through.
    const found = await getBoxFile(deps.boxFetch, accessToken, fileId);
    if (!found.ok) return void (await fail(found));
    let expected = {
      name: found.file.name,
      size: found.file.size,
      sha1: found.file.sha1,
    };
    // An earlier version is asked for by its id. The current one is the
    // plain download.
    let earlierVersion: string | null = null;
    if (wantedVersion && wantedVersion !== found.file.versionId) {
      const version = await getBoxFileVersion(
        deps.boxFetch,
        accessToken,
        fileId,
        wantedVersion,
      );
      if (!version.ok) return void (await fail(version));
      expected = {
        name: version.version.name ?? found.file.name,
        size: version.version.size,
        sha1: version.version.sha1,
      };
      earlierVersion = wantedVersion;
    } else if (found.file.versionId) {
      refs.version_id = found.file.versionId;
    }
    refs.size_bytes = String(expected.size);

    // The size cap, before any bytes are asked for.
    const maxBytes = agentBoxMaxDownloadBytes();
    if (expected.size > maxBytes) {
      await writeAudit(call, "read", { status: "error", error: "file_too_large", refs });
      return void res
        .status(413)
        .json({ error: "file_too_large", size: expected.size, max_bytes: maxBytes });
    }

    // The download is given up when nothing moves for a while, and at once
    // when the caller goes away.
    const abort = new AbortController();
    let idle = setTimeout(() => abort.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
    const stillAlive = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(), DOWNLOAD_IDLE_TIMEOUT_MS);
    };
    const onClose = () => {
      if (!res.writableFinished) abort.abort();
    };
    res.on("close", onClose);

    let sent = 0;
    let outcome: "ok" | "box_download_mismatch" | "box_download_failed" = "ok";
    try {
      const source = await openBoxDownload(
        deps.boxFetch,
        accessToken,
        fileId,
        earlierVersion,
        abort.signal,
      );
      if (!source.ok) return void (await fail(source));
      stillAlive();
      const upstream = source.response;
      const declared = upstream.headers.get("content-length");
      if (
        !upstream.headers.get("content-encoding") &&
        declared !== null &&
        Number(declared) !== expected.size
      ) {
        // The file changed between the two calls. Nothing is sent.
        await upstream.body?.cancel().catch(() => undefined);
        return void (await fail({
          ok: false,
          status: 502,
          error: "box_download_mismatch",
        }));
      }

      const startAnswer = () => {
        res.status(200);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", String(expected.size));
        res.setHeader("X-Docket-File-Name", encodeHeaderName(expected.name));
        res.setHeader("X-Docket-File-Sha1", expected.sha1);
        res.setHeader("X-Docket-File-Size", String(expected.size));
      };
      const write = async (chunk: Uint8Array) => {
        if (!res.headersSent) startAnswer();
        // A caller that reads slowly holds Box back; one that stops
        // reading altogether ends the download when the idle time is up.
        if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
        stillAlive();
        sent += chunk.byteLength;
      };

      // The bytes go to the caller as they arrive, one chunk behind. The
      // last chunk is held back until the count and the sha1 of everything
      // received match what Box reported. So a caller never gets a complete
      // answer whose bytes are not the file. Nothing is kept but one chunk.
      const reader = upstream.body!.getReader();
      const hash = createHash("sha1");
      let received = 0;
      let held: Uint8Array | null = null;
      try {
        for (;;) {
          const chunk = await reader.read();
          // The caller went away, or nothing moved for too long.
          abort.signal.throwIfAborted();
          if (chunk.done) break;
          if (!chunk.value.byteLength) continue;
          stillAlive();
          received += chunk.value.byteLength;
          if (received > expected.size) {
            outcome = "box_download_mismatch";
            break;
          }
          hash.update(chunk.value);
          if (held) await write(held);
          held = chunk.value;
        }
        if (
          outcome === "ok" &&
          (received !== expected.size || hash.digest("hex") !== expected.sha1)
        ) {
          outcome = "box_download_mismatch";
        }
        if (outcome === "ok") {
          if (held) await write(held);
          else if (!res.headersSent) startAnswer(); // an empty file
          res.end();
        }
      } finally {
        if (outcome !== "ok") await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch (err) {
      outcome = "box_download_failed";
      console.warn("[agent-gateway] box download stopped", {
        userId: call.principal.userId,
        tokenId: call.principal.tokenId,
        error: safeErrorLog(err),
      });
    } finally {
      clearTimeout(idle);
      res.off("close", onClose);
    }

    if (outcome === "ok") {
      return void (await writeAudit(call, "read", { status: "ok", refs, bytes: sent }));
    }
    await writeAudit(call, "read", { status: "error", error: outcome, refs, bytes: sent });
    if (outcome === "box_download_mismatch") {
      console.warn("[agent-gateway] box download did not match Box's sha1 or size", {
        userId: call.principal.userId,
        tokenId: call.principal.tokenId,
        fileId,
      });
    }
    if (res.headersSent) {
      // Part of the file is on its way. Cut the connection, so the caller
      // sees a broken download and not a short file.
      return void res.destroy();
    }
    if (!res.destroyed) res.status(502).json({ error: outcome });
  }

  /** What the two upload routes share once the target is known. */
  async function upload(
    req: Request,
    res: Response,
    action: "box_file_upload" | "box_file_new_version",
    target: { kind: "new_file"; parentId: string; name: string } | { kind: "new_version"; fileId: string },
  ): Promise<void> {
    const principal = res.locals.agentPrincipal as AgentPrincipal;
    const baseRefs: AuditRefs =
      target.kind === "new_file"
        ? { folder_id: target.parentId }
        : { file_id: target.fileId };
    const claimedSha1 = normalizeSha1(req.headers[SHA1_HEADER]);
    if (!claimedSha1) {
      return void res.status(400).json({ error: "invalid_sha1" });
    }
    // Optional, and only for a new version: the sha1 of the file the caller
    // started from. Given, it must still be what Box holds.
    const givenBase =
      target.kind === "new_version" ? req.headers[BASE_SHA1_HEADER] : undefined;
    const baseSha1 = givenBase === undefined ? null : normalizeSha1(givenBase);
    if (givenBase !== undefined && !baseSha1) {
      return void res.status(400).json({ error: "invalid_base_sha1" });
    }
    const maxBytes = agentBoxMaxUploadBytes();

    // A body that says it is too large is refused at once. It takes no
    // place and it is not read.
    if (declaredLength(req) > maxBytes) {
      const call = await unopenedCall(res, action);
      if (call) {
        await writeAudit(call, "mutation", {
          status: "error",
          error: "payload_too_large",
          refs: baseRefs,
        });
      }
      return void res
        .status(413)
        .json({ error: "payload_too_large", max_bytes: maxBytes });
    }

    // A place: a few uploads at once in all, and fewer for one token.
    const release = uploadsInFlight.take(principal.tokenId);
    if (!release) {
      return void res
        .status(503)
        .set("Retry-After", BUSY_RETRY_AFTER_SECONDS)
        .json({ error: "uploads_busy" });
    }
    try {
      // The token's upload budget. An upload that got a place counts,
      // whatever becomes of it.
      const budget = uploadBudget.take(
        principal.tokenId,
        agentBoxMaxUploadsPerWindow(),
        agentMcpRateLimitWindowMs(),
      );
      if (budget.wait) {
        if (budget.first) {
          console.warn("[agent-gateway] box upload budget used up", {
            userId: principal.userId,
            tokenId: principal.tokenId,
            action,
          });
        }
        return void res
          .status(429)
          .set("Retry-After", String(budget.wait))
          .json({ error: "upload_rate_limited" });
      }

      const opened = await openUserBox(res, action);
      if (!opened) return;
      const { call, accessToken } = opened;

      const body = await readRawBody(req, maxBytes, deps.boxUploadTimeouts.bodyMs);
      if (body === "too_large") {
        await writeAudit(call, "mutation", {
          status: "error",
          error: "payload_too_large",
          refs: baseRefs,
        });
        return void res
          .status(413)
          .json({ error: "payload_too_large", max_bytes: maxBytes });
      }
      if (body === "timed_out") {
        // The body did not arrive in time. The request is given up: the
        // connection is closed with the answer, and the place is free again.
        await writeAudit(call, "mutation", {
          status: "error",
          error: "upload_timeout",
          refs: baseRefs,
        });
        return void res
          .status(408)
          .set("Connection", "close")
          .json({ error: "upload_timeout" });
      }
      if (body === "unreadable" || body.length === 0) {
        const error = body === "unreadable" ? "invalid_body" : "empty_body";
        await writeAudit(call, "mutation", { status: "error", error, refs: baseRefs });
        return void res.status(400).json({ error });
      }
      const refs: AuditRefs = { ...baseRefs, size_bytes: String(body.length) };

      // The bytes that arrived must be the bytes the caller meant to send.
      // Checked before Box is asked anything.
      const sha1 = createHash("sha1").update(body).digest("hex");
      if (sha1 !== claimedSha1) {
        await writeAudit(call, "mutation", { status: "error", error: "sha1_mismatch", refs });
        return void res.status(400).json({ error: "sha1_mismatch" });
      }

      // The audit row first. If it cannot be written, nothing is sent.
      const auditId = await beginUploadAudit(call, refs, body.length);
      if (!auditId) {
        console.error("[agent-gateway] upload blocked: no audit row", {
          userId: call.principal.userId,
          tokenId: call.principal.tokenId,
          action,
        });
        return void res.status(503).json({ error: "audit_unavailable" });
      }
      const refuse = async (failure: BoxFailure) => {
        await closeUploadAudit(call, auditId, {
          status: "error",
          error: failure.uncertain
            ? `${failure.error}${UNCERTAIN_SUFFIX}`
            : failure.error,
          refs,
        });
        answerBoxFailure(res, call, failure);
      };
      /** A refusal of the gateway's own. Nothing was sent to Box. */
      const stop = async (
        status: number,
        answer: { error: string } & Record<string, unknown>,
      ) => {
        await closeUploadAudit(call, auditId, {
          status: "error",
          error: answer.error,
          refs,
        });
        res.status(status).json(answer);
      };

      let ifMatch: string | null = null;
      if (target.kind === "new_file") {
        // Is the name free? Asked first, so a taken name costs no upload.
        const free = await preflightBoxNewFile(deps.boxFetch, accessToken, {
          parentId: target.parentId,
          name: target.name,
          size: body.length,
        });
        if (!free.ok) return void (await refuse(free));
      } else {
        // What does Box hold now? Asked first, like the name of a new file.
        const found = await getBoxFile(deps.boxFetch, accessToken, target.fileId);
        if (!found.ok) return void (await refuse(found));
        const current = found.file;
        if (current.sha1 === sha1 && current.size === body.length) {
          // Box already holds exactly these bytes as the current version.
          // Nothing is sent, so sending an upload again (after an answer
          // that was lost, say) never adds a second copy.
          await closeUploadAudit(call, auditId, {
            status: "ok",
            kind: "read",
            refs: {
              ...refs,
              ...(current.versionId ? { version_id: current.versionId } : {}),
              unchanged: "true",
            },
          });
          return void res.status(200).json({
            id: current.id,
            name: current.name,
            size: current.size,
            sha1: current.sha1,
            parent: current.parent,
            version_id: current.versionId,
            unchanged: true,
          });
        }
        if (baseSha1 && current.sha1 !== baseSha1) {
          // Someone saved another version since the caller fetched the file.
          return void (await stop(409, { error: "box_file_changed" }));
        }
        // Only so many new versions of one file in a day.
        const maxPerDay = agentBoxMaxVersionsPerDay();
        const recent = await recentNewVersions(call, target.fileId, auditId, maxPerDay);
        if (recent === null) {
          return void (await stop(503, { error: "audit_unavailable" }));
        }
        if (recent >= maxPerDay) {
          console.warn("[agent-gateway] box new version limit reached", {
            userId: call.principal.userId,
            tokenId: call.principal.tokenId,
            fileId: target.fileId,
          });
          return void (await stop(429, {
            error: "version_limit_reached",
            max_per_day: maxPerDay,
          }));
        }
        // The upload is tied to the state just read: without Box's mark of
        // it, nothing is sent.
        if (!current.etag) return void (await stop(502, { error: "box_error" }));
        ifMatch = current.etag;
      }

      const sentToBox = await uploadToBox(deps.boxFetch, accessToken, {
        bytes: body,
        sha1,
        ...(target.kind === "new_version" ? { ...target, ifMatch } : target),
      });
      if (!sentToBox.ok) return void (await refuse(sentToBox));
      const file: BoxUploadedFile = sentToBox.file;
      const doneRefs: AuditRefs = {
        ...refs,
        file_id: file.id,
        ...(file.versionId ? { version_id: file.versionId } : {}),
      };
      if (file.sha1 !== sha1 || file.size !== body.length) {
        // Box holds something else than was sent. It should not happen:
        // Box checks the sha1 itself. Say so plainly rather than answer 201.
        await closeUploadAudit(call, auditId, {
          status: "error",
          error: "box_upload_unverified",
          refs: doneRefs,
        });
        return void res.status(502).json({ error: "box_upload_unverified", id: file.id });
      }
      await closeUploadAudit(call, auditId, { status: "ok", refs: doneRefs });
      res.status(201).json({
        id: file.id,
        name: file.name,
        size: file.size,
        sha1: file.sha1,
        parent: file.parent,
        ...(target.kind === "new_version" ? { version_id: file.versionId } : {}),
      });
    } finally {
      release();
    }
  }

  /**
   * The upload switch. While it is off both upload routes answer 403, and
   * the refusal is recorded when the user has a Box row to record it on.
   */
  async function uploadsOff(
    res: Response,
    action: "box_file_upload" | "box_file_new_version",
    refs: AuditRefs,
  ): Promise<boolean> {
    if (agentBoxUploadsEnabled()) return false;
    const call = await unopenedCall(res, action);
    if (call) {
      await writeAudit(call, "mutation", {
        status: "error",
        error: "Denied by Docket Agent gateway: box_uploads_off",
        refs,
      });
    }
    res.status(403).json({ error: "box_uploads_off" });
    return true;
  }

  // POST /agent-mcp/box/files?parent_id=<folder id>&name=<file name>
  const uploadNewFile: RequestHandler = async (req, res) => {
    // Many answers below do not wait for the body. None of them leaves the
    // connection open for a body that keeps coming.
    cutUnreadBody(req, res, deps.boxUploadTimeouts.unreadBodyGraceMs);
    const parentId = queryString(req.query.parent_id);
    if (await uploadsOff(res, "box_file_upload", isBoxId(parentId) ? { folder_id: parentId } : {})) {
      return;
    }
    if (!isBoxId(parentId)) {
      return void res.status(400).json({ error: "invalid_parent_id" });
    }
    // Express has already undone the percent-encoding.
    const name = queryString(req.query.name);
    if (!isBoxFileName(name)) {
      return void res.status(400).json({ error: "invalid_name" });
    }
    await upload(req, res, "box_file_upload", { kind: "new_file", parentId, name });
  };

  // POST /agent-mcp/box/files/{file_id}/versions
  const uploadNewVersion: RequestHandler = async (req, res) => {
    cutUnreadBody(req, res, deps.boxUploadTimeouts.unreadBodyGraceMs);
    const fileId = req.params.fileId;
    if (await uploadsOff(res, "box_file_new_version", isBoxId(fileId) ? { file_id: fileId } : {})) {
      return;
    }
    if (!isBoxId(fileId)) {
      return void res.status(400).json({ error: "invalid_file_id" });
    }
    await upload(req, res, "box_file_new_version", { kind: "new_version", fileId });
  };

  // A wrong method is answered before any token work, as on the MCP route.
  // Any other path under /box/files falls through to the gateway's 404.
  const guard = (method: "GET" | "POST"): RequestHandler[] => [
    onlyMethod(method),
    requireFileToken,
    tokenLimiter,
  ];
  router.all("/", ...guard("POST"), uploadNewFile);
  router.all("/:fileId", ...guard("GET"), metadata);
  router.all("/:fileId/content", ...guard("GET"), download);
  router.all("/:fileId/versions", ...guard("POST"), uploadNewVersion);

  return router;
}
