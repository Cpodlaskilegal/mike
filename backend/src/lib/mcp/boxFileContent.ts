import JSZip from "jszip";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { extractDocxBodyText } from "../docxTrackedChanges";

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 24_000;
const DOWNLOAD_TIMEOUT_MS = 25_000;
const MAX_PDF_PAGES = 100;

type Metadata = {
  id: string;
  name: string;
  size?: number;
  extension?: string;
  download_url?: string;
};

export type BoxFileContentFallbackResult = {
  isError: boolean;
  source: "box_download_fallback";
  file_id: string;
  filename?: string;
  status: "read" | "partial" | "unread";
  truncated: boolean;
  coverage: string;
  content: Array<{ type: "text"; text: string }>;
};

export type BoxFileContentFallbackOptions = {
  fileId: string;
  /** The caller must authorize the current user's enabled get_file_details tool. */
  getFileDetails: () => Promise<unknown>;
  /** Optional, same-user Box OAuth only; never an application/admin credential. */
  getAccessToken?: () => Promise<string | null | undefined>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** May only reduce the production limits; useful for bounded local tests. */
  limits?: { maxBytes?: number; maxTextChars?: number; timeoutMs?: number };
};

class BoxReadFailure extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Only recover a failed representation read, never override a successful read. */
export function shouldFallbackBoxFileContent(result: unknown): boolean {
  const envelope = record(result);
  if (!(result instanceof Error) && envelope?.isError !== true) return false;
  const text =
    result instanceof Error
      ? result.message
      : JSON.stringify(envelope?.content ?? []).slice(0, 8_000);
  return /text representation.{0,120}(?:not available|unavailable|not found|does not exist)|(?:not available|unavailable|not found).{0,80}text representation/i.test(
    text,
  );
}

function metadataFromResult(result: unknown, fileId: string): Metadata | null {
  if (record(result)?.isError === true) return null;
  const visit = (value: unknown, depth: number): Metadata | null => {
    if (depth > 6) return null;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const item = record(value);
    if (!item) return null;
    if (
      (typeof item.id === "string" || Number.isSafeInteger(item.id)) &&
      String(item.id) === fileId &&
      typeof item.name === "string"
    ) {
      return {
        id: fileId,
        name: item.name.slice(0, 500),
        size: typeof item.size === "number" ? item.size : undefined,
        extension:
          typeof item.extension === "string" ? item.extension : undefined,
        download_url:
          typeof item.download_url === "string" ? item.download_url : undefined,
      };
    }
    if (
      item.type === "text" &&
      typeof item.text === "string" &&
      item.text.length < 100_000
    ) {
      try {
        const found = visit(JSON.parse(item.text), depth + 1);
        if (found) return found;
      } catch {
        /* Plain text is not file metadata. */
      }
    }
    for (const key of [
      "structuredContent",
      "content",
      "result",
      "data",
      "file",
    ]) {
      const found = visit(item[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(result, 0);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function lowerLimit(value: number | undefined, maximum: number): number {
  return Number.isSafeInteger(value) && value! > 0
    ? Math.min(value!, maximum)
    : maximum;
}

function downloadUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BoxReadFailure("Box did not return a usable download URL.");
  }
  // Box documents *.boxcloud.com for its download URLs. Do not accept user
  // shared links, arbitrary sites, IP literals, credentials or alternate ports.
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".boxcloud.com") ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new BoxReadFailure(
      "Box returned an unsupported download destination.",
    );
  }
  url.hash = "";
  return url;
}

async function boundedBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new BoxReadFailure("Box file exceeds the download size limit.");
  }
  if (!response.body) throw new BoxReadFailure("Box returned no file content.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new BoxReadFailure("Box file exceeds the download size limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function download(
  metadata: Metadata,
  options: BoxFileContentFallbackOptions,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  if (metadata.download_url) {
    response = await fetchImpl(downloadUrl(metadata.download_url), {
      redirect: "manual",
      signal,
      credentials: "omit",
    });
  } else {
    const token = await withAbort(
      Promise.resolve(options.getAccessToken?.()),
      signal,
    );
    if (!token)
      throw new BoxReadFailure(
        "Box did not provide a download URL for this user's file access.",
      );
    // The only request carrying credentials has a fixed Box API origin and
    // numeric file ID. Redirected requests below NEVER inherit this header.
    response = await fetchImpl(
      `https://api.box.com/2.0/files/${metadata.id}/content`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal,
        credentials: "omit",
      },
    );
  }
  for (
    let redirects = 0;
    [301, 302, 303, 307, 308].includes(response.status);
    redirects++
  ) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects >= 3)
      throw new BoxReadFailure(
        "Box download redirects could not be completed.",
      );
    response = await fetchImpl(downloadUrl(location), {
      redirect: "manual",
      signal,
      credentials: "omit",
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new BoxReadFailure(
      `Box download failed (HTTP ${response.status}). The document has not been read.`,
    );
  }
  return boundedBody(response, maxBytes);
}

