import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  buildWorkflowZip,
  workflowExportFilename,
} from "../lib/workflowExport";
import { safeErrorLog } from "../lib/safeError";
import {
  SYSTEM_WORKFLOWS,
  SYSTEM_WORKFLOW_IDS,
  type SystemWorkflow,
} from "../lib/systemWorkflows";
import {
  buildWorkflowContributionSnapshot,
  isWorkflowContributionReviewStatus,
  parseWorkflowContributionRequest,
  validateWorkflowForContribution,
  type WorkflowContributionStatus,
  type WorkflowContributionWorkflow,
} from "../lib/workflowContributions";
import { isAdminUser } from "../lib/userRoles";

export const workflowsRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;

type WorkflowRecord = {
  id: string;
  user_id: string | null;
  is_system: boolean;
  title?: string;
  type?: "assistant" | "tabular";
  prompt_md?: string | null;
  columns_config?: unknown;
  language?: string | null;
  practice?: string | null;
  jurisdictions?: string[] | null;
  created_at?: string;
  [key: string]: unknown;
};

type WorkflowType = "assistant" | "tabular";
type OpenSourceSubmissionRow = {
  id: string;
  workflow_id: string;
  submitted_by_user_id: string;
  attribution: "named" | "docket-community";
  public_name: string | null;
  status: WorkflowContributionStatus;
  submitted_at: string;
  updated_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
};

type WorkflowAccess =
  | {
      workflow: WorkflowRecord;
      allowEdit: boolean;
      isOwner: boolean;
    }
  | null;

function cleanText(value: unknown, fallback: string | null = null) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
}

function cleanJurisdictions(value: unknown) {
  const raw = Array.isArray(value) ? value : [];
  const jurisdictions = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
  return jurisdictions.length ? jurisdictions : ["General"];
}

function validateWorkflowPayload(value: {
  title?: unknown;
  prompt_md?: unknown;
  columns_config?: unknown;
}) {
  if (value.title != null) {
    const title = cleanText(value.title);
    if (!title || title.length > 160) {
      return "title must be between 1 and 160 characters";
    }
  }
  if (typeof value.prompt_md === "string" && value.prompt_md.length > 100_000) {
    return "prompt_md must be at most 100000 characters";
  }
  if (Array.isArray(value.columns_config) && value.columns_config.length > 100) {
    return "columns_config may contain at most 100 columns";
  }
  return null;
}

function workflowType(value: unknown): WorkflowType | null {
  return value === "assistant" || value === "tabular" ? value : null;
}

function systemWorkflowDescription(workflow: SystemWorkflow) {
  if (workflow.description?.trim()) return workflow.description.trim();
  if (workflow.type === "tabular") {
    return `Extract structured ${workflow.title.toLowerCase()} findings from selected documents.`;
  }
  return `Apply Docket's ${workflow.title.toLowerCase()} instructions to selected documents.`;
}

function withSystemWorkflowAccess(workflow: SystemWorkflow) {
  return withWorkflowAccess(
    {
      ...workflow,
      language: workflow.language ?? "English",
      practice: workflow.practice ?? "General Transactions",
      jurisdictions: workflow.jurisdictions ?? ["General"],
      description: systemWorkflowDescription(workflow),
      version: workflow.version ?? "docket-system-v1",
    },
    { allowEdit: false, isOwner: false },
  );
}

function systemWorkflowById(workflowId: string) {
  return SYSTEM_WORKFLOWS.find((workflow) => workflow.id === workflowId) ?? null;
}

function asContributionWorkflow(workflow: WorkflowRecord): WorkflowContributionWorkflow | null {
  const type = workflowType(workflow.type);
  if (!type || typeof workflow.title !== "string") return null;
  return {
    id: workflow.id,
    title: workflow.title,
    type,
    prompt_md: workflow.prompt_md ?? null,
    columns_config: workflow.columns_config ?? null,
    language: workflow.language ?? null,
    practice: workflow.practice ?? null,
    jurisdictions: workflow.jurisdictions ?? null,
  };
}

