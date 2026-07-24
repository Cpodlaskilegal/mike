import crypto from "crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/requireAdmin";
import { createServerSupabase } from "../lib/supabase";
import { isTabularModelId, resolveTabularModel } from "../lib/llm";
import {
  type ApiKeyStatus,
  getUserApiKeyStatus,
  hasEnvApiKey,
  normalizeApiKeyProvider,
  saveUserApiKey,
} from "../lib/userApiKeys";
import {
  completeUserMcpConnectorOAuth,
  createUserMcpConnector,
  createUserMcpConnectorFromPreset,
  deleteUserMcpConnector,
  executeMcpToolApproval,
  getMcpApprovalForUser,
  getUserMcpConnector,
  listUserMcpConnectorPresets,
  listUserMcpConnectors,
  McpApprovalError,
  McpOAuthRequiredError,
  persistMcpApprovalTerminalEvent,
  rejectMcpApproval,
  refreshUserMcpConnectorTools,
  serializeMcpApproval,
  setUserMcpToolEnabled,
  startUserMcpConnectorOAuth,
  type McpApprovalRow,
  updateUserMcpConnector,
} from "../lib/mcpConnectors";
import {
  getUserRole,
  isAdminUser,
  normalizeUserRole,
  type AppUserRole,
} from "../lib/userRoles";
import {
  buildDocketDataExport,
  createDataDeletionRequest,
  dataExportFilename,
  executeApprovedDataDeletion,
  listOwnDataDeletionRequests,
  parseDataExportScope,
  reviewDataDeletionRequest,
  validateDeletionRequestBody,
  validateDeletionReviewBody,
} from "../lib/userDataLifecycle";
import {
  deliverSpendReport,
  getAdminSpendDashboard,
  serializeAdminSpendDashboard,
} from "../lib/llmSpend";
import { safeErrorLog, safeErrorMessage } from "../lib/safeError";

export const userRouter = Router();

const MONTHLY_CREDIT_LIMIT = 999999;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const record = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    return (
      [record.message, record.details, record.hint, record.code]
        .filter(
          (value): value is string => typeof value === "string" && !!value,
        )
        .join(" ") || JSON.stringify(error)
    );
  }
  return String(error);
}

async function persistApprovalTerminalOutcome(
  approval: McpApprovalRow,
): Promise<boolean> {
  try {
    return await persistMcpApprovalTerminalEvent({
      db: createServerSupabase(),
      approval,
    });
  } catch (error) {
    console.error(
      "[user/mcp-approvals] failed to persist terminal chat event",
      {
        approvalId: approval.id,
        assistantMessageId: approval.assistant_message_id,
        error: errorMessage(error),
      },
    );
    return false;
  }
}

function backendPublicUrl(req: {
  protocol: string;
  get(name: string): string | undefined;
}) {
  return (
    process.env.API_PUBLIC_URL ||
    process.env.BACKEND_URL ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/+$/, "");
}

function frontendUrl(path = "/account/connectors") {
  const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  return `${base}${path}`;
}

function shortHash(value: string) {
  return value
    ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)
    : null;
}

function mcpOAuthPopupHtml(
  payload: { success: boolean; connectorId?: string; detail?: string },
  nonce: string,
) {
  const targetOrigin = new URL(frontendUrl()).origin;
  const targetUrl = frontendUrl();
  const message = JSON.stringify({
    type: "mcp_oauth_result",
    ...payload,
  });
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP authorization</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f9fafb; }
      main { max-width: 360px; padding: 24px; text-align: center; }
      p { color: #6b7280; }
    </style>
  </head>
  <body>
    <main>
      <h1>${payload.success ? "Authorization complete" : "Authorization failed"}</h1>
      <p>${payload.success ? "You can return to Docket." : "Return to Docket and try connecting again."}</p>
    </main>
    <script nonce="${nonce}">
      const message = ${message};
      const targetUrl = ${JSON.stringify(targetUrl)};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(message, ${JSON.stringify(targetOrigin)});
      }
      setTimeout(() => window.close(), ${payload.success ? 600 : 2500});
      ${
        payload.success
          ? "setTimeout(() => window.location.assign(targetUrl), 1000);"
          : ""
      }
    </script>
  </body>