async function docxText(bytes: Buffer): Promise<string> {
  const xml = boundedDocxXml(bytes);
  const checkedZip = new JSZip();
  checkedZip.file("word/document.xml", xml);
  return extractDocxBodyText(
    await checkedZip.generateAsync({ type: "nodebuffer" }),
  );
}

/**
 * Read only the main-body ZIP member. Native inflate's output cap applies even
 * when an archive lies about its decompressed size. Avoid JSZip's legacy stream
 * destroy path, which can emit uncaught errors after a size-limit cancellation.
 */
function boundedDocxXml(bytes: Buffer): Buffer {
  const invalid = () =>
    new BoxReadFailure("The DOCX archive could not be safely read.");
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65_557);
    offset--
  ) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (
    end < 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0
  )
    throw invalid();
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (
    count > 2_000 ||
    count !== bytes.readUInt16LE(end + 8) ||
    centralOffset + centralSize > end
  )
    throw invalid();
  let offset = centralOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw invalid();
    const nameLength = bytes.readUInt16LE(offset + 28);
    const entryLength =
      46 +
      nameLength +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
    if (offset + entryLength > centralOffset + centralSize) throw invalid();
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (name === "word/document.xml" || name === "word\\document.xml") {
      const method = bytes.readUInt16LE(offset + 10);
      const compressedSize = bytes.readUInt32LE(offset + 20);
      const uncompressedSize = bytes.readUInt32LE(offset + 24);
      if (uncompressedSize > MAX_DOCUMENT_XML_BYTES)
        throw new BoxReadFailure(
          "The DOCX body exceeds the safe extraction limit.",
        );
      if (bytes.readUInt16LE(offset + 8) & 1 || ![0, 8].includes(method))
        throw invalid();
      const localOffset = bytes.readUInt32LE(offset + 42);
      if (
        localOffset + 30 > centralOffset ||
        bytes.readUInt32LE(localOffset) !== 0x04034b50
      )
        throw invalid();
      const dataStart =
        localOffset +
        30 +
        bytes.readUInt16LE(localOffset + 26) +
        bytes.readUInt16LE(localOffset + 28);
      if (dataStart + compressedSize > centralOffset) throw invalid();
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      let xml: Buffer;
      try {
        xml =
          method === 0
            ? compressed
            : inflateRawSync(compressed, {
                maxOutputLength: MAX_DOCUMENT_XML_BYTES,
              });
      } catch {
        throw new BoxReadFailure(
          "The DOCX body is invalid or exceeds the safe extraction limit.",
        );
      }
      if (
        xml.length > MAX_DOCUMENT_XML_BYTES ||
        xml.length !== uncompressedSize
      )
        throw invalid();
      return xml;
    }
    offset += entryLength;
  }
  throw new BoxReadFailure("The DOCX file has no readable document body.");
}

async function pdfText(
  bytes: Buffer,
  maxTextChars: number,
  signal: AbortSignal,
) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl:
      path.join(
        path.dirname(require.resolve("pdfjs-dist/package.json")),
        "standard_fonts",
      ) + path.sep,
  });
  const cancel = () => {
    void task.destroy().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const pdf = await task.promise;
    const parts: string[] = [];
    let chars = 0;
    let pagesRead = 0;
    let blankPages = 0;
    for (
      let pageNumber = 1;
      pageNumber <= Math.min(pdf.numPages, MAX_PDF_PAGES);
      pageNumber++
    ) {
      signal.throwIfAborted();
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: { str?: string }) => item.str ?? "")
        .join(" ")
        .trim();
      if (text) parts.push(`[Page ${pageNumber}]\n${text}`);
      else blankPages++;
      chars += text.length;
      pagesRead++;
      page.cleanup();
      if (chars > maxTextChars) break;
    }
    return {
      text: parts.join("\n\n"),
      partial: pagesRead < pdf.numPages || blankPages > 0,
      coverage: `PDF embedded text from ${pagesRead} of ${pdf.numPages} pages; ${blankPages} visited pages contained no extractable text. Images and scans were not OCR-read.`,
    };
  } finally {
    signal.removeEventListener("abort", cancel);
    await task.destroy().catch(() => undefined);
  }
}

