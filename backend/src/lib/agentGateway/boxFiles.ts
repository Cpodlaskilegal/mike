// Box files for Docket Agent: the exact bytes of a file out, and work
// product in. Everything here is done with the Box sign-in of the user the
// file token belongs to. Box decides what that user may read or write.
//
// Only these Box calls exist, and only to two fixed hosts:
//   GET     https://api.box.com/2.0/files/{id}                    file details
//   GET     https://api.box.com/2.0/files/{id}/versions/{version} version details
//   GET     https://api.box.com/2.0/files/{id}/content            the bytes
//   OPTIONS https://api.box.com/2.0/files/content                 may this name be used
//   POST    https://upload.box.com/api/2.0/files/content          a new file
//   POST    https://upload.box.com/api/2.0/files/{id}/content     a new version
// A new version is sent with If-Match: Box takes it only when the file is
// still the one the gateway looked at a moment before.
// There is no delete, move, rename, copy, share link, collaboration or
// metadata write. No host or path is ever taken from the request: ids are
// digits only and are put into fixed URLs.
//
// The download is redirected by Box to its own download hosts. A redirect is
// followed only there, and the user's Box token is never sent with it.

import { mcpOAuthCallbackUrl } from "../mcp/client";
import { downloadUrl as boxDownloadUrl } from "../mcp/boxFileContent";
import { boxMcpServerUrl } from "../mcp/defaults";
import { DbMcpOAuthProvider } from "../mcp/oauth";
import type { ConnectorRow, Db } from "../mcp/types";

const BOX_API_ORIGIN = "https://api.box.com";
const BOX_UPLOAD_ORIGIN = "https://upload.box.com";

const MB = 1024 * 1024;
const DEFAULT_MAX_DOWNLOAD_MB = 200;
const DEFAULT_MAX_UPLOAD_MB = 50;
const DEFAULT_MAX_UPLOADS_PER_WINDOW = 30;
const DEFAULT_MAX_VERSIONS_PER_DAY = 10;
/** Box's limit for an upload sent in one request. The gateway sends no other kind. */
const BOX_SIMPLE_UPLOAD_LIMIT_MB = 50;

const BOX_JSON_TIMEOUT_MS = 30_000;
// Shorter than the four minutes the hosting ingress gives one request, so
// the caller gets the gateway's own answer and not a cut connection.
const BOX_UPLOAD_TIMEOUT_MS = 3 * 60_000;
const MAX_BOX_JSON_BYTES = MB;
const MAX_DOWNLOAD_REDIRECTS = 3;

const BOX_ID = /^\d{1,30}$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;

const FILE_FIELDS =
  "id,type,etag,name,size,sha1,modified_at,parent,path_collection,file_version";
const VERSION_FIELDS = "id,type,name,size,sha1,modified_at";
const UPLOAD_FIELDS = "id,type,name,size,sha1,parent,file_version";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The upload switch. Off unless the env var says "on". */
export function agentBoxUploadsEnabled(): boolean {
  return (
    (process.env.DOCKET_AGENT_BOX_UPLOADS ?? "").trim().toLowerCase() === "on"
  );
}

/** A larger file answers 413 before any bytes are fetched. */
export function agentBoxMaxDownloadBytes(): number {
  return envInt("DOCKET_AGENT_BOX_MAX_DOWNLOAD_MB", DEFAULT_MAX_DOWNLOAD_MB) * MB;
}

/**
 * A larger upload answers 413. Never above Box's own limit for an upload
 * sent in one request, whatever the env var says.
 */
export function agentBoxMaxUploadBytes(): number {
  return (
    Math.min(
      envInt("DOCKET_AGENT_BOX_MAX_UPLOAD_MB", DEFAULT_MAX_UPLOAD_MB),
      BOX_SIMPLE_UPLOAD_LIMIT_MB,
    ) * MB
  );
}

/**
 * How many uploads one Box file token may send per rate-limit window. Far
 * fewer than it may read: an upload changes Box.
 */