function submissionSummary(row: OpenSourceSubmissionRow) {
  return {
    id: row.id,
    attribution: row.attribution,
    public_name: row.public_name,
    status: row.status,
    submitted_at: row.submitted_at,
    updated_at: row.updated_at,
    reviewed_at: row.reviewed_at,
    review_notes: row.review_notes,
  };
}

async function latestSubmissionForOwner(
  db: Db,
  workflowId: string,
  userId: string,
): Promise<{ data: OpenSourceSubmissionRow | null; error: { message: string } | null }> {
  const { data, error } = await db
    .from("workflow_open_source_submissions")
    .select(
      "id, workflow_id, submitted_by_user_id, attribution, public_name, status, submitted_at, updated_at, reviewed_at, review_notes",
    )
    .eq("workflow_id", workflowId)
    .eq("submitted_by_user_id", userId)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return {
    data: (data as OpenSourceSubmissionRow | null) ?? null,
    error,
  };
}

function withWorkflowAccess<T extends Record<string, unknown>>(
  workflow: T,
  access: { allowEdit: boolean; isOwner: boolean; sharedByName?: string | null },
) {
  return {
    ...workflow,
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

async function resolveWorkflowAccess(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<WorkflowAccess> {
  const { data: workflow } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .single();
  if (!workflow) return null;
  const workflowRecord = workflow as WorkflowRecord;
  if (workflowRecord.user_id === userId) {
    return { workflow: workflowRecord, allowEdit: true, isOwner: true };
  }

  const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();
  if (!normalizedUserEmail) return null;

  const { data: share } = await db
    .from("workflow_shares")
    .select("allow_edit")
    .eq("workflow_id", workflowId)
    .eq("shared_with_email", normalizedUserEmail)
    .maybeSingle();
  if (!share) return null;

  return { workflow: workflowRecord, allowEdit: !!share.allow_edit, isOwner: false };
}

// GET /workflows
workflowsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { type: rawType } = req.query as { type?: string };
  const type = rawType == null ? null : workflowType(rawType);
  if (rawType != null && !type) {
    return void res.status(400).json({ detail: "type must be 'assistant' or 'tabular'" });
  }
  const db = createServerSupabase();

  // Own workflows
  let ownQuery = db
    .from("workflows")
    .select("*")
    .eq("user_id", userId)
    .eq("is_system", false)
    .order("created_at", { ascending: false });
  if (type) ownQuery = ownQuery.eq("type", type);
  const { data: own, error: ownErr } = await ownQuery;
  if (ownErr) return void res.status(500).json({ detail: ownErr.message });

  // Shared workflows (where the current user's email appears in workflow_shares)
  const normalizedUserEmail = userEmail.trim().toLowerCase();
  const { data: shares } = await db
    .from("workflow_shares")
    .select("workflow_id, shared_by_user_id, allow_edit")
    .eq("shared_with_email", normalizedUserEmail);

  let sharedWorkflows: Record<string, unknown>[] = [];
  if (shares && shares.length > 0) {
    const sharedIds = shares.map((s) => s.workflow_id);
    let sharedQuery = db.from("workflows").select("*").in("id", sharedIds);
    if (type) sharedQuery = sharedQuery.eq("type", type);
    const { data: wfs } = await sharedQuery;

    if (wfs && wfs.length > 0) {
      // Fetch sharer profiles
      const sharerIds = [...new Set(shares.map((s) => s.shared_by_user_id).filter(Boolean))];
      const { data: profiles } = sharerIds.length > 0
        ? await db.from("user_profiles").select("user_id, display_name").in("user_id", sharerIds)
        : { data: [] };

      // Fetch sharer emails via admin client
      const { data: authData } = await db.auth.admin.listUsers({ perPage: 1000 });
      const authUsers = authData?.users ?? [];

      sharedWorkflows = wfs.map((wf) => {
        const share = shares.find((s) => s.workflow_id === wf.id);
        const sharerId = share?.shared_by_user_id;
        const profile = profiles?.find((p) => p.user_id === sharerId);
        const authUser = authUsers.find((u) => u.id === sharerId);
        const shared_by_name = profile?.display_name || authUser?.email || null;
        return withWorkflowAccess(wf, {
          allowEdit: !!share?.allow_edit,
          isOwner: false,
          sharedByName: shared_by_name,
        });
      });
    }
  }

  const ownWithFlag = (own ?? []).map((wf) =>
    withWorkflowAccess(wf, { allowEdit: true, isOwner: true }),
  );
  const systemWorkflows = SYSTEM_WORKFLOWS
    .filter((workflow) => !type || workflow.type === type)
    .map(withSystemWorkflowAccess);
  const databaseWorkflows = [...ownWithFlag, ...sharedWorkflows].filter(
    (workflow) => !SYSTEM_WORKFLOW_IDS.has(String(workflow.id)),
  );

  // System workflows live in the application image, while user workflows live
  // in Azure PostgreSQL. Returning them together makes this endpoint the one
  // catalog the authenticated Docket client uses.
  res.json([...systemWorkflows, ...databaseWorkflows]);
});

// POST /workflows
workflowsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const {
    title,
    type,
    prompt_md,
    columns_config,
    language,
    practice,
    jurisdictions,
  } = req.body as {
    title: string;
    type: string;
    prompt_md?: string;
    columns_config?: unknown;
    language?: string | null;
    practice?: string | null;
    jurisdictions?: string[] | null;
  };
  const payloadError = validateWorkflowPayload({ title, prompt_md, columns_config });
  if (payloadError) return void res.status(400).json({ detail: payloadError });
  if (!title?.trim())
    return void res.status(400).json({ detail: "title is required" });
  if (!["assistant", "tabular"].includes(type))
    return void res
      .status(400)
      .json({ detail: "type must be 'assistant' or 'tabular'" });

  const db = createServerSupabase();
  const { data, error } = await db
    .from("workflows")
    .insert({
      user_id: userId,
      title: title.trim(),
      type,
      prompt_md: prompt_md ?? null,
      columns_config: columns_config ?? null,
      language: cleanText(language, "English"),
      practice: cleanText(practice, "General Transactions"),
      jurisdictions: cleanJurisdictions(jurisdictions),
      is_system: false,
    })
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(withWorkflowAccess(data, { allowEdit: true, isOwner: true }));
});