/** Reads a binary file as the same Box user after its text representation fails. */
export async function readBoxFileContentFallback(
  options: BoxFileContentFallbackOptions,
): Promise<BoxFileContentFallbackResult> {
  const timeout = AbortSignal.timeout(
    lowerLimit(options.limits?.timeoutMs, DOWNLOAD_TIMEOUT_MS),
  );
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  const maxBytes = lowerLimit(options.limits?.maxBytes, MAX_DOWNLOAD_BYTES);
  const maxTextChars = lowerLimit(options.limits?.maxTextChars, MAX_TEXT_CHARS);
  let metadata: Metadata | null = null;
  try {
    if (!/^\d{1,30}$/.test(options.fileId))
      throw new BoxReadFailure("A valid Box file ID is required.");
    metadata = metadataFromResult(
      await withAbort(options.getFileDetails(), signal),
      options.fileId,
    );
    signal.throwIfAborted();
    if (!metadata)
      throw new BoxReadFailure(
        "Box file metadata could not be read with this user's enabled tools.",
      );
    if (metadata.size != null && metadata.size > maxBytes)
      throw new BoxReadFailure("Box file exceeds the download size limit.");
    const extension = (
      metadata.extension ||
      metadata.name.split(".").pop() ||
      ""
    ).toLowerCase();
    if (!["docx", "pdf", "txt", "md", "csv"].includes(extension)) {
      throw new BoxReadFailure(
        `The Box download fallback cannot extract this file format (${extension.slice(0, 16) || "unknown"}). The document has not been read.`,
      );
    }
    const bytes = await download(metadata, options, signal, maxBytes);
    signal.throwIfAborted();
    let text: string;
    let partial = false;
    let coverage: string;
    if (extension === "docx") {
      text = await docxText(bytes);
      coverage =
        "DOCX main-body text in accepted-revisions view, including tables. Headers, footers, footnotes, comments, text boxes, images and formatting were not read.";
    } else if (extension === "pdf") {
      ({ text, partial, coverage } = await pdfText(
        bytes,
        maxTextChars,
        signal,
      ));
    } else {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      coverage =
        "UTF-8 plain text; no document formatting or embedded objects were read.";
    }
    signal.throwIfAborted();
    if (!text.trim())
      throw new BoxReadFailure(
        "Box file downloaded, but no readable text was extracted. The document has not been reviewed; it may require OCR.",
      );
    const truncated = text.length > maxTextChars;
    return {
      isError: false,
      source: "box_download_fallback",
      file_id: options.fileId,
      filename: metadata.name,
      status: truncated || partial ? "partial" : "read",
      truncated,
      coverage: `${coverage}${truncated ? ` Only the first ${maxTextChars} characters are included; do not claim full-document review.` : ""}`,
      content: [{ type: "text", text: text.slice(0, maxTextChars) }],
    };
  } catch (error) {
    // Never return exception strings from fetch/parsers/callbacks: those may
    // include preauthorized URLs, access tokens or raw document data.
    const message = signal.aborted
      ? "Box file read timed out or was cancelled. The document has not been read."
      : error instanceof BoxReadFailure
        ? error.message
        : "Box file download or text extraction failed. The document has not been read.";
    return {
      isError: true,
      source: "box_download_fallback",
      file_id: /^\d{1,30}$/.test(options.fileId) ? options.fileId : "invalid",
      ...(metadata ? { filename: metadata.name } : {}),
      status: "unread",
      truncated: false,
      coverage: "No verified document text is available from this fallback.",
      content: [{ type: "text", text: message }],
    };
  }
}