export function agentBoxMaxUploadsPerWindow(): number {
  return envInt("DOCKET_AGENT_BOX_MAX_UPLOADS_PER_WINDOW", DEFAULT_MAX_UPLOADS_PER_WINDOW);
}

/**
 * How many new versions of one file a user's sessions may add in 24 hours.
 * Box keeps only so many earlier versions (the number depends on the plan),
 * so a run of new versions could push the real ones out of the history.
 */
export function agentBoxMaxVersionsPerDay(): number {
  return envInt("DOCKET_AGENT_BOX_MAX_VERSIONS_PER_DAY", DEFAULT_MAX_VERSIONS_PER_DAY);
}

/** The "box_files" part of the ops status answer. */
export function agentBoxFilesStatus(): { download: boolean; upload: boolean } {
  // Box is one switch for the whole backend. With it off there is no Box
  // sign-in to use, so neither direction works.
  const boxOn = boxMcpServerUrl() !== null;
  return { download: boxOn, upload: boxOn && agentBoxUploadsEnabled() };
}

export function isBoxId(value: unknown): value is string {
  return typeof value === "string" && BOX_ID.test(value);
}

/** A sha1 in lower-case hex, or null. */
export function normalizeSha1(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sha1 = value.trim().toLowerCase();
  return SHA1_HEX.test(sha1) ? sha1 : null;
}

/**
 * A file name Box will take: 1 to 255 characters, no slash or backslash,
 * no control character, no space at either end, and not "." or "..".
 */
export function isBoxFileName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 255) return false;
  if (value !== value.trim() || value === "." || value === "..") return false;
  return !/[\\/\u0000-\u001f\u007f]/.test(value);
}

/**
 * The stored Box access token of the connector's owner. This is the same
 * read Docket's own MCP client makes. It never refreshes: the gateway
 * refreshes before, one at a time, under the lock.
 */
export async function defaultBoxAccessToken(
  connector: ConnectorRow,
  db: Db,
): Promise<string | null> {
  const provider = new DbMcpOAuthProvider(
    db,
    connector,
    connector.user_id,
    "use",
    mcpOAuthCallbackUrl(),
  );
  const tokens = await provider.tokens();
  return tokens?.access_token || null;
}

/**
 * A Box call that did not work, as the gateway answers it. `error` is one
 * of the gateway's own fixed words. Nothing Box said is carried along,
 * except the id of the file that already has the name.
 */
export type BoxFailure = {
  ok: false;
  /** The HTTP status the gateway answers. */
  status: number;
  error: string;
  /** Box asked to wait this many seconds. */
  retryAfter?: number;
  /** Only with `name_exists`: the id of the file that has the name. */
  conflictId?: string | null;
  /** The change may or may not have been made. */
  uncertain?: boolean;
};

export type BoxFileInfo = {
  id: string;
  name: string;
  size: number;
  sha1: string;
  modified_at: string | null;
  parent: { id: string; name: string } | null;
  /** Folder names from the root down to the parent. Not the file's own name. */
  path: string[];
  /** The id of the current version. */
  versionId: string | null;
  /** Box's mark of the file's present state. It changes when the file does. */
  etag: string | null;
};

export type BoxVersionInfo = {
  id: string;
  name: string | null;
  size: number;
  sha1: string;
  modified_at: string | null;
};

export type BoxUploadedFile = {
  id: string;
  name: string;
  size: number;
  sha1: string;
  parent: { id: string; name: string } | null;
  versionId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  const id =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : null;
  return id && BOX_ID.test(id) ? id : null;
}

function sizeOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function nameOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    ? value
    : null;
}

function folderOf(value: unknown): { id: string; name: string } | null {
  if (!isRecord(value)) return null;
  const id = idOf(value.id);
  const name = nameOf(value.name);
  return id && name ? { id, name } : null;
}

/** Box's etag as it may go into a header: a short run of plain characters. */
function etagOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value)
    ? value
    : null;
}

