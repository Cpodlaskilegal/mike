import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { TransactionFailure, withTransaction } from "./databaseTransaction";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type ResolutionState = {
  current_version_id: string | null;
  filename: string;
  user_id: string;
  file_type: string;
  edit_status: "pending" | "accepted" | "rejected";
  del_w_id: string | null;
  ins_w_id: string | null;
  storage_path: string | null;
};

export class EditResolutionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type EditResolutionResult = {
  status: "accepted" | "rejected";
  already_resolved: boolean;
  version_id: string;
  storage_path: string;
  filename: string;
  remaining_pending: number;
};

type Dependencies = {
  database: Pick<Pool, "query" | "connect">;
  download: (path: string) => Promise<ArrayBuffer | null>;
  upload: (path: string, content: ArrayBuffer, contentType: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  resolve: (bytes: Buffer, ids: string[], mode: "accept" | "reject") => Promise<{ bytes: Buffer; found: boolean }>;
  report: (event: string, metadata: Record<string, unknown>) => void;
};

const STATE_SQL = `SELECT d.current_version_id, d.filename, d.user_id, d.file_type,
  e.status AS edit_status, e.del_w_id, e.ins_w_id, v.storage_path
  FROM documents d JOIN document_edits e ON e.document_id = d.id
  LEFT JOIN document_versions v ON v.id = d.current_version_id
    AND v.document_id = d.id AND v.deleted_at IS NULL
  WHERE d.id = $1 AND e.id = $2`;

async function resultFor(
  client: Pick<PoolClient, "query">,
  documentId: string,
  state: ResolutionState,
  status: "accepted" | "rejected",
  alreadyResolved: boolean,
): Promise<EditResolutionResult> {
  if (!state.current_version_id || !state.storage_path) {
    throw new EditResolutionError(409, "VERSION_UNAVAILABLE", "The active document version is unavailable. Refresh the document before resolving edits.");
  }
  const { rows } = await client.query<{ count: string }>(
    "SELECT count(*) AS count FROM document_edits WHERE document_id = $1 AND status = 'pending'",
    [documentId],
  );
  return {
    status,
    already_resolved: alreadyResolved,
    version_id: state.current_version_id,
    storage_path: state.storage_path,
    filename: state.filename,
    remaining_pending: Number(rows[0].count),
  };
}

/** Caller must authorize document mutation before invoking this operation. */
export async function resolveDocumentEdit(
  input: { documentId: string; editId: string; mode: "accept" | "reject" },
  deps: Dependencies,
): Promise<EditResolutionResult> {
  const { documentId, editId, mode } = input;
  const status = mode === "accept" ? "accepted" : "rejected";
  const { rows } = await deps.database.query<ResolutionState>(STATE_SQL, [documentId, editId]);
  const snapshot = rows[0];
  if (!snapshot) throw new EditResolutionError(404, "EDIT_NOT_FOUND", "Edit not found");
  if (snapshot.edit_status !== "pending") {
    if (snapshot.edit_status !== status) {
      throw new EditResolutionError(409, "EDIT_ALREADY_RESOLVED", `This edit has already been ${snapshot.edit_status}. Refresh the document.`);
    }
    return resultFor(deps.database, documentId, snapshot, status, true);
  }
  if (!snapshot.storage_path || !snapshot.current_version_id) {
    throw new EditResolutionError(409, "VERSION_UNAVAILABLE", "The active document version is unavailable. Refresh the document before resolving edits.");
  }
  if (snapshot.file_type !== "docx") {
    throw new EditResolutionError(409, "VERSION_NOT_DOCX", "Tracked edits require the active Word document.");
  }
  const raw = await deps.download(snapshot.storage_path);
  if (!raw) throw new EditResolutionError(503, "DOCUMENT_READ_FAILED", "Unable to read the document. Your edit remains pending; please retry.");
  const ids = [snapshot.del_w_id, snapshot.ins_w_id].filter((id): id is string => !!id);
  const resolved = await deps.resolve(Buffer.from(raw), ids, mode);
  if (!resolved.found) {
    throw new EditResolutionError(409, "TRACKED_CHANGE_MISSING", "This tracked change is absent from the active version. Refresh and review the document; the decision has not been saved.");
  }

  const versionId = randomUUID();
  const stagedPath = `documents/${snapshot.user_id}/${documentId}/versions/resolution-${versionId}.docx`;
  const content = resolved.bytes.buffer.slice(resolved.bytes.byteOffset, resolved.bytes.byteOffset + resolved.bytes.byteLength) as ArrayBuffer;
  // A fresh key preserves the only usable copy even if upload partially fails.
  try {
    await deps.upload(stagedPath, content, DOCX_CONTENT_TYPE);
  } catch {
    await deps.remove(stagedPath).catch(() => deps.report("document_edit_stage_cleanup_failed", { documentId, editId, versionId, stagedPath }));
    deps.report("document_edit_stage_failed", { documentId, editId, versionId });
    throw new EditResolutionError(503, "DOCUMENT_WRITE_FAILED", "Unable to save the resolved document. Your prior version and pending edit are preserved; please retry.");
  }
  try {
    const result = await withTransaction(deps.database, async (client) => {
      // Serialize resolutions against the document pointer, then its edit row.
      await client.query("SELECT id FROM documents WHERE id = $1 FOR UPDATE", [documentId]);
      await client.query("SELECT id FROM document_edits WHERE id = $1 AND document_id = $2 FOR UPDATE", [editId, documentId]);
      const { rows: currentRows } = await client.query<ResolutionState>(STATE_SQL, [documentId, editId]);
      const current = currentRows[0];
      if (!current) throw new EditResolutionError(404, "EDIT_NOT_FOUND", "Edit not found");
      if (current.edit_status !== "pending") {
        if (current.edit_status !== status) throw new EditResolutionError(409, "EDIT_ALREADY_RESOLVED", `This edit has already been ${current.edit_status}. Refresh the document.`);
        return resultFor(client, documentId, current, status, true);
      }
      if (current.current_version_id !== snapshot.current_version_id || current.storage_path !== snapshot.storage_path) {
        throw new EditResolutionError(409, "DOCUMENT_VERSION_CHANGED", "The document changed while this edit was being resolved. Refresh and retry; the decision remains pending.");
      }
      const inserted = await client.query(
        `INSERT INTO document_versions (id, document_id, storage_path, source, version_number, display_name, file_type, size_bytes)
         SELECT $1, $2, $3, $4, COALESCE(MAX(version_number), 0) + 1, $5, 'docx', $6
         FROM document_versions WHERE document_id = $2 RETURNING id`,
        [versionId, documentId, stagedPath, mode === "accept" ? "user_accept" : "user_reject", mode === "accept" ? "Accepted tracked edit" : "Rejected tracked edit", content.byteLength],
      );
      if (inserted.rowCount !== 1) throw new Error("Resolved version was not inserted");
      const activated = await client.query(
        "UPDATE documents SET current_version_id = $1, size_bytes = $2, page_count = NULL, structure_tree = NULL, updated_at = now() WHERE id = $3 AND current_version_id = $4 RETURNING id",
        [versionId, content.byteLength, documentId, snapshot.current_version_id],
      );
      if (activated.rowCount !== 1) throw new Error("Resolved version was not activated");
      const decided = await client.query(
        "UPDATE document_edits SET status = $1, resolved_at = now() WHERE id = $2 AND document_id = $3 AND status = 'pending' RETURNING id",
        [status, editId, documentId],
      );
      if (decided.rowCount !== 1) throw new Error("Edit decision was not saved");
      return resultFor(client, documentId, { ...current, current_version_id: versionId, storage_path: stagedPath }, status, false);
    });
    // Concurrent identical requests may discover the already committed decision.
    if (result.version_id !== versionId) {
      await deps.remove(stagedPath).catch(() => deps.report("document_edit_stage_cleanup_failed", { documentId, editId, versionId, stagedPath }));
    }
    return result;
  } catch (error) {
    if (error instanceof TransactionFailure && error.rollbackConfirmed) {
      await deps.remove(stagedPath).catch(() => deps.report("document_edit_stage_cleanup_failed", { documentId, editId, versionId, stagedPath }));
      if (error.originalError instanceof EditResolutionError) throw error.originalError;
    }
    // If COMMIT may have reached PostgreSQL, retain the new immutable file.
    // Retrying the same edit reads the durable decision and is idempotent.
    deps.report("document_edit_persistence_failed", {
      documentId, editId, versionId, stagedPath,
      commitUncertain: error instanceof TransactionFailure && error.commitAttempted,
      rollbackConfirmed: error instanceof TransactionFailure && error.rollbackConfirmed,
    });
    throw new EditResolutionError(503, "EDIT_SAVE_UNCONFIRMED", "The edit save could not be confirmed. Refresh the document, then retry the same decision. The prior version has been preserved.");
  }
}
