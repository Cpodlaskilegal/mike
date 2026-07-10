import type { PoolClient } from "pg";
import { deleteFile } from "./storage";
import { pool } from "./supabase";

export const DATA_EXPORT_SCOPES = [
  "account",
  "chats",
  "tabular-reviews",
] as const;

export type DataExportScope = (typeof DATA_EXPORT_SCOPES)[number];

export const DATA_DELETION_CONFIRMATION = "DELETE DOCKET DATA";

export type DataDeletionRequestStatus =
  | "pending_legal_review"
  | "approved"
  | "rejected"
  | "completed"
  | "cancelled";

/**
 * Open-source workflow submissions are separate review artifacts. They must
 * never disappear as a side effect of a general data deletion request: a
 * legal reviewer chooses one of these dispositions explicitly.
 */
export type WorkflowSubmissionDisposition = "retain" | "anonymize" | "delete";

type JsonRecord = Record<string, unknown>;

const SENSITIVE_EXPORT_KEY =
  /(?:^|_)(?:api_?key|secret|token|password|authorization|encrypted|auth_tag|iv)(?:$|_)/i;

function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function parseDataExportScope(value: unknown): DataExportScope | null {
  return typeof value === "string" &&
    (DATA_EXPORT_SCOPES as readonly string[]).includes(value)
    ? (value as DataExportScope)
    : null;
}

export function dataExportFilename(scope: DataExportScope, userId: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const subject = userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "user";
  return `docket-${scope}-export-${subject}-${stamp}.json`;
}

export function validateDeletionRequestBody(value: unknown):
  | { ok: true; reason: string | null }
  | { ok: false; detail: string } {
  const body = asJsonRecord(value);
  if (body.confirmation !== DATA_DELETION_CONFIRMATION) {
    return {
      ok: false,
      detail: `confirmation must equal ${DATA_DELETION_CONFIRMATION}`,
    };
  }
  if (body.reason != null && typeof body.reason !== "string") {
    return { ok: false, detail: "reason must be a string when supplied" };
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : null;
  return { ok: true, reason: reason || null };
}

/**
 * Never include credentials, connector tokens, or encrypted credential
 * material in an end-user export. This is intentionally recursive because
 * JSON event payloads can nest arbitrary provider/tool data.
 */
export function redactSensitiveExportData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveExportData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord).map(([key, nested]) => [
      key,
      SENSITIVE_EXPORT_KEY.test(key)
        ? "[redacted]"
        : redactSensitiveExportData(nested),
    ]),
  );
}