</html>`;
}

function mcpOAuthPopupCsp(nonce: string) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function readBooleanBodyField(
  body: unknown,
  key: string,
): { ok: true; value: boolean } | { ok: false; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "Expected a JSON object" };
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "boolean") {
    return { ok: false, detail: `${key} must be a boolean` };
  }
  return { ok: true, value };
}

type UserProfileRow = {
  display_name: string | null;
  organisation: string | null;
  message_credits_used: number;
  credits_reset_date: string;
  tier: string;
  tabular_model: string;
  legal_research_us?: boolean | null;
};

function serializeProfile(
  row: UserProfileRow,
  role: AppUserRole,
  apiKeyStatus?: ApiKeyStatus,
) {
  const creditsUsed = row.message_credits_used ?? 0;
  return {
    displayName: row.display_name,
    organisation: row.organisation,
    messageCreditsUsed: creditsUsed,
    creditsResetDate: row.credits_reset_date,
    creditsRemaining: Math.max(MONTHLY_CREDIT_LIMIT - creditsUsed, 0),
    tier: row.tier || "Free",
    tabularModel: resolveTabularModel(row.tabular_model),
    legalResearchUs: row.legal_research_us !== false,
    role,
    ...(apiKeyStatus ? { apiKeyStatus } : {}),
  };
}

function validateProfilePayload(body: unknown):
  | {
      ok: true;
      update: {
        display_name?: string | null;
        organisation?: string | null;
        tabular_model?: string;
        legal_research_us?: boolean;
        updated_at: string;
      };
    }
  | { ok: false; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "Expected a JSON object" };
  }

  const raw = body as Record<string, unknown>;
  const allowedFields = new Set([
    "displayName",
    "organisation",
    "tabularModel",
    "legalResearchUs",
  ]);
  const invalidField = Object.keys(raw).find((key) => !allowedFields.has(key));
  if (invalidField) {
    return { ok: false, detail: `Unsupported profile field: ${invalidField}` };
  }

  const update: {
    display_name?: string | null;
    organisation?: string | null;
    tabular_model?: string;
    legal_research_us?: boolean;
    updated_at: string;
  } = { updated_at: new Date().toISOString() };

  if ("displayName" in raw) {
    if (raw.displayName !== null && typeof raw.displayName !== "string") {
      return { ok: false, detail: "displayName must be a string or null" };
    }
    update.display_name = raw.displayName?.trim() || null;
  }

  if ("organisation" in raw) {
    if (raw.organisation !== null && typeof raw.organisation !== "string") {
      return { ok: false, detail: "organisation must be a string or null" };
    }
    update.organisation = raw.organisation?.trim() || null;
  }

  if ("tabularModel" in raw) {
    if (typeof raw.tabularModel !== "string") {
      return { ok: false, detail: "tabularModel must be a string" };
    }
    if (!isTabularModelId(raw.tabularModel)) {
      return { ok: false, detail: "Unsupported tabularModel" };
    }
    update.tabular_model = raw.tabularModel;
  }

  if ("legalResearchUs" in raw) {
    if (typeof raw.legalResearchUs !== "boolean") {
      return { ok: false, detail: "legalResearchUs must be a boolean" };
    }
    update.legal_research_us = raw.legalResearchUs;
  }

  return { ok: true, update };
}

async function ensureProfileRow(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
) {
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  return error;
}

async function loadProfile(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  options: { repairMissing?: boolean } = {},
) {
  const profileSelect =
    "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, legal_research_us";
  const legacyProfileSelect =
    "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model";
  let { data, error } = await db
    .from("user_profiles")
    .select(profileSelect)
    .eq("user_id", userId)
    .maybeSingle();
  if (error && (error as { code?: string }).code === "42703") {
    const legacy = await db
      .from("user_profiles")
      .select(legacyProfileSelect)
      .eq("user_id", userId)
      .maybeSingle();
    data = legacy.data
      ? { ...legacy.data, legal_research_us: true }
      : legacy.data;
    error = legacy.error;
  }

  if (error) return { data: null, error };
  if (!data) {
    if (!options.repairMissing) {
      return { data: null, error: new Error("Profile not found") };
    }

    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return { data: null, error: ensureError };

    const created = await db
      .from("user_profiles")
      .select(profileSelect)
      .eq("user_id", userId)
      .single();
    if (
      created.error &&
      (created.error as { code?: string }).code === "42703"
    ) {
      const legacyCreated = await db
        .from("user_profiles")
        .select(legacyProfileSelect)
        .eq("user_id", userId)
        .single();
      if (legacyCreated.error) {
        return { data: null, error: legacyCreated.error };
      }
      data = { ...legacyCreated.data, legal_research_us: true };
    } else {
      if (created.error) return { data: null, error: created.error };
      data = created.data;
    }
  }

  let row = data as UserProfileRow;
  if (row.credits_reset_date && new Date() > new Date(row.credits_reset_date)) {
    const creditsResetDate = new Date();
    creditsResetDate.setDate(creditsResetDate.getDate() + 30);
    let { data: resetData, error: resetError } = await db
      .from("user_profiles")
      .update({
        message_credits_used: 0,
        credits_reset_date: creditsResetDate.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, legal_research_us",
      )
      .single();
    if (resetError && (resetError as { code?: string }).code === "42703") {
      const legacyReset = await db
        .from("user_profiles")
        .select(legacyProfileSelect)
        .eq("user_id", userId)
        .single();
      resetData = legacyReset.data
        ? { ...legacyReset.data, legal_research_us: true }
        : legacyReset.data;
      resetError = legacyReset.error;
    }

    if (resetError) return { data: null, error: resetError };
    row = resetData as UserProfileRow;
  }

  const role = await getUserRole(db, userId);
  return { data: serializeProfile(row, role), error: null };
}

async function isCurrentUserAdmin(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
) {
  return isAdminUser(db, userId);
}

// POST /user/profile
userRouter.post("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const error = await ensureProfileRow(db, userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await loadProfile(db, userId, {
    repairMissing: true,
  });
  if (error) return void res.status(500).json({ detail: error.message });
  const apiKeyStatus = await getUserApiKeyStatus(userId, db);
  res.json({ ...data, apiKeyStatus });
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsed = validateProfilePayload(req.body);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

  const db = createServerSupabase();
  const ensureError = await ensureProfileRow(db, userId);
  if (ensureError)
    return void res.status(500).json({ detail: ensureError.message });

  const { error: updateError } = await db
    .from("user_profiles")
    .update(parsed.update)
    .eq("user_id", userId);
  if (updateError)
    return void res.status(500).json({ detail: updateError.message });

  const { data, error } = await loadProfile(db, userId);
  if (error) return void res.status(500).json({ detail: error.message });
  const apiKeyStatus = await getUserApiKeyStatus(userId, db);
  res.json({ ...data, apiKeyStatus });
});

// GET /user/api-keys
userRouter.get("/api-keys", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const status = await getUserApiKeyStatus(userId, db);
  res.json(status);
});

// PUT /user/api-keys/:provider
userRouter.put("/api-keys/:provider", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const provider = normalizeApiKeyProvider(req.params.provider);
  if (!provider)
    return void res.status(400).json({ detail: "Unsupported provider" });

  const apiKey =
    typeof req.body?.api_key === "string" ? req.body.api_key : null;
  const db = createServerSupabase();
  try {
    if (hasEnvApiKey(provider)) {
      return void res.status(409).json({
        detail:
          "This provider is configured by the server environment and cannot be changed from the browser.",
      });
    }
    await saveUserApiKey(userId, provider, apiKey, db);
    const status = await getUserApiKeyStatus(userId, db);
    res.json(status);
  } catch (err) {
    console.error("[user/api-keys] save failed", {
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ detail: "Failed to save API key" });
  }
});

// GET /user/admin/users
userRouter.get("/admin/users", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  if (!(await isCurrentUserAdmin(db, userId))) {
    return void res.status(403).json({ detail: "Admin access required" });
  }

  const { data: users, error: usersError } = await db
    .from("app_users")
    .select("id, email, role, created_at, updated_at")
    .order("created_at", { ascending: true });
  if (usersError)
    return void res.status(500).json({ detail: usersError.message });

  const ids = ((users ?? []) as { id: string }[]).map((u) => u.id);
  const profilesById = new Map<
    string,
    { display_name: string | null; organisation: string | null }
  >();
  if (ids.length) {
    const { data: profiles, error: profilesError } = await db
      .from("user_profiles")
      .select("user_id, display_name, organisation")
      .in("user_id", ids);
    if (profilesError)
      return void res.status(500).json({ detail: profilesError.message });
    for (const profile of profiles ?? []) {
      profilesById.set(profile.user_id as string, {
        display_name: (profile.display_name as string | null) ?? null,
        organisation: (profile.organisation as string | null) ?? null,
      });
    }
  }

  res.json(
    ((users ?? []) as Record<string, unknown>[]).map((user) => ({
      id: user.id,
      email: user.email,
      role: normalizeUserRole(user.role) ?? "user",
      displayName: profilesById.get(String(user.id))?.display_name ?? null,
      organisation: profilesById.get(String(user.id))?.organisation ?? null,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      isCurrentUser: user.id === userId,
    })),
  );
});

// GET /user/admin/spend-reports
// Financial totals cover Docket-managed GPT and Claude usage only.
userRouter.get(
  "/admin/spend-reports",
  requireAuth,
  requireAdmin,
  async (_req, res) => {
    try {
      const dashboard = await getAdminSpendDashboard();
      res.json(serializeAdminSpendDashboard(dashboard));
    } catch (error) {
      console.error("[user/admin/spend-reports] load failed", safeErrorLog(error));
      res.status(500).json({ detail: "Unable to load account spend reports" });
    }
  },
);

// POST /user/admin/spend-reports/:reportId/deliver
// Lets an administrator retry a persisted report after a mail configuration or
// provider outage is resolved. The report itself remains idempotent by id.
userRouter.post(
  "/admin/spend-reports/:reportId/deliver",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const result = await deliverSpendReport(req.params.reportId);
    if (result.status === "not_found") {
      return void res.status(404).json({ detail: "Spend report not found" });
    }
    res.json({
      status: result.status,
      error: result.error,
      deliveries: result.deliveries,
    });
  },
);

// PATCH /user/admin/users/:targetUserId/role
userRouter.patch(
  "/admin/users/:targetUserId/role",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const { targetUserId } = req.params;
    const role = normalizeUserRole(req.body?.role);
    if (!role) return void res.status(400).json({ detail: "Invalid role" });

    const db = createServerSupabase();
    if (!(await isCurrentUserAdmin(db, userId))) {
      return void res.status(403).json({ detail: "Admin access required" });
    }

    if (role === "user") {
      const { data: admins, error: adminError } = await db
        .from("app_users")
        .select("id")
        .eq("role", "admin");
      if (adminError)
        return void res.status(500).json({ detail: adminError.message });
      const adminIds = ((admins ?? []) as { id: string }[]).map((u) => u.id);
      if (adminIds.length <= 1 && adminIds.includes(targetUserId)) {
        return void res
          .status(400)
          .json({ detail: "At least one admin is required." });
      }
    }

    const { data, error } = await db
      .from("app_users")
      .update({ role, updated_at: new Date().toISOString() })
      .eq("id", targetUserId)
      .select("id, email, role, created_at, updated_at")
      .maybeSingle();
    if (error) return void res.status(500).json({ detail: error.message });
    if (!data) return void res.status(404).json({ detail: "User not found" });

    res.json({
      id: data.id,
      email: data.email,
      role: normalizeUserRole(data.role) ?? "user",
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      isCurrentUser: data.id === userId,
    });
  },
);

// GET /user/mcp-connectors
userRouter.get("/mcp-connectors", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  try {
    res.json(await listUserMcpConnectors(userId, db));
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/mcp-connectors] list failed", {
      userId,
      error: detail,
    });
    res.status(500).json({ detail });
  }
});

// GET /user/box-auth-status
userRouter.get("/box-auth-status", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const boxConfigured =
    process.env.BOX_MCP_ENABLED !== "false" &&
    !!(process.env.BOX_MCP_OAUTH_CLIENT_ID || process.env.MCP_OAUTH_CLIENT_ID) &&
    !!(
      process.env.BOX_MCP_OAUTH_CLIENT_SECRET ||
      process.env.MCP_OAUTH_CLIENT_SECRET
    );
  if (!boxConfigured) {
    return void res.json({
      required: false,
      configured: false,
      connected: false,
      connectorId: null,
    });
  }

  try {
    const connectors = await listUserMcpConnectors(userId, db, {
      includeTools: false,
    });
    const boxConnector = connectors.find(
      (connector) => connector.managedBy === "box",
    );
    res.json({
      required: true,
      configured: true,
      connected: !!boxConnector?.oauthConnected,
      connectorId: boxConnector?.id ?? null,
    });
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/box-auth-status] check failed", {
      userId,
      error: detail,
    });
    res.status(500).json({ detail });
  }
});

// GET /user/mcp-connector-presets
userRouter.get("/mcp-connector-presets", requireAuth, async (_req, res) => {
  res.json(listUserMcpConnectorPresets());
});

// POST /user/mcp-connector-presets/:presetId
userRouter.post(
  "/mcp-connector-presets/:presetId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
      if (
        req.params.presetId !== "box" &&
        !(await isAdminUser(db, userId))
      ) {
        return void res.status(403).json({
          detail: "Admin access is required for this MCP connector preset.",
        });
      }
      const connector = await createUserMcpConnectorFromPreset(
        userId,
        req.params.presetId,
        db,
      );
      res.status(201).json(connector);
    } catch (err) {
      const detail = errorMessage(err);
      console.error("[user/mcp-connector-presets] create failed", {
        userId,
        presetId: req.params.presetId,
        error: detail,
      });
      res.status(400).json({ detail });
    }
  },
);

// GET /user/mcp-connectors/:connectorId
userRouter.get(
  "/mcp-connectors/:connectorId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
      res.json(await getUserMcpConnector(userId, req.params.connectorId, db));
    } catch (err) {
      const detail = errorMessage(err);
      console.error("[user/mcp-connectors] get failed", {
        userId,
        connectorId: req.params.connectorId,
        error: detail,
      });
      res.status(404).json({ detail });
    }
  },
);

// POST /user/mcp-connectors
userRouter.post("/mcp-connectors", requireAuth, requireAdmin, async (req, res) => {
  const userId = res.locals.userId as string;
  const name = typeof req.body?.name === "string" ? req.body.name : "";
  const serverUrl =
    typeof req.body?.serverUrl === "string" ? req.body.serverUrl : "";
  const bearerToken =
    typeof req.body?.bearerToken === "string" ? req.body.bearerToken : null;
  const headers =
    req.body?.headers &&
    typeof req.body.headers === "object" &&
    !Array.isArray(req.body.headers)
      ? (req.body.headers as Record<string, unknown>)
      : undefined;
  const db = createServerSupabase();
  try {
    const connector = await createUserMcpConnector(
      userId,
      { name, serverUrl, bearerToken, headers },
      db,
    );
    res.status(201).json(connector);
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/mcp-connectors] create failed", {
      userId,
      error: detail,
    });
    res.status(400).json({ detail });
  }
});

// PATCH /user/mcp-connectors/:connectorId
userRouter.patch(
  "/mcp-connectors/:connectorId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const body = req.body ?? {};
    try {
      const connector = await updateUserMcpConnector(
        userId,
        req.params.connectorId,
        {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.serverUrl === "string"
            ? { serverUrl: body.serverUrl }
            : {}),
          ...(typeof body.enabled === "boolean"
            ? { enabled: body.enabled }
            : {}),
          ...("bearerToken" in body
            ? {
                bearerToken:
                  typeof body.bearerToken === "string"
                    ? body.bearerToken
                    : null,
              }
            : {}),
          ...("headers" in body
            ? {
                headers:
                  body.headers &&
                  typeof body.headers === "object" &&
                  !Array.isArray(body.headers)
                    ? (body.headers as Record<string, unknown>)
                    : undefined,
              }
            : {}),
        },
        db,
      );
      res.json(connector);
    } catch (err) {
      const detail = errorMessage(err);
      console.error("[user/mcp-connectors] update failed", {
        userId,
        connectorId: req.params.connectorId,
        error: detail,
      });
      res.status(400).json({ detail });
    }
  },
);

// DELETE /user/mcp-connectors/:connectorId
userRouter.delete(
  "/mcp-connectors/:connectorId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
      await deleteUserMcpConnector(userId, req.params.connectorId, db);
      res.status(204).send();
    } catch (err) {
      const detail = errorMessage(err);
      console.error("[user/mcp-connectors] delete failed", {
        userId,
        connectorId: req.params.connectorId,
        error: detail,
      });
      res.status(500).json({ detail });
    }
  },
);

// POST /user/mcp-connectors/:connectorId/oauth/start
userRouter.post(
  "/mcp-connectors/:connectorId/oauth/start",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
      const connector = await getUserMcpConnector(
        userId,
        req.params.connectorId,
        db,
      );
      if (
        connector.managedBy !== "box" &&
        !(await isAdminUser(db, userId))
      ) {
        return void res.status(403).json({
          detail: "Admin access is required for custom MCP connector OAuth.",
        });
      }
      const redirectUri = `${backendPublicUrl(req)}/user/mcp-connectors/oauth/callback`;
      const result = await startUserMcpConnectorOAuth(
        userId,
        req.params.connectorId,
        redirectUri,
        db,
      );
      res.json(result);
    } catch (err) {
      const detail = errorMessage(err);
      console.error("[user/mcp-connectors] oauth start failed", {
        userId,
        connectorId: req.params.connectorId,
        error: detail,
      });
      res.status(400).json({ detail });
    }
  },
);

// GET /user/mcp-connectors/oauth/callback
userRouter.get("/mcp-connectors/oauth/callback", async (req, res) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const error =
    typeof req.query.error === "string" ? req.query.error : undefined;
  const db = createServerSupabase();
  try {
    if (error) throw new Error(error);
    if (!state || !code) {
      throw new Error("OAuth callback is missing state or code.");
    }
    const result = await completeUserMcpConnectorOAuth(state, code, db);
    res
      .set("Content-Security-Policy", mcpOAuthPopupCsp(nonce))
      .type("html")
      .send(
        mcpOAuthPopupHtml(
          { success: true, connectorId: result.connectorId },
          nonce,
        ),
      );
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/mcp-connectors] oauth callback failed", {
      error: detail,
      stateHash: shortHash(state),
      hasCode: !!code,
      hasError: !!error,
    });
    res
      .status(400)
      .set("Content-Security-Policy", mcpOAuthPopupCsp(nonce))
      .type("html")
      .send(mcpOAuthPopupHtml({ success: false, detail }, nonce));
  }
});

// POST /user/mcp-connectors/:connectorId/refresh-tools
userRouter.post(
  "/mcp-connectors/:connectorId/refresh-tools",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
      const current = await getUserMcpConnector(
        userId,
        req.params.connectorId,
        db,
      );
      if (current.managedBy === null && !(await isAdminUser(db, userId))) {
        return void res.status(403).json({
          detail: "Admin access is required to refresh a custom MCP connector.",
        });
      }
      const connector = await refreshUserMcpConnectorTools(
        userId,
        req.params.connectorId,
        db,
      );
      res.json(connector);
    } catch (err) {
      const detail = errorMessage(err);
      console.error("[user/mcp-connectors] refresh failed", {
        userId,
        connectorId: req.params.connectorId,
        error: detail,
      });
      if (err instanceof McpOAuthRequiredError) {
        return void res.status(401).json({
          code: err.code,
          detail,
        });
      }
      res.status(400).json({ detail });
    }
  },
);

// PATCH /user/mcp-connectors/:connectorId/tools/:toolId
userRouter.patch(
  "/mcp-connectors/:connectorId/tools/:toolId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const parsed = readBooleanBodyField(req.body, "enabled");
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

    const db = createServerSupabase();
    try {
      const current = await getUserMcpConnector(
        userId,
        req.params.connectorId,
        db,
      );
      if (current.managedBy === null && !(await isAdminUser(db, userId))) {
        return void res.status(403).json({
          detail: "Admin access is required to change a custom MCP connector.",
        });
      }
      const connector = await setUserMcpToolEnabled(
        userId,
        req.params.connectorId,
        req.params.toolId,
        parsed.value,
        db,
      );
      res.json(connector);
    } catch (err) {
      const detail = errorMessage(err);
      console.error("[user/mcp-connectors] tool toggle failed", {
        userId,
        connectorId: req.params.connectorId,
        toolId: req.params.toolId,
        error: detail,
      });
      res.status(400).json({ detail });
    }
  },
);

// GET /user/mcp-approvals/:approvalId
userRouter.get(
  "/mcp-approvals/:approvalId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    if (!UUID_RE.test(req.params.approvalId)) {
      return void res.status(400).json({ detail: "Invalid approval ID" });
    }
    try {
      const approval = await getMcpApprovalForUser(
        req.params.approvalId,
        userId,
      );
      if (!approval) {
        return void res.status(404).json({ detail: "Approval request not found" });
      }
      await persistApprovalTerminalOutcome(approval);
      res.json(serializeMcpApproval(approval));
    } catch (err) {
      const detail = errorMessage(err);
      console.error("[user/mcp-approvals] get failed", {
        userId,
        approvalId: req.params.approvalId,
        error: detail,
      });
      res.status(500).json({ detail });
    }
  },
);

// POST /user/mcp-approvals/:approvalId/decision
userRouter.post(
  "/mcp-approvals/:approvalId/decision",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const approvalId = req.params.approvalId;
    const decision = req.body?.decision;
    if (!UUID_RE.test(approvalId)) {
      return void res.status(400).json({ detail: "Invalid approval ID" });
    }
    if (decision !== "approve" && decision !== "reject") {
      return void res.status(400).json({
        detail: "decision must be approve or reject",
      });
    }

    try {
      if (decision === "reject") {
        const approval = await rejectMcpApproval({ approvalId, userId });
        await persistApprovalTerminalOutcome(approval);
        return void res.json({
          approval: serializeMcpApproval(approval),
        });
      }
      const result = await executeMcpToolApproval({
        approvalId,
        userId,
      });
      res.json(result);
    } catch (err) {
      const detail = errorMessage(err);
      const status = err instanceof McpApprovalError ? err.statusCode : 500;
      console.error("[user/mcp-approvals] decision failed", {
        userId,
        approvalId,
        decision,
        error: detail,
      });
      try {
        const terminalApproval = await getMcpApprovalForUser(approvalId, userId);
        if (terminalApproval) {
          await persistApprovalTerminalOutcome(terminalApproval);
        }
      } catch (persistError) {
        console.error(
          "[user/mcp-approvals] terminal recovery failed",
          {
            userId,
            approvalId,
            error: errorMessage(persistError),
          },
        );
      }
      res.status(status).json({ detail });
    }
  },
);

// GET /user/data-export?scope=account|chats|tabular-reviews
// This is intentionally a Docket-data export, not an Entra account export.
userRouter.get("/data-export", requireAuth, requireAdmin, async (req, res) => {
  const parsedScope = parseDataExportScope(req.query.scope ?? "account");
  if (!parsedScope) {
    return void res.status(400).json({
      detail: "scope must be account, chats, or tabular-reviews",
    });
  }
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  try {
    const payload = await buildDocketDataExport(parsedScope, userId, userEmail);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${dataExportFilename(parsedScope, userId)}"`,
    );
    res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error("[user/data-export] failed", safeErrorLog(error));
    res.status(500).json({ detail: "Unable to prepare Docket data export" });
  }
});