function retryAfterOf(response: Response): number | undefined {
  const seconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 3600
    ? seconds
    : undefined;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** At most `maxBytes` of a response body as text, or null when it is larger. */
async function boundedText(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function boundedJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await boundedText(response, MAX_BOX_JSON_BYTES);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The id of the item that already has the name, from Box's 409 answer. */
async function conflictIdOf(response: Response): Promise<string | null> {
  const data = await boundedJson(response);
  const context = isRecord(data?.context_info) ? data.context_info : null;
  const conflicts = Array.isArray(context?.conflicts)
    ? context.conflicts[0]
    : context?.conflicts;
  return isRecord(conflicts) ? idOf(conflicts.id) : null;
}

/**
 * How the gateway answers a Box status that is not a success. Box's 403
 * and 404 are passed on as 403 and 404. Box's own body is thrown away.
 */
async function failureFor(
  response: Response,
  conflict: "name_exists" | "box_conflict" = "box_conflict",
): Promise<BoxFailure> {
  const status = response.status;
  if (status === 409 && conflict === "name_exists") {
    return {
      ok: false,
      status: 409,
      error: "name_exists",
      conflictId: await conflictIdOf(response),
    };
  }
  const retryAfter = retryAfterOf(response);
  await discard(response);
  if (status === 401) return { ok: false, status: 401, error: "box_sign_in_refused" };
  if (status === 403) return { ok: false, status: 403, error: "box_forbidden" };
  if (status === 404) return { ok: false, status: 404, error: "box_not_found" };
  if (status === 409) return { ok: false, status: 409, error: "box_conflict" };
  // The If-Match of a new version: the file changed after the gateway looked.
  if (status === 412) return { ok: false, status: 409, error: "box_file_changed" };
  if (status === 413) return { ok: false, status: 413, error: "box_file_too_large" };
  if (status === 429) {
    return { ok: false, status: 429, error: "box_rate_limited", retryAfter };
  }
  return { ok: false, status: 502, error: "box_error" };
}

const BOX_UNREACHABLE: BoxFailure = {
  ok: false,
  status: 502,
  error: "box_unreachable",
};
const BOX_BAD_ANSWER: BoxFailure = { ok: false, status: 502, error: "box_error" };

function authorization(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/** One JSON call to the Box API. Redirects are never followed. */
async function boxApiJson(
  fetchImpl: typeof fetch,
  accessToken: string,
  path: string,
): Promise<{ ok: true; data: Record<string, unknown> } | BoxFailure> {
  let response: Response;
  try {
    response = await fetchImpl(`${BOX_API_ORIGIN}${path}`, {
      method: "GET",
      headers: { ...authorization(accessToken), Accept: "application/json" },
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(BOX_JSON_TIMEOUT_MS),
    });
  } catch {
    // Never the error text: it can hold a URL or a header.
    return BOX_UNREACHABLE;
  }
  if (response.status !== 200) return failureFor(response);
  const data = await boundedJson(response);
  return data ? { ok: true, data } : BOX_BAD_ANSWER;
}

/** The details of a file, with its place in the folder tree. */
export async function getBoxFile(
  fetchImpl: typeof fetch,
  accessToken: string,
  fileId: string,
): Promise<{ ok: true; file: BoxFileInfo } | BoxFailure> {
  const answer = await boxApiJson(
    fetchImpl,
    accessToken,
    `/2.0/files/${fileId}?fields=${FILE_FIELDS}`,
  );
  if (!answer.ok) return answer;
  const data = answer.data;
  const name = nameOf(data.name);
  const size = sizeOf(data.size);
  const sha1 = normalizeSha1(data.sha1);
  if (idOf(data.id) !== fileId || !name || size === null || !sha1) {
    return BOX_BAD_ANSWER;
  }
  const pathEntries = isRecord(data.path_collection)
    ? data.path_collection.entries
    : null;
  return {
    ok: true,
    file: {
      id: fileId,
      name,
      size,
      sha1,
      modified_at: typeof data.modified_at === "string" ? data.modified_at : null,
      parent: folderOf(data.parent),
      path: (Array.isArray(pathEntries) ? pathEntries : [])
        .map((entry) => (isRecord(entry) ? nameOf(entry.name) : null))
        .filter((entry): entry is string => entry !== null),
      versionId: isRecord(data.file_version) ? idOf(data.file_version.id) : null,
      etag: etagOf(data.etag),
    },
  };
}

/** The details of one earlier version of a file. */
export async function getBoxFileVersion(
  fetchImpl: typeof fetch,
  accessToken: string,
  fileId: string,
  versionId: string,
): Promise<{ ok: true; version: BoxVersionInfo } | BoxFailure> {
  const answer = await boxApiJson(
    fetchImpl,
    accessToken,
    `/2.0/files/${fileId}/versions/${versionId}?fields=${VERSION_FIELDS}`,
  );
  if (!answer.ok) return answer;
  const data = answer.data;
  const size = sizeOf(data.size);
  const sha1 = normalizeSha1(data.sha1);
  if (idOf(data.id) !== versionId || size === null || !sha1) {
    return BOX_BAD_ANSWER;
  }
  return {
    ok: true,
    version: {
      id: versionId,
      name: nameOf(data.name),
      size,
      sha1,
      modified_at: typeof data.modified_at === "string" ? data.modified_at : null,
    },
  };
}

/**
 * Opens the byte stream of a file. The first request goes to the fixed Box
 * API host and is the only one that carries the user's Box token. Box
 * answers with a redirect to a signed address on its download hosts; that
 * address is checked, and the request to it carries no Authorization
 * header. A redirect to any other host is refused.
 */
export async function openBoxDownload(
  fetchImpl: typeof fetch,
  accessToken: string,
  fileId: string,
  versionId: string | null,
  signal: AbortSignal,
): Promise<{ ok: true; response: Response } | BoxFailure> {
  // "identity": the bytes must arrive as they are stored, so their count
  // can be checked against the size Box reported.
  const plain = { "Accept-Encoding": "identity" };
  let response: Response;
  try {
    response = await fetchImpl(
      `${BOX_API_ORIGIN}/2.0/files/${fileId}/content${
        versionId ? `?version=${versionId}` : ""
      }`,
      {
        method: "GET",
        headers: { ...authorization(accessToken), ...plain },
        redirect: "manual",
        credentials: "omit",
        signal,
      },
    );
    for (
      let redirects = 0;
      [301, 302, 303, 307, 308].includes(response.status);
      redirects += 1
    ) {
      const location = response.headers.get("location");
      await discard(response);
      if (!location || redirects >= MAX_DOWNLOAD_REDIRECTS) {
        return { ok: false, status: 502, error: "box_download_redirect_refused" };
      }
      let next: URL;
      try {
        // Box's own download hosts only: https, *.boxcloud.com, no
        // credentials in the address, no other port.
        next = boxDownloadUrl(location);
      } catch {
        return { ok: false, status: 502, error: "box_download_redirect_refused" };
      }
      // No Authorization header here, ever. The signed address is enough.
      response = await fetchImpl(next, {
        method: "GET",
        headers: plain,
        redirect: "manual",
        credentials: "omit",
        signal,
      });
    }
  } catch {
    return BOX_UNREACHABLE;
  }
  if (response.status === 202) {
    // Box is still preparing the file.
    const retryAfter = retryAfterOf(response);
    await discard(response);
    return { ok: false, status: 503, error: "box_file_not_ready", retryAfter };
  }
  if (response.status !== 200) return failureFor(response);
  if (!response.body) {
    return BOX_BAD_ANSWER;
  }
  return { ok: true, response };
}

/**
 * Asks Box whether a new file of this name and size may be put in the
 * folder. It changes nothing. A name that is taken answers `name_exists`
 * with the id of the file that has it.
 */
export async function preflightBoxNewFile(
  fetchImpl: typeof fetch,
  accessToken: string,
  input: { parentId: string; name: string; size: number },
): Promise<{ ok: true } | BoxFailure> {
  let response: Response;
  try {
    response = await fetchImpl(`${BOX_API_ORIGIN}/2.0/files/content`, {
      method: "OPTIONS",
      headers: {
        ...authorization(accessToken),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: input.name,
        size: input.size,
        parent: { id: input.parentId },
      }),
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(BOX_JSON_TIMEOUT_MS),
    });
  } catch {
    return BOX_UNREACHABLE;
  }
  if (response.status === 200) {
    // Box offers an upload address here. It is not used: the upload goes
    // to the fixed upload host.
    await discard(response);
    return { ok: true };
  }
  return failureFor(response, "name_exists");
}

/**
 * Sends the bytes to Box in one request: a new file in a folder, or a new
 * version of an existing file (Box keeps the earlier versions). Box checks
 * the bytes it received against the sha1 sent with them and refuses a
 * mismatch. Nothing is ever overwritten by name: a taken name is a 409.
 *
 * A new version carries `ifMatch`, the etag the gateway just read: Box then
 * refuses the upload (`box_file_changed`) when the file changed in between.
 */
export async function uploadToBox(
  fetchImpl: typeof fetch,
  accessToken: string,
  input: { bytes: Buffer; sha1: string } & (
    | { kind: "new_file"; parentId: string; name: string }
    | { kind: "new_version"; fileId: string; ifMatch: string | null }
  ),
): Promise<{ ok: true; file: BoxUploadedFile } | BoxFailure> {
  const form = new FormData();
  // Box needs the attributes part before the file part. A new version
  // sends no attributes: the file keeps its name and its place.
  form.append(
    "attributes",
    JSON.stringify(
      input.kind === "new_file"
        ? { name: input.name, parent: { id: input.parentId } }
        : {},
    ),
  );
  // The Blob holds the same bytes; the cast only quiets the typed-array
  // generics, which cannot tell a Buffer from a shared buffer.
  form.append("file", new Blob([input.bytes as unknown as BlobPart]), "file");
  const path =
    input.kind === "new_file"
      ? "/api/2.0/files/content"
      : `/api/2.0/files/${input.fileId}/content`;

  let response: Response;
  try {
    response = await fetchImpl(
      `${BOX_UPLOAD_ORIGIN}${path}?fields=${UPLOAD_FIELDS}`,
      {
        method: "POST",
        headers: {
          ...authorization(accessToken),
          Accept: "application/json",
          // Box's name for the sha1 of the uploaded bytes.
          "Content-MD5": input.sha1,
          ...(input.kind === "new_version" && input.ifMatch
            ? { "If-Match": input.ifMatch }
            : {}),
        },
        body: form,
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(BOX_UPLOAD_TIMEOUT_MS),
      },
    );
  } catch {
    // The request may have reached Box before the connection broke.
    return { ok: false, status: 502, error: "box_upload_uncertain", uncertain: true };
  }
  if (response.status >= 500) {
    // Box broke while it had the bytes. It may have stored them.
    await discard(response);
    return { ok: false, status: 502, error: "box_upload_uncertain", uncertain: true };
  }
  if (response.status !== 200 && response.status !== 201) {
    return failureFor(
      response,
      input.kind === "new_file" ? "name_exists" : "box_conflict",
    );
  }
  const data = await boundedJson(response);
  const entry = Array.isArray(data?.entries) ? data.entries[0] : null;
  const id = isRecord(entry) ? idOf(entry.id) : null;
  const name = isRecord(entry) ? nameOf(entry.name) : null;
  const size = isRecord(entry) ? sizeOf(entry.size) : null;
  const sha1 = isRecord(entry) ? normalizeSha1(entry.sha1) : null;
  if (!isRecord(entry) || !id || !name || size === null || !sha1) {
    // Box said yes, but its answer cannot be read.
    return { ok: false, status: 502, error: "box_upload_uncertain", uncertain: true };
  }
  return {
    ok: true,
    file: {
      id,
      name,
      size,
      sha1,
      parent: folderOf(entry.parent),
      versionId: isRecord(entry.file_version) ? idOf(entry.file_version.id) : null,
    },
  };
}