async function handleWorkflowUpdate(req: import("express").Request, res: import("express").Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const updates: Record<string, unknown> = {};
  const payloadError = validateWorkflowPayload(req.body as Record<string, unknown>);
  if (payloadError) return void res.status(400).json({ detail: payloadError });
  if (req.body.title != null) updates.title = cleanText(req.body.title);
  if (req.body.prompt_md != null) updates.prompt_md = req.body.prompt_md;
  if (req.body.columns_config != null)
    updates.columns_config = req.body.columns_config;
  if ("language" in req.body)
    updates.language = cleanText(req.body.language, "English");
  if ("practice" in req.body)
    updates.practice = cleanText(req.body.practice, "General Transactions");
  if ("jurisdictions" in req.body)
    updates.jurisdictions = cleanJurisdictions(req.body.jurisdictions);

  const db = createServerSupabase();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access || access.workflow.is_system || !access.allowEdit) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  const { data, error } = await db
    .from("workflows")
    .update(updates)
    .eq("id", workflowId)
    .eq("is_system", false)
    .select("*")
    .single();
  if (error || !data)
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  res.json(
    withWorkflowAccess(data, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
}

// PUT /workflows/:workflowId
workflowsRouter.put("/:workflowId", requireAuth, handleWorkflowUpdate);

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, handleWorkflowUpdate);

// DELETE /workflows/:workflowId
workflowsRouter.delete("/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  if (systemWorkflowById(workflowId)) {
    return void res.status(400).json({
      detail: "System workflows are read-only. Hide them instead of deleting them.",
    });
  }
  const db = createServerSupabase();
  const { error } = await db
    .from("workflows")
    .delete()
    .eq("id", workflowId)
    .eq("user_id", userId)
    .eq("is_system", false);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /workflows/hidden