// GET /user/data-deletion-requests
userRouter.get("/data-deletion-requests", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const requests = await listOwnDataDeletionRequests(res.locals.userId as string);
    res.json(requests);
  } catch (error) {
    console.error("[user/data-deletion-requests] list failed", safeErrorLog(error));
    res.status(500).json({ detail: "Unable to load Docket data deletion requests" });
  }
});

// POST /user/data-deletion-requests
userRouter.post("/data-deletion-requests", requireAuth, requireAdmin, async (req, res) => {
  const parsed = validateDeletionRequestBody(req.body);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });
  try {
    const request = await createDataDeletionRequest({
      userId: res.locals.userId as string,
      userEmail: res.locals.userEmail as string | undefined,
      reason: parsed.reason,
    });
    res.status(request.alreadyPending ? 200 : 201).json({
      ...request,
      note:
        "This requests deletion of Docket application data after legal-retention review. It does not delete your Microsoft Entra account.",
    });
  } catch (error) {
    console.error("[user/data-deletion-requests] create failed", safeErrorLog(error));
    res.status(500).json({ detail: "Unable to create Docket data deletion request" });
  }
});

// DELETE /user/data-deletion-requests/:requestId
userRouter.delete(
  "/data-deletion-requests/:requestId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const db = createServerSupabase();
    const { data, error } = await db
      .from("data_deletion_requests")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", req.params.requestId)
      .eq("user_id", res.locals.userId as string)
      .eq("status", "pending_legal_review")
      .select("id, status")
      .maybeSingle();
    if (error) {
      console.error("[user/data-deletion-requests] cancel failed", safeErrorLog(error));
      return void res.status(500).json({ detail: "Unable to cancel Docket data deletion request" });
    }
    if (!data) return void res.status(404).json({ detail: "Pending deletion request not found" });
    res.json(data);
  },
);

