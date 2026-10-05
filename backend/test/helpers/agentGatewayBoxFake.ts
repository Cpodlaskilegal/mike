// A stand-in for Box, for the Docket Agent Box file tests. It is the `fetch`
// the gateway is given: it answers the handful of Box calls the gateway may
// make, records every request (host, method, whether the user's Box token
// was on it), and throws on anything else. No network.

import { createHash } from "node:crypto";
import type { FakeDb } from "./agentGatewayFakes";

export const BOX_API_HOST = "api.box.com";
export const BOX_UPLOAD_HOST = "upload.box.com";
export const BOX_DOWNLOAD_HOST = "dl.boxcloud.com";
/** In every fake Box error body. It must never reach a gateway answer or a log. */
export const BOX_ERROR_BODY_CANARY = "box-error-body-canary-91d4";
/** In every signed download address. It must never reach a gateway answer or a log. */
export const BOX_SIGNED_URL_CANARY = "signed-download-canary-3b7e";

export type FakeBoxVersion = { id: string; bytes: Buffer; modifiedAt: string };
export type FakeBoxFile = {
  id: string;
  name: string;
  parentId: string;
  /** Oldest first. The last one is the current version. */
  versions: FakeBoxVersion[];
};
export type FakeBoxFolder = { id: string; name: string; parentId: string | null };
export type BoxCall = {
  method: string;
  host: string;
  path: string;
  search: string;
  /** The Authorization header as sent, or null. */
  authorization: string | null;
  headers: Record<string, string>;
};