workflowsRouter.get("/hidden", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("hidden_workflows")
    .select("workflow_id")
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json((data ?? []).map((r) => r.workflow_id));
});

// POST /workflows/hidden
workflowsRouter.post("/hidden", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflow_id } = req.body as { workflow_id: string };
  if (!workflow_id?.trim())
    return void res.status(400).json({ detail: "workflow_id is required" });
  if (!SYSTEM_WORKFLOW_IDS.has(workflow_id)) {
    return void res.status(400).json({ detail: "Only Docket system workflows can be hidden" });
  }
  const db = createServerSupabase();
  const { error } = await db
    .from("hidden_workflows")
    .upsert({ user_id: userId, workflow_id }, { onConflict: "user_id,workflow_id" });
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete("/hidden/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const { error } = await db
    .from("hidden_workflows")
    .delete()
    .eq("user_id", userId)
    .eq("workflow_id", workflowId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// The reviewer queue is deliberately Docket-admin-only. A submission is a
// stored review artifact, never an automatic write to GitHub or another
// public service.
workflowsRouter.get("/open-source-submissions/review", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  if (!(await isAdminUser(db, userId))) {
    return void res.status(403).json({ detail: "Docket administrator access is required" });
  }
  const status = req.query.status;
  const allowedStatuses: WorkflowContributionStatus[] = [
    "pending_review",
    "accepted",
    "declined",
    "withdrawn",
  ];
  if (status != null && (typeof status !== "string" || !allowedStatuses.includes(status as WorkflowContributionStatus))) {
    return void res.status(400).json({ detail: "Unknown submission status" });
  }
  let query = db
    .from("workflow_open_source_submissions")
    .select(
      "id, workflow_id, submitted_by_user_id, submitted_by_email, attribution, public_name, status, submitted_at, updated_at, reviewed_at, reviewed_by_user_id, review_notes",
    )
    .order("submitted_at", { ascending: false })
    .limit(100);
  if (typeof status === "string") query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data ?? []);
});

workflowsRouter.get("/open-source-submissions/:submissionId/review", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  if (!(await isAdminUser(db, userId))) {
    return void res.status(403).json({ detail: "Docket administrator access is required" });
  }
  const { data, error } = await db
    .from("workflow_open_source_submissions")
    .select("*")
    .eq("id", req.params.submissionId)
    .maybeSingle();
  if (error) return void res.status(500).json({ detail: error.message });
  if (!data) return void res.status(404).json({ detail: "Submission not found" });
  res.json(data);
});

workflowsRouter.patch("/open-source-submissions/:submissionId/review", requireAuth, async (req, res) => {
  const reviewerUserId = res.locals.userId as string;
  const db = createServerSupabase();
  if (!(await isAdminUser(db, reviewerUserId))) {
    return void res.status(403).json({ detail: "Docket administrator access is required" });
  }
  if (!isWorkflowContributionReviewStatus(req.body?.status)) {
    return void res.status(400).json({ detail: "status must be 'accepted' or 'declined'" });
  }
  const reviewNotes = cleanText(req.body?.review_notes, null);
  if (typeof reviewNotes === "string" && reviewNotes.length > 5_000) {
    return void res.status(400).json({ detail: "review_notes must be at most 5000 characters" });
  }
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("workflow_open_source_submissions")
    .update({
      status: req.body.status,
      review_notes: reviewNotes,
      reviewed_at: now,
      reviewed_by_user_id: reviewerUserId,
      updated_at: now,
    })
    .eq("id", req.params.submissionId)
    .eq("status", "pending_review")
    .select(
      "id, workflow_id, submitted_by_user_id, attribution, public_name, status, submitted_at, updated_at, reviewed_at, review_notes",
    )
    .maybeSingle();
  if (error) return void res.status(500).json({ detail: error.message });
  if (!data) {
    return void res.status(409).json({
      detail: "Only a pending review submission can be decided.",
    });
  }
  res.json(submissionSummary(data as OpenSourceSubmissionRow));
});

