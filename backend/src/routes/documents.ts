import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  getSignedUrl,
  storageKey,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  loadActiveVersion,
} from "../lib/documentVersions";
import { ensureDocAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";
import {
  ALLOWED_DOCUMENT_TYPES,
  ALLOWED_DOCUMENT_TYPES_LABEL,
  contentTypeForDocumentType,
  shouldConvertToPdf,
} from "../lib/documentTypes";

export const documentsRouter = Router();

const VERSION_ROW_SELECT =
  "id, version_number, source, created_at, display_name, file_type, size_bytes, page_count, deleted_at, deleted_by";

type StoredDocumentVersion = {
  id: string;
  storage_path: string | null;
  pdf_storage_path: string | null;
  version_number: number | null;
  display_name: string | null;
  file_type: string | null;
  size_bytes: number | null;
  page_count: number | null;
  created_at?: string | null;
  deleted_at?: string | null;
};

function fileSuffix(filename: string): string {
  return filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
}

function asUploadArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function uniqueStoragePaths(paths: Array<string | null | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => !!path))];
}

async function removeVersionFiles(paths: Array<string | null | undefined>) {
  await Promise.all(
    uniqueStoragePaths(paths).map((path) => deleteFile(path).catch(() => {})),
  );
}

function documentFilenameFromDisplayName(
  requested: string,
  fallbackFilename: string,
  suffix: string,
): string {
  const trimmed = requested.trim().slice(0, 200);
  if (!trimmed) return fallbackFilename;
  if (/\.[a-z0-9]{1,16}$/i.test(trimmed)) return trimmed;
  const fallbackExtension = fallbackFilename.match(/\.[a-z0-9]{1,16}$/i)?.[0];
  return `${trimmed}${suffix ? `.${suffix}` : fallbackExtension ?? ""}`;
}

async function getNextDocumentVersionNumber(
  db: ReturnType<typeof createServerSupabase>,
  documentId: string,
): Promise<number> {
  const { data: maxRow } = await db
    .from("document_versions")
    .select("version_number")
    .eq("document_id", documentId)
    .not("version_number", "is", null)
    .order("version_number", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return ((maxRow?.version_number as number | null) ?? 0) + 1;
}

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  const docs = (data ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docs);
  await attachActiveVersionPaths(db, docs);
  res.json(docs);
});

// POST /single-documents
documentsRouter.post(
  "/",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    await handleDocumentUpload(req, res, userId, null, db);
  },
);

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });

  // Storage now lives on document_versions — fan out and delete each
  // version's bytes (DOCX + PDF rendition) before dropping rows.
  const { data: versions } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .eq("document_id", documentId);
  await Promise.all(
    (versions ?? []).flatMap((v) =>
      [v.storage_path, v.pdf_storage_path]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => deleteFile(p).catch(() => {})),
    ),
  );
  await db.from("documents").delete().eq("id", documentId);
  res.status(204).send();
});

// GET /single-documents/:documentId/display
// Optional ?version_id= renders a historical version. Defaults to the
// document's current_version_id.
documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, filename, file_type, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const fileType = (doc.file_type as string) ?? "";
  const isConvertibleOffice = shouldConvertToPdf(fileType);

  // For convertible Office files, prefer the per-version PDF rendition if one exists.
  const servePath =
    isConvertibleOffice && active.pdf_storage_path
      ? active.pdf_storage_path
      : active.storage_path;
  const raw = await downloadFile(servePath);
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document not found in storage" });

  if (fileType === "pdf" || (isConvertibleOffice && active.pdf_storage_path)) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  } else {
    // Fallback: serve raw Office bytes when no PDF rendition is available.
    res.setHeader("Content-Type", contentTypeForDocumentType(fileType));
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  }
});