export function sha1Of(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function boxError(status: number, code: string, extra: Record<string, unknown> = {}) {
  return json(status, {
    type: "error",
    status,
    code,
    message: `Box says no. ${BOX_ERROR_BODY_CANARY}`,
    request_id: BOX_ERROR_BODY_CANARY,
    ...extra,
  });
}

export function createFakeBox(db?: FakeDb) {
  const folders = new Map<string, FakeBoxFolder>([
    ["0", { id: "0", name: "All Files", parentId: null }],
  ]);
  const files = new Map<string, FakeBoxFile>();
  /** Box access token -> the ids of the files and folders it may see. */
  const grants = new Map<string, Set<string>>();
  const calls: BoxCall[] = [];
  let nextId = 900_000_000_001;
  const state: {
    /** Where the content call redirects to. null = a signed Box download address. */
    redirectTo: string | null;
    /** Serve these bytes instead of the stored ones (a corrupted download). */
    serveBytes: Buffer | null;
    /** The download stream waits for this after `gateAfterBytes`. */
    gate: Promise<void> | null;
    gateAfterBytes: number;
    /** Set when the download stream has handed over its last byte. */
    downloadFinished: boolean;
    /** Answer these statuses to the next calls of a kind, then behave. */
    failNext: Array<{ match: (call: BoxCall) => boolean; status: number; code: string }>;
    /** The preflight does not see a taken name; the upload itself does. */
    preflightBlind: boolean;
    /** What an upload stores is not what was sent (cannot happen at Box). */
    corruptUploads: boolean;
    /** The upload request breaks after Box took the bytes. */
    dropUploadAnswer: boolean;
    /** Runs when an upload request arrives, before Box looks at it. */
    beforeUpload: (() => void) | null;
    /** The file details come without an etag (Box always sends one). */
    omitEtag: boolean;
  } = {
    redirectTo: null,
    serveBytes: null,
    gate: null,
    gateAfterBytes: 0,
    downloadFinished: false,
    failNext: [],
    preflightBlind: false,
    corruptUploads: false,
    dropUploadAnswer: false,
    beforeUpload: null,
    omitEtag: false,
  };
  /** What the multipart upload requests held, in order. */
  const uploads: Array<{
    attributes: unknown;
    bytes: Buffer;
    contentMd5: string | null;
    partNames: string[];
  }> = [];

  function newId(): string {
    nextId += 1;
    return String(nextId);
  }

  function addFolder(id: string, name: string, parentId = "0"): FakeBoxFolder {
    const folder = { id, name, parentId };
    folders.set(id, folder);
    return folder;
  }

  function addFile(input: {
    id: string;
    name: string;
    parentId?: string;
    bytes: Buffer;
    versionId?: string;
  }): FakeBoxFile {
    const file: FakeBoxFile = {
      id: input.id,
      name: input.name,
      parentId: input.parentId ?? "0",
      versions: [
        {
          id: input.versionId ?? newId(),
          bytes: input.bytes,
          modifiedAt: "2026-09-30T15:00:00-05:00",
        },
      ],
    };
    files.set(file.id, file);
    return file;
  }

  /** Lets a Box access token see these files and folders. */
  function grant(accessToken: string, ...ids: string[]): void {
    const set = grants.get(accessToken) ?? new Set<string>();
    for (const id of ids) set.add(id);
    grants.set(accessToken, set);
  }

  function pathOf(folderId: string): FakeBoxFolder[] {
    const path: FakeBoxFolder[] = [];
    let current = folders.get(folderId) ?? null;
    while (current) {
      path.unshift(current);
      current = current.parentId ? (folders.get(current.parentId) ?? null) : null;
    }
    return path;
  }

  function miniFolder(folderId: string) {
    const folder = folders.get(folderId);
    return folder
      ? { type: "folder", id: folder.id, sequence_id: "1", etag: "1", name: folder.name }
      : null;
  }

  function fileObject(file: FakeBoxFile) {
    const current = file.versions.at(-1)!;
    return {
      type: "file",
      // Box sends ids as strings.
      id: file.id,
      // It changes whenever the file does.
      ...(state.omitEtag ? {} : { etag: String(file.versions.length) }),
      name: file.name,
      size: current.bytes.length,
      // Box has been seen to send the sha1 in either case.
      sha1: sha1Of(current.bytes),
      modified_at: current.modifiedAt,
      parent: miniFolder(file.parentId),
      path_collection: {
        total_count: pathOf(file.parentId).length,
        entries: pathOf(file.parentId).map((folder) => miniFolder(folder.id)),
      },
      file_version: { type: "file_version", id: current.id, sha1: sha1Of(current.bytes) },
      // Things the gateway must not pass on.
      owned_by: { type: "user", id: "77", login: `owner-${BOX_ERROR_BODY_CANARY}@example.com` },
      shared_link: { url: `https://app.box.com/s/${BOX_ERROR_BODY_CANARY}` },
    };
  }

  function byteStream(bytes: Buffer): ReadableStream<Uint8Array> {
    const chunkSize = 64 * 1024;
    let offset = 0;
    let gated = false;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (state.gate && !gated && offset >= state.gateAfterBytes) {
          gated = true;
          await state.gate;
        }
        if (offset >= bytes.length) {
          state.downloadFinished = true;
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, bytes.length);
        // A copy, so the caller cannot hold on to the test's own buffer.
        controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
        offset = end;
      },
    });
  }

  /** The file, when this token may see it. Box answers 404 for the rest. */
  function visibleFile(token: string, fileId: string): FakeBoxFile | null {
    const file = files.get(fileId);
    return file && grants.get(token)?.has(fileId) ? file : null;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const call: BoxCall = {
      method,
      host: url.host,
      path: url.pathname,
      search: url.search,
      authorization: headers.get("authorization"),
      headers: Object.fromEntries(headers.entries()),
    };
    calls.push(call);
    db?.events.push(`box:${method} ${url.host}${url.pathname}`);
    if (init?.redirect !== "manual") {
      throw new Error(`fake box: ${method} ${url.host} was not sent with redirect: "manual"`);
    }

    // The signed download address. It needs no token, and must get none.
    if (url.host === BOX_DOWNLOAD_HOST && method === "GET") {
      const match = /^\/d\/1\/[^/]+\/(\d+)\/(\d+)\/download$/.exec(url.pathname);
      const file = match ? files.get(match[1]) : undefined;
      const version = file?.versions.find((item) => item.id === match![2]);
      if (!version) return new Response("gone", { status: 404 });
      const bytes = state.serveBytes ?? version.bytes;
      state.downloadFinished = false;
      return new Response(byteStream(bytes), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
        },
      });
    }

    if (url.host !== BOX_API_HOST && url.host !== BOX_UPLOAD_HOST) {
      throw new Error(`fake box: unexpected host ${url.host}`);
    }
    const token = /^Bearer (.+)$/.exec(call.authorization ?? "")?.[1] ?? null;
    if (!token || !grants.has(token)) return boxError(401, "unauthorized");
    const forced = state.failNext.findIndex((item) => item.match(call));
    if (forced !== -1) {
      const [failure] = state.failNext.splice(forced, 1);
      return boxError(failure.status, failure.code);
    }

    if (url.host === BOX_API_HOST) {
      let match = /^\/2\.0\/files\/(\d+)$/.exec(url.pathname);
      if (match && method === "GET") {
        const file = visibleFile(token, match[1]);
        return file ? json(200, fileObject(file)) : boxError(404, "not_found");
      }
      match = /^\/2\.0\/files\/(\d+)\/versions\/(\d+)$/.exec(url.pathname);
      if (match && method === "GET") {
        const file = visibleFile(token, match[1]);
        // Box lists earlier versions here, not the current one.
        const version = file?.versions.slice(0, -1).find((item) => item.id === match![2]);
        if (!file || !version) return boxError(404, "not_found");
        return json(200, {
          type: "file_version",
          id: version.id,
          sha1: sha1Of(version.bytes).toUpperCase(),
          name: file.name,
          size: version.bytes.length,
          modified_at: version.modifiedAt,
        });
      }
      match = /^\/2\.0\/files\/(\d+)\/content$/.exec(url.pathname);
      if (match && method === "GET") {
        const file = visibleFile(token, match[1]);
        if (!file) return boxError(404, "not_found");
        const wanted = url.searchParams.get("version");
        const version = wanted
          ? file.versions.find((item) => item.id === wanted)
          : file.versions.at(-1);
        if (!version) return boxError(404, "not_found");
        return new Response(null, {
          status: 302,
          headers: {
            location:
              state.redirectTo ??
              `https://${BOX_DOWNLOAD_HOST}/d/1/${BOX_SIGNED_URL_CANARY}/${file.id}/${version.id}/download`,
          },
        });
      }
      if (url.pathname === "/2.0/files/content" && method === "OPTIONS") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const parentId = String(body?.parent?.id ?? "");
        if (!folders.has(parentId) || !grants.get(token)?.has(parentId)) {
          return boxError(404, "not_found");
        }
        const taken = [...files.values()].find(
          (file) => file.parentId === parentId && file.name === body.name,
        );
        if (taken && !state.preflightBlind) {
          return boxError(409, "item_name_in_use", {
            context_info: { conflicts: { type: "file", id: taken.id, name: taken.name } },
          });
        }
        return json(200, {
          upload_url: `https://upload-las.app.box.com/api/2.0/files/content?upload_session_id=${BOX_SIGNED_URL_CANARY}`,
          upload_token: BOX_SIGNED_URL_CANARY,
        });
      }
      throw new Error(`fake box: unexpected ${method} ${url.host}${url.pathname}`);
    }

    // upload.box.com
    const newFile = url.pathname === "/api/2.0/files/content";
    const versionOf = /^\/api\/2\.0\/files\/(\d+)\/content$/.exec(url.pathname)?.[1];
    if (method !== "POST" || (!newFile && !versionOf)) {
      throw new Error(`fake box: unexpected ${method} ${url.host}${url.pathname}`);
    }
    if (!(init?.body instanceof FormData)) {
      throw new Error("fake box: the upload was not multipart form data");
    }
    state.beforeUpload?.();
    const form = init.body;
    const partNames = [...form.keys()];
    const attributes = JSON.parse(String(form.get("attributes")));
    const part = form.get("file");
    if (!(part instanceof Blob)) throw new Error("fake box: no file part");
    const bytes = Buffer.from(await part.arrayBuffer());
    const contentMd5 = headers.get("content-md5");
    uploads.push({ attributes, bytes, contentMd5, partNames });
    // Box checks the bytes against the sha1 in Content-MD5.
    if (contentMd5 && contentMd5.toLowerCase() !== sha1Of(bytes)) {
      return boxError(400, "bad_digest");
    }
    const stored = state.corruptUploads ? Buffer.concat([bytes, Buffer.from("!")]) : bytes;
    let file: FakeBoxFile;
    if (newFile) {
      const parentId = String(attributes?.parent?.id ?? "");
      if (!folders.has(parentId) || !grants.get(token)?.has(parentId)) {
        return boxError(404, "not_found");
      }
      const taken = [...files.values()].find(
        (item) => item.parentId === parentId && item.name === attributes.name,
      );
      if (taken) {
        return boxError(409, "item_name_in_use", {
          context_info: { conflicts: { type: "file", id: taken.id, name: taken.name } },
        });
      }
      file = addFile({ id: newId(), name: attributes.name, parentId, bytes: stored });
      grant(token, file.id);
    } else {
      const existing = visibleFile(token, versionOf!);
      if (!existing) return boxError(404, "not_found");
      // If-Match: only when the file is still in the state the caller saw.
      const ifMatch = headers.get("if-match");
      if (ifMatch !== null && ifMatch !== String(existing.versions.length)) {
        return boxError(412, "precondition_failed");
      }
      // A name in the attributes would rename the file. The gateway sends none.
      if (typeof attributes?.name === "string") existing.name = attributes.name;
      existing.versions.push({
        id: newId(),
        bytes: stored,
        modifiedAt: "2026-10-01T12:00:00-05:00",
      });
      file = existing;
    }
    if (state.dropUploadAnswer) throw new Error("socket hang up");
    return json(201, { total_count: 1, entries: [fileObject(file)] });
  };

  return {
    fetchImpl,
    calls,
    uploads,
    files,
    folders,
    state,
    addFolder,
    addFile,
    grant,
  };
}

export type FakeBox = ReturnType<typeof createFakeBox>;