// POST /workflows/:workflowId/open-source-submissions
// Authenticated owners may submit their own workflow for manual Docket review.
// The snapshot omits Entra identity, documents, chats, sharing data, and all
// connector material. No public publishing happens from this endpoint.
workflowsRouter.post("/:workflowId/open-source-submissions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const parsed = parseWorkflowContributionRequest(req.body);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });
  if (systemWorkflowById(req.params.workflowId)) {
    return void res.status(400).json({ detail: "Only your custom workflows can be submitted." });
  }

  const db = createServerSupabase();
  const { data: rawWorkflow, error: workflowError } = await db
    .from("workflows")
    .select("*")
    .eq("id", req.params.workflowId)
    .eq("user_id", userId)
    .eq("is_system", false)
    .maybeSingle();
  if (workflowError) return void res.status(500).json({ detail: workflowError.message });
  if (!rawWorkflow) {
    return void res.status(404).json({ detail: "Workflow not found or not eligible for submission" });
  }

  const workflow = asContributionWorkflow(rawWorkflow as WorkflowRecord);
  if (!workflow) {
    return void res.status(400).json({ detail: "Workflow has an unsupported type" });
  }
  const validationError = validateWorkflowForContribution(workflow);
  if (validationError) return void res.status(400).json({ detail: validationError });

  const now = new Date().toISOString();
  const snapshot = buildWorkflowContributionSnapshot(workflow, parsed.request);
  const { data: pending, error: pendingError } = await db
    .from("workflow_open_source_submissions")
    .select("id")
    .eq("workflow_id", workflow.id)
    .eq("submitted_by_user_id", userId)
    .eq("status", "pending_review")
    .maybeSingle();
  if (pendingError) return void res.status(500).json({ detail: pendingError.message });

  if (pending) {
    const { data, error } = await db
      .from("workflow_open_source_submissions")
      .update({
        submitted_by_email: userEmail ?? null,
        attribution: parsed.request.attribution,
        public_name: parsed.request.publicName,
        snapshot,
        updated_at: now,
      })
      .eq("id", pending.id)
      .select(
        "id, workflow_id, submitted_by_user_id, attribution, public_name, status, submitted_at, updated_at, reviewed_at, review_notes",
      )
      .single();
    if (error || !data) {
      return void res.status(500).json({ detail: error?.message ?? "Unable to update submission" });
    }
    return void res.json({ ...submissionSummary(data as OpenSourceSubmissionRow), mode: "updated" });
  }

  const { data, error } = await db
    .from("workflow_open_source_submissions")
    .insert({
      workflow_id: workflow.id,
      submitted_by_user_id: userId,
      submitted_by_email: userEmail ?? null,
      attribution: parsed.request.attribution,
      public_name: parsed.request.publicName,
      status: "pending_review",
      snapshot,
      submitted_at: now,
      updated_at: now,
    })
    .select(
      "id, workflow_id, submitted_by_user_id, attribution, public_name, status, submitted_at, updated_at, reviewed_at, review_notes",
    )
    .single();
  if (error || !data) {
    return void res.status(500).json({ detail: error?.message ?? "Unable to create submission" });
  }
  res.status(201).json({ ...submissionSummary(data as OpenSourceSubmissionRow), mode: "created" });
});

workflowsRouter.delete("/:workflowId/open-source-submissions/:submissionId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("workflow_open_source_submissions")
    .update({ status: "withdrawn", withdrawn_at: now, updated_at: now })
    .eq("id", req.params.submissionId)
    .eq("workflow_id", req.params.workflowId)
    .eq("submitted_by_user_id", userId)
    .eq("status", "pending_review")
    .select(
      "id, workflow_id, submitted_by_user_id, attribution, public_name, status, submitted_at, updated_at, reviewed_at, review_notes",
    )
    .maybeSingle();
  if (error) return void res.status(500).json({ detail: error.message });
  if (!data) {
    return void res.status(409).json({ detail: "Only your pending submission can be withdrawn." });
  }
  res.json(submissionSummary(data as OpenSourceSubmissionRow));
});