// GET /user/admin/data-deletion-requests
userRouter.get(
  "/admin/data-deletion-requests",
  requireAuth,
  async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    if (!(await isAdminUser(db, userId))) {
      return void res.status(403).json({ detail: "Admin access is required" });
    }
    const { data, error } = await db
      .from("data_deletion_requests")
      .select("*")
      .order("requested_at", { ascending: false });
    if (error) {
      console.error("[user/admin/data-deletion-requests] list failed", safeErrorLog(error));
      return void res.status(500).json({ detail: "Unable to load Docket data deletion requests" });
    }
    res.json(data ?? []);
  },
);

// PATCH /user/admin/data-deletion-requests/:requestId
userRouter.patch(
  "/admin/data-deletion-requests/:requestId",
  requireAuth,
  async (req, res) => {
    const db = createServerSupabase();
    const reviewerUserId = res.locals.userId as string;
    if (!(await isAdminUser(db, reviewerUserId))) {
      return void res.status(403).json({ detail: "Admin access is required" });
    }
    const parsed = validateDeletionReviewBody(req.body);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });
    try {
      res.json(
        await reviewDataDeletionRequest({
          requestId: req.params.requestId,
          reviewerUserId,
          ...parsed,
        }),
      );
    } catch (error) {
      const detail = safeErrorMessage(error, "Unable to review Docket data deletion request");
      const status = /not found|already been reviewed/i.test(detail) ? 409 : 500;
      console.error("[user/admin/data-deletion-requests] review failed", safeErrorLog(error));
      res.status(status).json({ detail: status === 409 ? detail : "Unable to review Docket data deletion request" });
    }
  },
);