async function rows<T extends JsonRecord>(
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

async function one<T extends JsonRecord>(
  sql: string,
  params: unknown[],
): Promise<T | null> {
  return (await rows<T>(sql, params))[0] ?? null;
}

function exportEnvelope(
  scope: DataExportScope,
  userId: string,
  userEmail: string | null | undefined,
  payload: JsonRecord,
) {
  return redactSensitiveExportData({
    format: "docket-user-data-export/v1",
    scope,
    exported_at: new Date().toISOString(),
    identity: {
      microsoft_entra_subject: userId,
      email: userEmail ?? null,
      provider: "Microsoft Entra ID",
      note: "This export does not delete or modify the Microsoft Entra account.",
    },
    ...payload,
  }) as JsonRecord;
}

export async function buildDocketDataExport(
  scope: DataExportScope,
  userId: string,
  userEmail?: string | null,
): Promise<JsonRecord> {
  const chatQuery = rows(
    `select c.id, c.project_id, c.title, c.created_at,
            coalesce(jsonb_agg(jsonb_build_object(
              'id', m.id, 'role', m.role, 'content', m.content,
              'files', m.files, 'workflow', m.workflow, 'annotations', m.annotations,
              'created_at', m.created_at
            ) order by m.created_at) filter (where m.id is not null), '[]'::jsonb) as messages
       from chats c
       left join chat_messages m on m.chat_id = c.id
      where c.user_id = $1
      group by c.id
      order by c.created_at asc`,
    [userId],
  );
  const tabularChatQuery = rows(
    `select c.id, c.review_id, c.title, c.created_at, c.updated_at,
            coalesce(jsonb_agg(jsonb_build_object(
              'id', m.id, 'role', m.role, 'content', m.content,
              'annotations', m.annotations, 'created_at', m.created_at
            ) order by m.created_at) filter (where m.id is not null), '[]'::jsonb) as messages
       from tabular_review_chats c
       left join tabular_review_chat_messages m on m.chat_id = c.id
      where c.user_id = $1
      group by c.id
      order by c.created_at asc`,
    [userId],
  );

  if (scope === "chats") {
    const [assistant_chats, tabular_review_chats] = await Promise.all([
      chatQuery,
      tabularChatQuery,
    ]);
    return exportEnvelope(scope, userId, userEmail, {
      assistant_chats,
      tabular_review_chats,
    });
  }

  const tabularReviewQuery = rows(
    `select r.id, r.project_id, r.title, r.workflow_id, r.system_workflow_id,
            r.columns_config, r.document_ids,
            r.shared_with, r.created_at, r.updated_at,
            coalesce(jsonb_agg(jsonb_build_object(
              'id', cell.id, 'document_id', cell.document_id, 'column_index', cell.column_index,
              'content', cell.content, 'citations', cell.citations, 'status', cell.status,
              'created_at', cell.created_at
            ) order by cell.created_at) filter (where cell.id is not null), '[]'::jsonb) as cells
       from tabular_reviews r
       left join tabular_cells cell on cell.review_id = r.id
      where r.user_id = $1
      group by r.id
      order by r.created_at asc`,
    [userId],
  );

  if (scope === "tabular-reviews") {
    const [tabular_reviews, tabular_review_chats] = await Promise.all([
      tabularReviewQuery,
      tabularChatQuery,
    ]);
    return exportEnvelope(scope, userId, userEmail, {
      tabular_reviews,
      tabular_review_chats,
    });
  }

  const [
    profile,
    projects,
    documents,
    documentVersions,
    workflows,
    workflowShares,
    connectors,
    apiKeyStatus,
    assistant_chats,
    tabular_reviews,
    tabular_review_chats,
    workflow_open_source_submissions,
  ] = await Promise.all([
    one(
      `select display_name, organisation, tier, tabular_model, legal_research_us,
              created_at, updated_at
         from user_profiles where user_id = $1`,
      [userId],
    ),
    rows(
      `select id, name, cm_number, visibility, shared_with, created_at, updated_at
         from projects where user_id = $1 order by created_at asc`,
      [userId],
    ),
    rows(
      `select id, project_id, folder_id, filename, file_type, size_bytes, page_count,
              status, current_version_id, created_at, updated_at
         from documents where user_id = $1 order by created_at asc`,
      [userId],
    ),
    rows(
      `select v.id, v.document_id, v.version_number, v.display_name, v.source,
              v.created_at
         from document_versions v
         join documents d on d.id = v.document_id
        where d.user_id = $1 order by v.created_at asc`,
      [userId],
    ),
    rows(
      `select id, title, type, prompt_md, columns_config, language, practice,
              jurisdictions, is_system, created_at
         from workflows where user_id = $1 order by created_at asc`,
      [userId],
    ),
    rows(
      `select id, workflow_id, shared_with_email, allow_edit, created_at
         from workflow_shares where shared_by_user_id = $1 order by created_at asc`,
      [userId],
    ),
    rows(
      `select id, name, server_url, transport, auth_type, enabled, tool_policy,
              created_at, updated_at
         from user_mcp_connectors where user_id = $1 order by created_at asc`,
      [userId],
    ),
    rows(
      `select provider, created_at, updated_at from user_api_keys
        where user_id = $1 order by provider asc`,
      [userId],
    ),
    chatQuery,
    tabularReviewQuery,
    tabularChatQuery,
    rows(
      `select id, workflow_id, attribution, public_name, status, snapshot,
              submitted_at, updated_at, reviewed_at, withdrawn_at, review_notes
         from workflow_open_source_submissions
        where submitted_by_user_id = $1
        order by submitted_at asc`,
      [userId],
    ),
  ]);

  return exportEnvelope(scope, userId, userEmail, {
    profile,
    projects,
    documents,
    document_versions: documentVersions,
    workflows,
    workflow_shares: workflowShares,
    mcp_connectors: connectors,
    api_key_status: apiKeyStatus.map((entry) => ({
      ...entry,
      configured: true,
    })),
    assistant_chats,
    tabular_reviews,
    tabular_review_chats,
    workflow_open_source_submissions,
    exclusions: [
      "Azure Blob file bytes are not bundled; document metadata is included.",
      "API keys, OAuth tokens, encrypted connector settings, and authentication material are excluded.",
    ],
  });
}

export async function createDataDeletionRequest(input: {
  userId: string;
  userEmail?: string | null;
  reason?: string | null;
}) {
  const existing = await one<{ id: string; status: DataDeletionRequestStatus }>(
    `select id, status from data_deletion_requests
      where user_id = $1 and status in ('pending_legal_review', 'approved')
      order by requested_at desc limit 1`,
    [input.userId],
  );
  if (existing) return { ...existing, alreadyPending: true };

  const created = await one<{
    id: string;
    status: DataDeletionRequestStatus;
    requested_at: string;
  }>(
    `insert into data_deletion_requests
       (user_id, requested_by_email, reason, status)
     values ($1, $2, $3, 'pending_legal_review')
     returning id, status, requested_at`,
    [input.userId, input.userEmail?.trim().toLowerCase() || null, input.reason || null],
  );
  if (!created) throw new Error("Unable to create data deletion request");
  return { ...created, alreadyPending: false };
}

export async function listOwnDataDeletionRequests(userId: string) {
  return rows(
    `select id, status, reason, legal_hold, retention_until, requested_at,
            reviewed_at, completed_at, decision_note,
            workflow_submission_disposition
       from data_deletion_requests
      where user_id = $1 order by requested_at desc`,
    [userId],
  );
}

export function validateDeletionReviewBody(value: unknown):
  | {
      ok: true;
      status: "approved" | "rejected";
      legalHold: boolean;
      retentionUntil: string | null;
      decisionNote: string | null;
      workflowSubmissionDisposition: WorkflowSubmissionDisposition;
    }
  | { ok: false; detail: string } {
  const body = asJsonRecord(value);
  if (body.status !== "approved" && body.status !== "rejected") {
    return { ok: false, detail: "status must be approved or rejected" };
  }
  if (typeof body.legalHold !== "boolean") {
    return { ok: false, detail: "legalHold must be a boolean" };
  }
  let retentionUntil: string | null = null;
  if (body.retentionUntil != null) {
    if (typeof body.retentionUntil !== "string" || Number.isNaN(Date.parse(body.retentionUntil))) {
      return { ok: false, detail: "retentionUntil must be an ISO date when supplied" };
    }
    retentionUntil = new Date(body.retentionUntil).toISOString();
  }
  if (body.status === "approved" && body.legalHold && !retentionUntil) {
    return { ok: false, detail: "retentionUntil is required when legalHold is true" };
  }
  if (body.decisionNote != null && typeof body.decisionNote !== "string") {
    return { ok: false, detail: "decisionNote must be a string when supplied" };
  }
  const workflowSubmissionDisposition =
    body.workflowSubmissionDisposition ?? "retain";
  if (
    workflowSubmissionDisposition !== "retain" &&
    workflowSubmissionDisposition !== "anonymize" &&
    workflowSubmissionDisposition !== "delete"
  ) {
    return {
      ok: false,
      detail:
        "workflowSubmissionDisposition must be retain, anonymize, or delete when supplied",
    };
  }
  return {
    ok: true,
    status: body.status,
    legalHold: body.legalHold,
    retentionUntil,
    decisionNote:
      typeof body.decisionNote === "string"
        ? body.decisionNote.trim().slice(0, 4000) || null
        : null,
    workflowSubmissionDisposition,
  };
}

export async function reviewDataDeletionRequest(input: {
  requestId: string;
  reviewerUserId: string;
  status: "approved" | "rejected";
  legalHold: boolean;
  retentionUntil: string | null;
  decisionNote: string | null;
  workflowSubmissionDisposition: WorkflowSubmissionDisposition;
}) {
  const updated = await one(
    `update data_deletion_requests
        set status = $2,
            legal_hold = $3,
            retention_until = $4,
            decision_note = $5,
            reviewed_by_user_id = $6,
            workflow_submission_disposition = $7,
            reviewed_at = now(),
            updated_at = now()
      where id = $1 and status = 'pending_legal_review'
      returning id, user_id, status, legal_hold, retention_until, requested_at,
                reviewed_at, decision_note, workflow_submission_disposition`,
    [
      input.requestId,
      input.status,
      input.legalHold,
      input.retentionUntil,
      input.decisionNote,
      input.reviewerUserId,
      input.workflowSubmissionDisposition,
    ],
  );
  if (!updated) throw new Error("Deletion request was not found or has already been reviewed");
  return updated;
}

async function storagePathsForUser(client: PoolClient, userId: string) {
  const result = await client.query<{ storage_path: string | null; pdf_storage_path: string | null }>(
    `select v.storage_path, v.pdf_storage_path
       from document_versions v
       join documents d on d.id = v.document_id
      where d.user_id = $1`,
    [userId],
  );
  const paths = new Set<string>();
  for (const row of result.rows) {
    if (row.storage_path) paths.add(row.storage_path);
    if (row.pdf_storage_path) paths.add(row.pdf_storage_path);
  }
  return [...paths];
}

async function removeExternalSharedAccess(client: PoolClient, userId: string) {
  const account = await client.query<{ email: string }>(
    "select email from app_users where id = $1",
    [userId],
  );
  const email = account.rows[0]?.email.trim().toLowerCase();
  if (!email) return;
  for (const table of ["projects", "tabular_reviews"] as const) {
    await client.query(
      `update ${table}
          set shared_with = coalesce(
            (
              select jsonb_agg(entry)
                from jsonb_array_elements_text(shared_with) as entry
               where lower(entry) <> lower($1)
            ),
            '[]'::jsonb
          )
        where shared_with @> jsonb_build_array($1::text)`,
      [email],
    );
  }
  await client.query(
    "delete from workflow_shares where lower(shared_with_email) = lower($1)",
    [email],
  );
}

async function applyWorkflowSubmissionDisposition(
  client: PoolClient,
  userId: string,
  disposition: WorkflowSubmissionDisposition,
) {
  if (disposition === "retain") return;
  if (disposition === "delete") {
    await client.query(
      "delete from workflow_open_source_submissions where submitted_by_user_id = $1",
      [userId],
    );
    return;
  }

  // A submission's snapshot is deliberately portable and has no Docket
  // identity fields. Preserve the review artifact while removing its public
  // attribution/contact data and making the retained snapshot's attribution
  // unambiguously community-owned. The tombstoned app_users row remains the
  // legal/audit linkage; nothing here affects the Entra identity.
  await client.query(
    `update workflow_open_source_submissions
        set submitted_by_email = null,
            public_name = null,
            attribution = 'docket-community',
            snapshot = jsonb_set(
              snapshot,
              '{metadata,attribution}',
              '{"mode":"docket-community","name":null}'::jsonb,
              true
            ),
            updated_at = now()
      where submitted_by_user_id = $1`,
    [userId],
  );
}

async function deleteDocketRows(
  client: PoolClient,
  userId: string,
  workflowSubmissionDisposition: WorkflowSubmissionDisposition,
) {
  // Deleting app_users would not delete the Entra account, and an Entra login
  // could recreate it. Keep the identity record as a tombstone instead.
  await removeExternalSharedAccess(client, userId);
  await client.query("delete from user_mcp_connectors where user_id = $1", [userId]);
  await client.query("delete from user_mcp_oauth_states where user_id = $1", [userId]);
  await client.query("delete from user_mcp_tool_audit_logs where user_id = $1", [userId]);
  await client.query("delete from user_api_keys where user_id = $1", [userId]);
  // Keep aggregate accounting intact, but detach it from the deleted user's
  // identity and their content-bearing chat/project records.
  await client.query(
    `update llm_usage_events
        set user_id = null,
            chat_id = null,
            project_id = null
      where user_id = $1`,
    [userId],
  );
  await client.query("delete from chats where user_id = $1", [userId]);
  await client.query("delete from tabular_review_chats where user_id = $1", [userId]);
  await client.query("delete from tabular_reviews where user_id = $1", [userId]);
  await client.query("delete from documents where user_id = $1", [userId]);
  await client.query("delete from projects where user_id = $1", [userId]);
  await client.query("delete from hidden_workflows where user_id = $1", [userId]);
  await client.query("delete from workflow_shares where shared_by_user_id = $1", [userId]);
  await applyWorkflowSubmissionDisposition(
    client,
    userId,
    workflowSubmissionDisposition,
  );
  await client.query("delete from workflows where user_id = $1", [userId]);
  await client.query("delete from user_profiles where user_id = $1", [userId]);
  await client.query(
    "update app_users set docket_data_status = 'deleted', updated_at = now() where id = $1",
    [userId],
  );
}

export async function executeApprovedDataDeletion(input: {
  requestId: string;
  executorUserId: string;
}) {
  const client = await pool.connect();
  let userId: string | null = null;
  let storagePaths: string[] = [];
  try {
    await client.query("begin");
    const request = await client.query<{
      id: string;
      user_id: string;
      legal_hold: boolean;
      retention_until: string | null;
      workflow_submission_disposition: WorkflowSubmissionDisposition | null;
    }>(
      `select id, user_id, legal_hold, retention_until,
              workflow_submission_disposition
         from data_deletion_requests
        where id = $1 and status = 'approved'
        for update`,
      [input.requestId],
    );
    const row = request.rows[0];
    if (!row) throw new Error("Deletion request is not approved or no longer exists");
    if (row.legal_hold) throw new Error("Deletion request is subject to a legal hold");
    if (row.retention_until && new Date(row.retention_until).getTime() > Date.now()) {
      throw new Error("Deletion request cannot execute before the retention date");
    }
    userId = row.user_id;
    storagePaths = await storagePathsForUser(client, userId);
    await deleteDocketRows(
      client,
      userId,
      row.workflow_submission_disposition ?? "retain",
    );
    await client.query(
      `update data_deletion_requests
          set status = 'completed', completed_at = now(), executed_by_user_id = $2,
              updated_at = now()
        where id = $1`,
      [input.requestId, input.executorUserId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (userId && storagePaths.length) {
    // Blob removal happens after the database transaction. An orphan is safer
    // than reporting a completed deletion while the database is inconsistent.
    await Promise.all(
      storagePaths.map((path) => deleteFile(path).catch(() => undefined)),
    );
  }
}