// GET /workflows/:workflowId/export
// Exports only a workflow's portable instructions/configuration. It does not
// include documents, chat history, API credentials, or connector secrets.
workflowsRouter.get("/:workflowId/export", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  const systemWorkflow = systemWorkflowById(req.params.workflowId);
  const access = systemWorkflow
    ? null
    : await resolveWorkflowAccess(
        req.params.workflowId,
        userId,
        userEmail,
        db,
      );
  const workflow = systemWorkflow ?? access?.workflow;
  if (!workflow) return void res.status(404).json({ detail: "Workflow not found" });
  try {
    const archive = await buildWorkflowZip(workflow);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${workflowExportFilename(workflow)}"`,
    );
    res.status(200).send(archive);
  } catch (error) {
    console.error("[workflows/export] failed", {
      workflowId: req.params.workflowId,
      error: safeErrorLog(error),
    });
    res.status(500).json({ detail: "Unable to export workflow" });
  }
});

// GET /workflows/:workflowId
workflowsRouter.get("/:workflowId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const systemWorkflow = systemWorkflowById(workflowId);
  if (systemWorkflow) {
    return void res.json(withSystemWorkflowAccess(systemWorkflow));
  }
  const db = createServerSupabase();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access)
    return void res.status(404).json({ detail: "Workflow not found" });
  const latestSubmission = access.isOwner
    ? await latestSubmissionForOwner(db, workflowId, userId)
    : { data: null, error: null };
  if (latestSubmission.error) {
    return void res.status(500).json({ detail: latestSubmission.error.message });
  }
  res.json(
    {
      ...withWorkflowAccess(access.workflow, {
        allowEdit: access.allowEdit,
        isOwner: access.isOwner,
      }),
      open_source_submission: latestSubmission.data
        ? submissionSummary(latestSubmission.data)
        : null,
    },
  );
});

// GET /workflows/:workflowId/shares
workflowsRouter.get("/:workflowId/shares", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();

  const { data: wf } = await db
    .from("workflows")
    .select("id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .eq("is_system", false)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

  const { data: shares, error } = await db
    .from("workflow_shares")
    .select("id, shared_with_email, allow_edit, created_at")
    .eq("workflow_id", workflowId)
    .order("created_at", { ascending: true });
  if (error) return void res.status(500).json({ detail: error.message });

  res.json(shares ?? []);
});

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete("/:workflowId/shares/:shareId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId, shareId } = req.params;
  const db = createServerSupabase();

  const { data: wf } = await db
    .from("workflows")
    .select("id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found" });

  await db.from("workflow_shares").delete().eq("id", shareId).eq("workflow_id", workflowId);
  res.status(204).send();
});

// POST /workflows/:workflowId/share
workflowsRouter.post("/:workflowId/share", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const { emails, allow_edit } = req.body as { emails: string[]; allow_edit: boolean };

  if (!emails?.length) return void res.status(400).json({ detail: "emails is required" });
  const normalizedEmails = [
    ...new Set(
      emails
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (normalizedEmails.length === 0) {
    return void res.status(400).json({ detail: "emails is required" });
  }
  const normalizedUserEmail = userEmail?.trim().toLowerCase();
  if (normalizedUserEmail && normalizedEmails.includes(normalizedUserEmail)) {
    return void res
      .status(400)
      .json({ detail: "You cannot share a workflow with yourself." });
  }

  const db = createServerSupabase();
  // Verify ownership
  const { data: wf } = await db
    .from("workflows")
    .select("id")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .eq("is_system", false)
    .single();
  if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

  const rows = normalizedEmails.map((email: string) => ({
    workflow_id: workflowId,
    shared_by_user_id: userId,
    shared_with_email: email,
    allow_edit: allow_edit ?? false,
  }));
  // Upsert on (workflow_id, shared_with_email) so re-sharing to the same
  // person updates the existing row instead of stacking duplicates.
  const { error } = await db
    .from("workflow_shares")
    .upsert(rows, { onConflict: "workflow_id,shared_with_email" });
  if (error) return void res.status(500).json({ detail: error.message });

  res.status(204).send();
});