// POST /user/admin/data-deletion-requests/:requestId/execute
// A separate action prevents review approval from becoming accidental erasure.
userRouter.post(
  "/admin/data-deletion-requests/:requestId/execute",
  requireAuth,
  async (req, res) => {
    const db = createServerSupabase();
    const executorUserId = res.locals.userId as string;
    if (!(await isAdminUser(db, executorUserId))) {
      return void res.status(403).json({ detail: "Admin access is required" });
    }
    try {
      await executeApprovedDataDeletion({
        requestId: req.params.requestId,
        executorUserId,
      });
      res.status(204).send();
    } catch (error) {
      const detail = safeErrorMessage(error, "Unable to execute Docket data deletion request");
      const status = /legal hold|retention date|not approved/i.test(detail) ? 409 : 500;
      console.error("[user/admin/data-deletion-requests] execute failed", safeErrorLog(error));
      res.status(status).json({ detail: status === 409 ? detail : "Unable to execute Docket data deletion request" });
    }
  },
);

// DELETE /user/account is retained only as a safe migration guard for older
// clients. It must never directly delete app_users or an Entra identity.
userRouter.delete("/account", requireAuth, async (_req, res) => {
  res.status(410).json({
    code: "docket_data_request_required",
    detail:
      "Direct account deletion is unavailable. Request Docket data deletion through the reviewed data-lifecycle flow; Microsoft Entra identities are managed separately.",
  });
});