// POST /single-documents/download-zip
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids } = req.body as { document_ids?: string[] };

  if (!Array.isArray(document_ids) || document_ids.length === 0)
    return void res.status(400).json({ detail: "document_ids is required" });

  const db = createServerSupabase();
  const { data: rawDocs, error } = await db
    .from("documents")
    .select("id, filename, file_type, current_version_id, user_id, project_id")
    .in("id", document_ids);

  if (error) return void res.status(500).json({ detail: error.message });
  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    (rawDocs ?? []).map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(
        d as { user_id: string; project_id: string | null },
        userId,
        userEmail,
        db,
      ),
    })),
  );
  const docs = accessChecks
    .filter((x) => x.access.ok)
    .map((x) => x.doc as { id: string; filename: string });
  if (!docs || docs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  await Promise.all(
    docs.map(async (doc) => {
      const active = await loadActiveVersion(doc.id, db);
      if (!active) return;
      const raw = await downloadFile(active.storage_path);
      if (!raw) return;
      zip.file(doc.filename, Buffer.from(raw));
    }),
  );

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  res.send(content);
});

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = resolveDownloadFilename(
    doc.filename as string,
    active.display_name,
    active.version_number,
  );
  const url = await getSignedUrl(
    active.storage_path,
    3600,
    downloadFilename,
  );
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    // Lets the frontend decide between DocView (PDF.js) and DocxView
    // (docx-preview) without a follow-up round-trip.
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// GET /single-documents/:documentId/docx
// Streams the raw .docx bytes for the given document, optionally at a
// specific tracked-changes version. Unlike /url, this bypasses R2 (avoids
// the browser CORS problem on signed URLs) so the frontend docx-preview
// viewer can load tracked-change documents directly.
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const raw = await downloadFile(active.storage_path);
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(
      "inline",
      resolveDownloadFilename(
        doc.filename as string,
        active.display_name,
        active.version_number,
      ),
    ),
  );
  res.send(Buffer.from(raw));
});

// Compose a download-friendly filename that carries the edit version
// marker: "Purchase Agreement.docx" → "Purchase Agreement [Edited V2].docx".
// Preserves the original extension (fallback: .docx).
function versionedFilename(filename: string, version: number | null): string {
  if (!version || version < 1) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".docx";
  return `${stem} [Edited V${version}]${ext}`;
}

// Produce the filename a download should present to the user for a given
// (document, version) pair. Prefers the version's display_name (appending
// the original extension if the user didn't include one), falling back to
// the versionedFilename heuristic.
function resolveDownloadFilename(
  originalFilename: string,
  displayName: string | null | undefined,
  versionNumber: number | null,
): string {
  const dot = originalFilename.lastIndexOf(".");
  const origExt = dot > 0 ? originalFilename.slice(dot) : "";
  if (displayName && displayName.trim()) {
    const trimmed = displayName.trim();
    const trimmedDot = trimmed.lastIndexOf(".");
    const hasExt =
      trimmedDot > 0 &&
      trimmed
        .slice(trimmedDot)
        .toLowerCase()
        .match(/^\.[a-z0-9]{1,6}$/);
    if (hasExt) return trimmed;
    return origExt ? `${trimmed}${origExt}` : trimmed;
  }
  return versionedFilename(originalFilename, versionNumber);
}

// GET /single-documents/:documentId/versions
// Returns every version row for the document in document order, with
// the human-friendly version number when present.
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const { data: rows } = await db
    .from("document_versions")
    .select(VERSION_ROW_SELECT)
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });

  res.json({
    current_version_id: doc.current_version_id,
    versions: rows ?? [],
  });
});

// POST /single-documents/:documentId/versions
// Upload a brand-new version of an existing document. The uploaded file
// becomes the new current_version_id. display_name defaults to the
// uploaded filename; client may override via the `display_name` form field.
documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const { data: doc } = await db
      .from("documents")
      .select("id, filename, file_type, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    // Reject if the uploaded file's extension doesn't match the document's
    // declared type — otherwise every downstream viewer/extractor breaks.
    const suffix = fileSuffix(file.originalname);
    if (!ALLOWED_DOCUMENT_TYPES.has(suffix)) {
      return void res.status(400).json({
        detail: `Unsupported file type: ${suffix}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
      });
    }
    if (doc.file_type && suffix && doc.file_type !== suffix) {
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match document type (${doc.file_type}).`,
      });
    }

    // Peg the new version into a predictable /versions/:id path under the
    // existing document folder so ops can spot the history in storage.
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(
      userId,
      documentId,
      versionSlug,
      file.originalname,
    );
    const contentType = contentTypeForDocumentType(suffix);
    try {
      await uploadFile(
        key,
        asUploadArrayBuffer(file.buffer),
        contentType,
      );
    } catch (e) {
      console.error("[versions/upload] storage write failed", e);
      return void res
        .status(500)
        .json({ detail: "Failed to upload new version." });
    }

    // Render this version's bytes to PDF up front so /display can show
    // historical versions without on-demand conversion. Same logic as the
    // initial-upload pipeline; failures don't block the version row.
    let pdfStoragePath: string | null = null;
    if (shouldConvertToPdf(suffix)) {
      try {
        const pdfBuf = await docxToPdf(file.buffer);
        const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
        await uploadFile(
          pdfKey,
          pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
          ) as ArrayBuffer,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(
          `[versions/upload] Office to PDF conversion failed for ${file.originalname}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      // For PDF uploads, the uploaded bytes are themselves the PDF rendition.
      pdfStoragePath = key;
    }

    const rawBuf = asUploadArrayBuffer(file.buffer);
    const [pageCount, structureTree] = await Promise.all([
      suffix === "pdf" ? countPdfPages(rawBuf) : Promise.resolve(null),
      extractStructureTree(rawBuf, suffix, file.originalname),
    ]);
    const nextVersionNumber = await getNextDocumentVersionNumber(db, documentId);

    const defaultDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : file.originalname;

    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "user_upload",
        version_number: nextVersionNumber,
        display_name: defaultDisplayName,
        file_type: suffix,
        size_bytes: file.buffer.byteLength,
        page_count: pageCount,
      })
      .select(VERSION_ROW_SELECT)
      .single();
    if (verErr || !versionRow) {
      console.error("[versions/upload] insert failed", verErr);
      await removeVersionFiles([key, pdfStoragePath]);
      return void res
        .status(500)
        .json({ detail: "Failed to record new version." });
    }

    // Also propagate the user-provided display_name to the parent document's
    // filename so the document's display name stays in sync across the UI.
    // Preserve a sensible extension: if the display_name has none, append
    // the uploaded file's extension (fallback: the existing doc's extension).
    const documentsUpdate: Record<string, unknown> = {
      current_version_id: versionRow.id,
      size_bytes: file.buffer.byteLength,
      page_count: pageCount,
      structure_tree: structureTree,
      status: "ready",
      updated_at: new Date().toISOString(),
    };
    const providedDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : null;
    if (providedDisplayName) {
      const hasExt = /\.[a-z0-9]{1,6}$/i.test(providedDisplayName);
      const existingExt = (doc.filename as string | null)?.match(
        /\.[a-z0-9]{1,6}$/i,
      )?.[0];
      const uploadedExt = suffix ? `.${suffix}` : "";
      const ext = hasExt ? "" : uploadedExt || existingExt || "";
      documentsUpdate.filename = `${providedDisplayName}${ext}`;
    }
    await db
      .from("documents")
      .update(documentsUpdate)
      .eq("id", documentId);

    res.status(201).json(versionRow);
  },
);

// PATCH /single-documents/:documentId/versions/:versionId
// Rename a version's display_name. Pass `{ "display_name": "…" }`; an empty
// or missing value clears the override so the UI falls back to V{n}.
documentsRouter.patch(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const raw = req.body?.display_name;
    const displayName =
      typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

    const { data: updated, error } = await db
      .from("document_versions")
      .update({ display_name: displayName })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .is("deleted_at", null)
      .select(VERSION_ROW_SELECT)
      .single();
    if (error || !updated) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json(updated);
  },
);

// POST /single-documents/:documentId/versions/:versionId/copy
// Restore/copy an existing version into a new current version without
// mutating the source version. This is intentionally non-destructive: legal
// users can return to an older draft while keeping the complete history.
documentsRouter.post(
  "/:documentId/versions/:versionId/copy",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select(
        "id, filename, file_type, size_bytes, page_count, user_id, project_id",
      )
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const { data: source, error: sourceError } = await db
      .from("document_versions")
      .select(
        "id, storage_path, pdf_storage_path, version_number, display_name, file_type, size_bytes, page_count, deleted_at",
      )
      .eq("id", versionId)
      .eq("document_id", documentId)
      .single();
    const sourceVersion = source as StoredDocumentVersion | null;
    if (sourceError || !sourceVersion)
      return void res.status(404).json({ detail: "Version not found" });
    if (sourceVersion.deleted_at || !sourceVersion.storage_path) {
      return void res.status(400).json({ detail: "Version is deleted." });
    }

    const sourceBytes = await downloadFile(sourceVersion.storage_path);
    if (!sourceBytes) {
      return void res
        .status(404)
        .json({ detail: "Source version bytes not available." });
    }

    const sourceFilename =
      sourceVersion.display_name?.trim() || (doc.filename as string);
    const suffix =
      sourceVersion.file_type?.trim().toLowerCase() ||
      (doc.file_type as string | null)?.toLowerCase() ||
      fileSuffix(sourceFilename);
    if (!ALLOWED_DOCUMENT_TYPES.has(suffix)) {
      return void res.status(400).json({ detail: "Version has an unsupported file type." });
    }
    const requestedDisplayName =
      typeof req.body?.display_name === "string" && req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : `Copy of ${sourceFilename}`.slice(0, 200);
    const providedDisplayName =
      typeof req.body?.display_name === "string" && req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : null;
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(userId, documentId, versionSlug, sourceFilename);

    try {
      await uploadFile(key, sourceBytes, contentTypeForDocumentType(suffix));
    } catch (error) {
      console.error("[versions/copy] storage write failed", error);
      return void res.status(500).json({ detail: "Failed to copy the version." });
    }

    let pdfStoragePath: string | null = null;
    try {
      if (suffix === "pdf" || sourceVersion.pdf_storage_path === sourceVersion.storage_path) {
        pdfStoragePath = key;
      } else if (sourceVersion.pdf_storage_path) {
        const pdfBytes = await downloadFile(sourceVersion.pdf_storage_path);
        if (pdfBytes) {
          const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
          await uploadFile(pdfKey, pdfBytes, "application/pdf");
          pdfStoragePath = pdfKey;
        }
      } else if (shouldConvertToPdf(suffix)) {
        const pdfBuf = await docxToPdf(Buffer.from(sourceBytes));
        const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
        await uploadFile(
          pdfKey,
          asUploadArrayBuffer(pdfBuf),
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      }
    } catch (error) {
      // A source document remains usable when its display rendition cannot be
      // copied or regenerated. The raw version is still safely preserved.
      console.error("[versions/copy] PDF rendition failed", error);
    }

    const [pageCount, structureTree] = await Promise.all([
      suffix === "pdf" ? countPdfPages(sourceBytes) : Promise.resolve(null),
      extractStructureTree(sourceBytes, suffix, sourceFilename),
    ]);
    const nextVersion = await getNextDocumentVersionNumber(db, documentId);
    const { data: versionRow, error: insertError } = await db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "user_upload",
        version_number: nextVersion,
        display_name: requestedDisplayName,
        file_type: suffix,
        size_bytes: sourceVersion.size_bytes ?? sourceBytes.byteLength,
        page_count: pageCount,
      })
      .select(VERSION_ROW_SELECT)
      .single();
    if (insertError || !versionRow) {
      await removeVersionFiles([key, pdfStoragePath]);
      console.error("[versions/copy] insert failed", insertError);
      return void res.status(500).json({ detail: "Failed to record copied version." });
    }

    const documentUpdate: Record<string, unknown> = {
      current_version_id: versionRow.id,
      file_type: suffix,
      size_bytes: sourceVersion.size_bytes ?? sourceBytes.byteLength,
      page_count: pageCount,
      structure_tree: structureTree,
      status: "ready",
      updated_at: new Date().toISOString(),
    };
    // Match the ordinary new-version flow: only an explicit caller-provided
    // name changes the document's stable title. The default "Copy of …"
    // is a history label, not a surprise document rename.
    if (providedDisplayName) {
      documentUpdate.filename = documentFilenameFromDisplayName(
        providedDisplayName,
        doc.filename as string,
        suffix,
      );
    }
    const { error: updateError } = await db
      .from("documents")
      .update(documentUpdate)
      .eq("id", documentId);
    if (updateError) {
      await db.from("document_versions").delete().eq("id", versionRow.id);
      await removeVersionFiles([key, pdfStoragePath]);
      console.error("[versions/copy] current version update failed", updateError);
      return void res.status(500).json({ detail: "Failed to activate copied version." });
    }

    res.status(201).json(versionRow);
  },
);

// PUT /single-documents/:documentId/versions/:versionId/file
// Replace a version's bytes in place while retaining its identity and number.
// This is owner-only because it rewrites historical evidence.
documentsRouter.put(
  "/:documentId/versions/:versionId/file",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();
    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const { data: doc } = await db
      .from("documents")
      .select(
        "id, filename, file_type, current_version_id, user_id, project_id",
      )
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok || !access.isOwner) {
      return void res.status(404).json({ detail: "Document not found" });
    }

    const { data: target, error: targetError } = await db
      .from("document_versions")
      .select(
        "id, storage_path, pdf_storage_path, display_name, file_type, size_bytes, page_count, created_at, deleted_at",
      )
      .eq("id", versionId)
      .eq("document_id", documentId)
      .single();
    const targetVersion = target as StoredDocumentVersion | null;
    if (targetError || !targetVersion) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    if (targetVersion.deleted_at) {
      return void res.status(400).json({ detail: "Version is deleted." });
    }

    const suffix = fileSuffix(file.originalname);
    if (!ALLOWED_DOCUMENT_TYPES.has(suffix)) {
      return void res.status(400).json({
        detail: `Unsupported file type: ${suffix}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
      });
    }
    const expectedType =
      targetVersion.file_type?.trim().toLowerCase() ||
      (doc.file_type as string | null)?.trim().toLowerCase() ||
      null;
    if (expectedType && expectedType !== suffix) {
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match version type (${expectedType}).`,
      });
    }

    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(userId, documentId, versionSlug, file.originalname);
    try {
      await uploadFile(key, asUploadArrayBuffer(file.buffer), contentTypeForDocumentType(suffix));
    } catch (error) {
      console.error("[versions/replace] storage write failed", error);
      return void res.status(500).json({ detail: "Failed to upload replacement version." });
    }

    let pdfStoragePath: string | null = null;
    try {
      if (shouldConvertToPdf(suffix)) {
        const pdfBuf = await docxToPdf(file.buffer);
        const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
        await uploadFile(pdfKey, asUploadArrayBuffer(pdfBuf), "application/pdf");
        pdfStoragePath = pdfKey;
      } else if (suffix === "pdf") {
        pdfStoragePath = key;
      }
    } catch (error) {
      console.error("[versions/replace] PDF rendition failed", error);
    }

    const rawBuf = asUploadArrayBuffer(file.buffer);
    const [pageCount, structureTree] = await Promise.all([
      suffix === "pdf" ? countPdfPages(rawBuf) : Promise.resolve(null),
      extractStructureTree(rawBuf, suffix, file.originalname),
    ]);
    const displayName =
      typeof req.body?.display_name === "string" && req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : file.originalname;
    const oldPaths = [targetVersion.storage_path, targetVersion.pdf_storage_path];
    const { data: updated, error: updateError } = await db
      .from("document_versions")
      .update({
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        display_name: displayName,
        file_type: suffix,
        size_bytes: file.buffer.byteLength,
        page_count: pageCount,
        created_at: new Date().toISOString(),
      })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .is("deleted_at", null)
      .select(VERSION_ROW_SELECT)
      .single();
    if (updateError || !updated) {
      await removeVersionFiles([key, pdfStoragePath]);
      return void res.status(500).json({
        detail: updateError?.message ?? "Failed to replace version.",
      });
    }

    if (doc.current_version_id === versionId) {
      const { error: documentUpdateError } = await db
        .from("documents")
        .update({
          filename: documentFilenameFromDisplayName(
            displayName,
            doc.filename as string,
            suffix,
          ),
          file_type: suffix,
          size_bytes: file.buffer.byteLength,
          page_count: pageCount,
          structure_tree: structureTree,
          status: "ready",
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId);
      if (documentUpdateError) {
        // Restore the version row before cleaning new bytes so a failed parent
        // update never leaves documents.current_version_id pointing at deleted
        // storage.
        await db
          .from("document_versions")
          .update({
            storage_path: targetVersion.storage_path,
            pdf_storage_path: targetVersion.pdf_storage_path,
            display_name: targetVersion.display_name,
            file_type: targetVersion.file_type,
            size_bytes: targetVersion.size_bytes,
            page_count: targetVersion.page_count,
            created_at: targetVersion.created_at,
          })
          .eq("id", versionId);
        await removeVersionFiles([key, pdfStoragePath]);
        return void res.status(500).json({ detail: "Failed to update document metadata." });
      }
    }

    await removeVersionFiles(oldPaths);
    res.json(updated);
  },
);

// DELETE /single-documents/:documentId/versions/:versionId
// Soft-delete one version and its Azure bytes. The final active version is
// retained, and deleting the current version promotes the newest survivor.
documentsRouter.delete(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select(
        "id, current_version_id, filename, file_type, size_bytes, page_count, structure_tree, user_id, project_id",
      )
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok || !access.isOwner) {
      return void res.status(404).json({ detail: "Document not found" });
    }

    const { data: rows, error: rowsError } = await db
      .from("document_versions")
      .select(
        "id, storage_path, pdf_storage_path, version_number, display_name, file_type, size_bytes, page_count, created_at, deleted_at",
      )
      .eq("document_id", documentId)
      .is("deleted_at", null);
    if (rowsError) return void res.status(500).json({ detail: rowsError.message });
    const activeVersions = (rows ?? []) as StoredDocumentVersion[];
    const target = activeVersions.find((version) => version.id === versionId);
    if (!target)
      return void res.status(404).json({ detail: "Version not found" });
    if (activeVersions.length <= 1) {
      return void res
        .status(400)
        .json({ detail: "Cannot delete the only document version." });
    }

    const nextCurrentVersion =
      doc.current_version_id === versionId
        ? activeVersions
            .filter((version) => version.id !== versionId)
            .sort((a, b) => {
              const numberDelta =
                (b.version_number ?? -1) - (a.version_number ?? -1);
              if (numberDelta !== 0) return numberDelta;
              return (
                new Date(b.created_at ?? 0).getTime() -
                new Date(a.created_at ?? 0).getTime()
              );
            })[0] ?? null
        : null;
    const nextCurrentVersionId = nextCurrentVersion?.id ?? doc.current_version_id;

    if (doc.current_version_id === versionId) {
      const { error: documentUpdateError } = await db
        .from("documents")
        .update({
          current_version_id: nextCurrentVersionId,
          filename: documentFilenameFromDisplayName(
            nextCurrentVersion?.display_name ?? (doc.filename as string),
            doc.filename as string,
            nextCurrentVersion?.file_type ?? (doc.file_type as string) ?? "",
          ),
          file_type: nextCurrentVersion?.file_type ?? doc.file_type,
          size_bytes: nextCurrentVersion?.size_bytes ?? doc.size_bytes,
          page_count: nextCurrentVersion?.page_count ?? doc.page_count,
          // The parent document index describes its active bytes. Rebuild it
          // on the next document read rather than leaving a stale tree from
          // the deleted current version.
          structure_tree: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId);
      if (documentUpdateError) {
        return void res.status(500).json({ detail: documentUpdateError.message });
      }
    }

    const deletedAt = new Date().toISOString();
    const { error: deleteError } = await db
      .from("document_versions")
      .update({
        storage_path: null,
        pdf_storage_path: null,
        deleted_at: deletedAt,
        deleted_by: userId,
      })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .is("deleted_at", null);
    if (deleteError) {
      if (doc.current_version_id === versionId) {
        await db
          .from("documents")
          .update({
            current_version_id: versionId,
            filename: doc.filename,
            file_type: doc.file_type,
            size_bytes: doc.size_bytes,
            page_count: doc.page_count,
            structure_tree: doc.structure_tree,
          })
          .eq("id", documentId);
      }
      return void res.status(500).json({ detail: deleteError.message });
    }

    await removeVersionFiles([target.storage_path, target.pdf_storage_path]);
    res.json({
      deleted_version_id: versionId,
      current_version_id: nextCurrentVersionId,
      deleted_at: deletedAt,
    });
  },
);

// GET /single-documents/:documentId/tracked-change-ids
// Returns the ordered list of { kind, w_id } for every w:ins / w:del in
// the current (or specified) version's document.xml. The frontend uses
// this to tag each rendered <ins>/<del> with data-w-id, since
// docx-preview drops the w:id attribute during parsing.
documentsRouter.get(
  "/:documentId/tracked-change-ids",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
      typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const raw = await downloadFile(active.storage_path);
    if (!raw)
      return void res
        .status(404)
        .json({ detail: "Document bytes not available" });

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    res.json({ ids });
  },
);

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
  req: import("express").Request,
  res: import("express").Response,
  mode: "accept" | "reject",
) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId, editId } = req.params;
  const db = createServerSupabase();

  console.log(`[edit-resolution] incoming ${mode}`, {
    userId,
    documentId,
    editId,
  });

  const { data: edit, error: editErr } = await db
    .from("document_edits")
    .select("id, document_id, change_id, del_w_id, ins_w_id, status")
    .eq("id", editId)
    .eq("document_id", documentId)
    .single();
  console.log(`[edit-resolution] fetched edit row`, { edit, editErr });
  if (!edit) {
    console.log(`[edit-resolution] edit not found, returning 404`);
    return void res.status(404).json({ detail: "Edit not found" });
  }
  // Idempotent: if the edit is already resolved, return the current doc
  // state so stale UI (e.g. an old chat reloaded in a new session) can
  // reconcile without throwing.
  if (edit.status !== "pending") {
    console.log(`[edit-resolution] edit already resolved`, {
      editId,
      status: edit.status,
    });
    const { data: doc } = await db
      .from("documents")
      .select("current_version_id, filename, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc) {
      console.log(`[edit-resolution] doc not found for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(doc, userId, userEmail, db);
    if (!accessResolved.ok) {
      console.log(`[edit-resolution] doc access denied for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const activeForResolved = await loadActiveVersion(documentId, db);
    const payload = {
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: doc.current_version_id ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(
            activeForResolved.storage_path,
            (doc.filename as string) ?? "document.docx",
          )
        : null,
      remaining_pending: 0,
    };
    console.log(`[edit-resolution] returning already-resolved payload`, payload);
    return void res.status(200).json(payload);
  }

  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  console.log(`[edit-resolution] fetched doc`, { doc, docErr });
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db);
  const latestPath = active?.storage_path ?? null;
  console.log(`[edit-resolution] resolved latestPath`, {
    latestPath,
    current_version_id: doc.current_version_id,
  });
  if (!latestPath)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath);
  console.log(`[edit-resolution] downloaded bytes`, {
    byteLength: raw?.byteLength ?? 0,
  });
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  const wIds = [edit.del_w_id, edit.ins_w_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(raw),
    wIds,
    mode,
  );
  console.log(`[edit-resolution] resolveTrackedChange result`, {
    mode,
    change_id: edit.change_id,
    wIds,
    found,
    resolvedByteLength: resolvedBytes?.byteLength ?? 0,
  });
  if (!found) {
    console.log(
      `[edit-resolution] change_id not found in docx — updating status only`,
    );
    // Still update DB status so the UI reflects the decision — the change
    // may have been auto-consumed by a previous accept/reject pass.
    const { error: updErr } = await db
      .from("document_edits")
      .update({ status: mode === "accept" ? "accepted" : "rejected", resolved_at: new Date().toISOString() })
      .eq("id", editId);
    console.log(`[edit-resolution] status-only update`, { updErr });
    const { data: filenameRow } = await db
      .from("documents")
      .select("filename")
      .eq("id", documentId)
      .single();
    const payload = {
      ok: true,
      version_id: doc.current_version_id,
      download_url: buildDownloadUrl(
        latestPath,
        (filenameRow?.filename as string) ?? "document.docx",
      ),
      remaining_pending: 0,
    };
    console.log(`[edit-resolution] returning not-found payload`, payload);
    return void res.status(200).json(payload);
  }

  // Overwrite bytes in place at the current version's storage path —
  // accept/reject mutates the existing version rather than spawning a
  // new row. This keeps document_versions lean (one row per assistant
  // edit, not one per accept/reject click) and avoids the N-versions-
  // per-doc churn as users resolve pending changes.
  const ab = resolvedBytes.buffer.slice(
    resolvedBytes.byteOffset,
    resolvedBytes.byteOffset + resolvedBytes.byteLength,
  ) as ArrayBuffer;
  console.log(`[edit-resolution] overwriting bytes in place`, {
    latestPath,
    byteLength: ab.byteLength,
  });
  await uploadFile(
    latestPath,
    ab,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  const { error: statusErr } = await db
    .from("document_edits")
    .update({
      status: mode === "accept" ? "accepted" : "rejected",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", editId);
  console.log(`[edit-resolution] updated document_edits status`, {
    editId,
    newStatus: mode === "accept" ? "accepted" : "rejected",
    statusErr,
  });

  const { count: remainingPending } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending");
  console.log(`[edit-resolution] remaining pending count`, { remainingPending });

  const { data: filenameRow } = await db
    .from("documents")
    .select("filename")
    .eq("id", documentId)
    .single();
  const payload = {
    ok: true,
    version_id: doc.current_version_id,
    download_url: buildDownloadUrl(
      latestPath,
      (filenameRow?.filename as string) ?? "document.docx",
    ),
    remaining_pending: remainingPending ?? 0,
  };
  console.log(`[edit-resolution] returning success payload`, payload);
  res.json(payload);
}

documentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "accept"),
);

documentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "reject"),
);

async function handleDocumentUpload(
  req: import("express").Request,
  res: import("express").Response,
  userId: string,
  projectId: string | null,
  db: ReturnType<typeof createServerSupabase>,
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  const filename = file.originalname;
  const suffix = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!ALLOWED_DOCUMENT_TYPES.has(suffix))
    return void res
      .status(400)
      .json({
        detail: `Unsupported file type: ${suffix}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
      });

  const content = file.buffer;
  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert({
      project_id: projectId,
      user_id: userId,
      filename,
      file_type: suffix,
      size_bytes: content.byteLength,
      status: "processing",
    })
    .select("*")
    .single();
  if (insertErr || !doc)
    return void res
      .status(500)
      .json({ detail: "Failed to create document record" });

  try {
    const docId = doc.id as string;
    const key = storageKey(userId, docId, filename);
    const contentType = contentTypeForDocumentType(suffix);
    await uploadFile(
      key,
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      contentType,
    );

    const rawBuf = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    const tree = await extractStructureTree(rawBuf, suffix, filename);
    const pageCount = suffix === "pdf" ? await countPdfPages(rawBuf) : null;

    // Convert Word/presentation files to PDF for display. Spreadsheets render from raw bytes.
    let pdfStoragePath: string | null = null;
    if (shouldConvertToPdf(suffix)) {
      try {
        const pdfBuf = await docxToPdf(content);
        const pdfKey = convertedPdfKey(userId, docId);
        await uploadFile(
          pdfKey,
          pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
          ) as ArrayBuffer,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(
          `[upload] Office to PDF conversion failed for ${filename}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // storage_path / pdf_storage_path live on document_versions now —
    // create the V1 "upload" row and point documents.current_version_id
    // at it.
    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: docId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "upload",
        version_number: 1,
        display_name: filename,
        file_type: suffix,
        size_bytes: content.byteLength,
        page_count: pageCount,
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      throw new Error(
        `Failed to record upload version: ${verErr?.message ?? "unknown"}`,
      );
    }

    await db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
        size_bytes: content.byteLength,
        page_count: pageCount,
        structure_tree: tree ?? null,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId);

    const { data: updated } = await db
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    // Surface storage paths to the caller for backward compatibility.
    const responseDoc = updated
      ? { ...updated, storage_path: key, pdf_storage_path: pdfStoragePath }
      : updated;
    return void res.status(201).json(responseDoc);
  } catch (e) {
    await db.from("documents").update({ status: "error" }).eq("id", doc.id);
    return void res
      .status(500)
      .json({ detail: `Document processing failed: ${String(e)}` });
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

async function extractStructureTree(
  content: ArrayBuffer,
  fileType: string,
  _filename: string,
): Promise<unknown[] | null> {
  try {
    if (fileType === "pdf") {
      const pdfjsLib = await import(
        "pdfjs-dist/legacy/build/pdf.mjs" as string
      );
      const pdf = await (
        pdfjsLib as unknown as {
          getDocument: (opts: unknown) => {
            promise: Promise<{
              numPages: number;
              getOutline: () => Promise<{ title?: string }[]>;
            }>;
          };
        }
      ).getDocument({ data: new Uint8Array(content) }).promise;
      if (pdf.numPages <= 5) return null;
      const outline = await pdf.getOutline();
      if (outline?.length)
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
      return Array.from({ length: pdf.numPages }, (_, i) => ({
        id: `page-${i + 1}`,
        title: `Page ${i + 1}`,
        level: 1,
        page_number: i + 1,
        children: [],
      }));
    } else {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(content),
      });
      const lines = result.value.split("\n").filter((l) => l.trim());
      const nodes = lines
        .slice(0, 30)
        .map((line, i) => ({
          id: `h1-${i}`,
          title: line.slice(0, 100),
          level: 1,
          page_number: null,
          children: [],
        }));
      return nodes.length ? nodes : null;
    }
  } catch {
    return null;
  }
}
