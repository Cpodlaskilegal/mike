/**
 * Docket API client — all requests to the Node.js backend.
 * Attaches the Entra ID access token for user authentication.
 */

import { supabase } from "@/lib/supabase";
import type {
  AssistantEvent,
  DocketAskInputsResponse,
  DocketChat,
  DocketChatDetailOut,
  DocketCitation,
  DocketCitationAnnotation,
  DocketDocument,
  DocketFolder,
  DocketMessage,
  DocketProject,
  DocketWorkflow,
  DocketWorkflowContributionSubmission,
  TabularReview,
  TabularReviewDetailOut,
} from "@/app/components/shared/types";

// Server-side shape before mapping
interface ServerMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | AssistantEvent[] | null;
  files?: { filename: string; document_id?: string }[] | null;
  workflow?: { id: string; title: string } | null;
  annotations?: DocketCitationAnnotation[] | null;
  citations?: DocketCitation[] | null;
  created_at: string;
}
interface ServerChatDetailOut {
  chat: DocketChat;
  messages: ServerMessage[];
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

type DocketRequestInit = RequestInit & {
  authInteractive?: boolean;
};

export class AuthRequiredError extends Error {
  constructor(message = "Please sign in again to continue.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export class DocketApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "DocketApiError";
    this.status = status;
    this.code = code;
  }
}

async function getAuthHeader(
  interactive = false,
  forceRefresh = false,
): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession({ interactive, forceRefresh });
  if (!session?.access_token) throw new AuthRequiredError();
  return { Authorization: `Bearer ${session.access_token}` };
}

async function apiRequest<T>(path: string, init?: DocketRequestInit): Promise<T> {
  const { authInteractive, headers: initHeaders, ...restInit } = init ?? {};
  const method = restInit.method?.toUpperCase() ?? "GET";
  const shouldInteract =
    authInteractive ?? !["GET", "HEAD", "OPTIONS"].includes(method);
  const authHeaders = await getAuthHeader(shouldInteract);
  const buildRequest = (headers: Record<string, string>): RequestInit => ({
    cache: "no-store",
    ...restInit,
    headers: {
      Accept: "application/json",
      ...headers,
      ...(initHeaders as Record<string, string> | undefined),
    },
  });

  let response = await fetch(`${API_BASE}${path}`, buildRequest(authHeaders));

  if (response.status === 401 && shouldInteract) {
    const refreshedAuthHeaders = await getAuthHeader(true, true);
    response = await fetch(
      `${API_BASE}${path}`,
      buildRequest(refreshedAuthHeaders),
    );
  }

  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(body) as {
        detail?: unknown;
        code?: unknown;
      };
      if (typeof parsed.detail === "string") detail = parsed.detail;
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      const htmlMessage = body.match(/<pre>([\s\S]*?)<\/pre>/i)?.[1];
      if (htmlMessage) {
        detail = htmlMessage
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
          .trim();
      } else if (body.trim().startsWith("<!DOCTYPE html")) {
        detail = response.statusText || `API error: ${response.status}`;
      }
    }
    if (
      code === "oauth_required" &&
      typeof window !== "undefined" &&
      !path.includes("/oauth/")
    ) {
      window.dispatchEvent(new Event("docket:box-auth-required"));
    }
    throw new DocketApiError(
      detail || `API error: ${response.status}`,
      response.status,
      code,
    );
  }

  if (
    response.status === 204 ||
    response.headers.get("content-length") === "0"
  ) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<DocketProject[]> {
  return apiRequest<DocketProject[]>("/projects");
}

export async function createProject(
  name: string,
  cm_number?: string,
  shared_with?: string[],
): Promise<DocketProject> {
  return apiRequest<DocketProject>("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, cm_number, shared_with }),
  });
}

export type DataExportScope = "account" | "chats" | "tabular-reviews";

export interface DocketDataDeletionRequest {
  id: string;
  status:
    | "pending_legal_review"
    | "approved"
    | "rejected"
    | "completed"
    | "cancelled";
  reason?: string | null;
  legal_hold?: boolean;
  retention_until?: string | null;
  requested_at?: string;
  reviewed_at?: string | null;
  completed_at?: string | null;
  decision_note?: string | null;
  workflow_submission_disposition?: "retain" | "anonymize" | "delete";
}

function filenameFromDisposition(value: string | null, fallback: string) {
  const filename = value?.match(/filename="?([^";]+)"?/i)?.[1];
  return filename ? decodeURIComponent(filename) : fallback;
}

export async function downloadUserDataExport(scope: DataExportScope): Promise<{
  blob: Blob;
  filename: string;
}> {
  const authHeaders = await getAuthHeader(true);
  const response = await fetch(
    `${API_BASE}/user/data-export?scope=${encodeURIComponent(scope)}`,
    {
      cache: "no-store",
      headers: { Accept: "application/json", ...authHeaders },
    },
  );
  if (!response.ok) {
    const body = await response.text();
    let detail = body || `API error: ${response.status}`;
    try {
      const parsed = JSON.parse(body) as { detail?: unknown; code?: unknown };
      if (typeof parsed.detail === "string") detail = parsed.detail;
      throw new DocketApiError(
        detail,
        response.status,
        typeof parsed.code === "string" ? parsed.code : undefined,
      );
    } catch (error) {
      if (error instanceof DocketApiError) throw error;
      throw new DocketApiError(detail, response.status);
    }
  }
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(
      response.headers.get("content-disposition"),
      `docket-${scope}-export.json`,
    ),
  };
}

export async function listDataDeletionRequests(): Promise<
  DocketDataDeletionRequest[]
> {
  return apiRequest<DocketDataDeletionRequest[]>("/user/data-deletion-requests");
}

export async function requestDocketDataDeletion(input: {
  confirmation: string;
  reason?: string;
}): Promise<DocketDataDeletionRequest & { note?: string }> {
  return apiRequest("/user/data-deletion-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function cancelDataDeletionRequest(
  requestId: string,
): Promise<DocketDataDeletionRequest> {
  return apiRequest(`/user/data-deletion-requests/${requestId}`, {
    method: "DELETE",
  });
}

export interface UserProfile {
  displayName: string | null;
  organisation: string | null;
  messageCreditsUsed: number;
  creditsResetDate: string;
  creditsRemaining: number;
  tier: string;
  tabularModel: string;
  legalResearchUs: boolean;
  role: "user" | "admin";
  apiKeyStatus: ApiKeyStatus;
}

export async function getUserProfile(): Promise<UserProfile> {
  return apiRequest<UserProfile>("/user/profile");
}

export async function updateUserProfile(payload: {
  displayName?: string | null;
  organisation?: string | null;
  tabularModel?: string;
  legalResearchUs?: boolean;
}): Promise<UserProfile> {
  return apiRequest<UserProfile>("/user/profile", {
    method: "PATCH",
    authInteractive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export interface AdminUser {
  id: string;
  email: string;
  role: "user" | "admin";
  displayName: string | null;
  organisation: string | null;
  createdAt: string;
  updatedAt: string;
  isCurrentUser: boolean;
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  return apiRequest<AdminUser[]>("/user/admin/users");
}

export async function updateAdminUserRole(
  userId: string,
  role: "user" | "admin",
): Promise<AdminUser> {
  return apiRequest<AdminUser>(`/user/admin/users/${userId}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

export interface AdminSpendReport {
  id: string;
  milestoneNumber: number;
  thresholdUsd: number;
  totalUsd: number;
  gptUsd: number;
  claudeUsd: number;
  deliveryStatus?: string;
  createdAt: string;
}

export interface AdminSpendDashboard {
  totalUsd: number;
  gptUsd: number;
  claudeUsd: number;
  nextThresholdUsd: number;
  reports: AdminSpendReport[];
}

export async function getAdminSpendDashboard(): Promise<AdminSpendDashboard> {
  return apiRequest<AdminSpendDashboard>("/user/admin/spend-reports");
}

export interface AdminSpendReportDeliveryResult {
  status: "pending" | "sent" | "not_configured" | "failed";
  error: string | null;
  deliveries: Array<{
    recipientEmail: string;
    status: "pending" | "sent" | "not_configured" | "failed";
    deliveryError: string | null;
  }>;
}

export async function retryAdminSpendReportDelivery(
  reportId: string,
): Promise<AdminSpendReportDeliveryResult> {
  return apiRequest<AdminSpendReportDeliveryResult>(
    `/user/admin/spend-reports/${encodeURIComponent(reportId)}/deliver`,
    { method: "POST" },
  );
}

export type ApiKeyProvider = "claude" | "courtlistener" | "gemini" | "openai";
export type ApiKeySource = "user" | "env" | null;
export type ApiKeyState = Record<
  ApiKeyProvider,
  {
    configured: boolean;
    source: ApiKeySource;
  }
>;

export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
  sources?: Partial<Record<ApiKeyProvider, ApiKeySource>>;
};

export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
  return apiRequest<ApiKeyStatus>("/user/api-keys");
}

export async function saveApiKey(
  provider: ApiKeyProvider,
  apiKey: string | null,
): Promise<ApiKeyStatus> {
  return apiRequest<ApiKeyStatus>(`/user/api-keys/${provider}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
}

export interface BoxAuthStatus {
  required: boolean;
  configured: boolean;
  connected: boolean;
  connectorId: string | null;
}

export async function getBoxAuthStatus(): Promise<BoxAuthStatus> {
  return apiRequest<BoxAuthStatus>("/user/box-auth-status");
}

export interface McpToolSummary {
  id: string;
  toolName: string;
  openaiToolName: string;
  title: string | null;
  description: string | null;
  enabled: boolean;
  readOnly: boolean;
  destructive: boolean;
  requiresConfirmation: boolean;
  lastSeenAt: string;
}

export interface McpConnectorSummary {
  id: string;
  name: string;
  transport: "streamable_http";
  serverUrl: string;
  authType: "none" | "bearer" | "oauth";
  managedBy: "practicepanther" | "box" | null;
  enabled: boolean;
  hasAuthConfig: boolean;
  customHeaderKeys: string[];
  oauthConnected: boolean;
  toolPolicy: Record<string, unknown>;
  tools: McpToolSummary[];
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface McpConnectorPresetSummary {
  id: string;
  name: string;
  description: string;
  serverUrl: string;
  authType: "oauth";
  docsUrl: string;
  requiredEnv: string[];
  optionalEnv: string[];
  configured: boolean;
  missingEnv: string[];
}

export async function listMcpConnectors(): Promise<McpConnectorSummary[]> {
  return apiRequest<McpConnectorSummary[]>("/user/mcp-connectors");
}

export async function listMcpConnectorPresets(): Promise<
  McpConnectorPresetSummary[]
> {
  return apiRequest<McpConnectorPresetSummary[]>("/user/mcp-connector-presets");
}

export async function createMcpConnectorFromPreset(
  presetId: string,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/user/mcp-connector-presets/${presetId}`,
    { method: "POST" },
  );
}

export async function getMcpConnector(
  connectorId: string,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(`/user/mcp-connectors/${connectorId}`);
}

export async function createMcpConnector(payload: {
  name: string;
  serverUrl: string;
  bearerToken?: string | null;
  headers?: Record<string, string>;
}): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>("/user/mcp-connectors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateMcpConnector(
  connectorId: string,
  payload: {
    name?: string;
    serverUrl?: string;
    enabled?: boolean;
    bearerToken?: string | null;
    headers?: Record<string, string>;
  },
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/user/mcp-connectors/${connectorId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteMcpConnector(connectorId: string): Promise<void> {
  return apiRequest<void>(`/user/mcp-connectors/${connectorId}`, {
    method: "DELETE",
  });
}

export async function refreshMcpConnectorTools(
  connectorId: string,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/user/mcp-connectors/${connectorId}/refresh-tools`,
    { method: "POST" },
  );
}

export async function startMcpConnectorOAuth(
  connectorId: string,
): Promise<{ authorizationUrl: string | null; alreadyAuthorized: boolean }> {
  return apiRequest<{
    authorizationUrl: string | null;
    alreadyAuthorized: boolean;
  }>(`/user/mcp-connectors/${connectorId}/oauth/start`, { method: "POST" });
}

export async function setMcpToolEnabled(
  connectorId: string,
  toolId: string,
  enabled: boolean,
): Promise<McpConnectorSummary> {
  return apiRequest<McpConnectorSummary>(
    `/user/mcp-connectors/${connectorId}/tools/${toolId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
}

export async function getProject(projectId: string): Promise<DocketProject> {
  return apiRequest<DocketProject>(`/projects/${projectId}`);
}

export async function updateProject(
  projectId: string,
  payload: {
    name?: string;
    cm_number?: string;
    shared_with?: string[];
  },
): Promise<DocketProject> {
  return apiRequest<DocketProject>(`/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

export interface ProjectPeople {
  owner: {
    user_id: string;
    email: string | null;
    display_name: string | null;
  };
  members: { email: string; display_name: string | null }[];
}

export async function getProjectPeople(
  projectId: string,
): Promise<ProjectPeople> {
  return apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
  projectId: string,
  name: string,
  parentFolderId?: string | null,
): Promise<DocketFolder> {
  return apiRequest<DocketFolder>(`/projects/${projectId}/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      parent_folder_id: parentFolderId ?? null,
    }),
  });
}

export async function renameProjectFolder(
  projectId: string,
  folderId: string,
  name: string,
): Promise<DocketFolder> {
  return apiRequest<DocketFolder>(`/projects/${projectId}/folders/${folderId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function deleteProjectFolder(
  projectId: string,
  folderId: string,
): Promise<void> {
  await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
    method: "DELETE",
  });
}

export async function moveSubfolderToFolder(
  projectId: string,
  folderId: string,
  parentFolderId: string | null,
): Promise<DocketFolder> {
  return apiRequest<DocketFolder>(`/projects/${projectId}/folders/${folderId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent_folder_id: parentFolderId }),
  });
}

export async function moveDocumentToFolder(
  projectId: string,
  documentId: string,
  folderId: string | null,
): Promise<DocketDocument> {
  return apiRequest<DocketDocument>(
    `/projects/${projectId}/documents/${documentId}/folder`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId }),
    },
  );
}

export async function renameProjectDocument(
  projectId: string,
  documentId: string,
  filename: string,
): Promise<DocketDocument> {
  return apiRequest<DocketDocument>(
    `/projects/${projectId}/documents/${documentId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    },
  );
}

export async function addDocumentToProject(
  projectId: string,
  documentId: string,
): Promise<DocketDocument> {
  return apiRequest<DocketDocument>(
    `/projects/${projectId}/documents/${documentId}`,
    { method: "POST" },
  );
}

export interface DocketDocumentVersion {
  id: string;
  version_number: number | null;
  source: string;
  created_at: string;
  display_name: string | null;
  file_type?: string | null;
  size_bytes?: number | null;
  page_count?: number | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
}

export async function listDocumentVersions(documentId: string): Promise<{
  current_version_id: string | null;
  versions: DocketDocumentVersion[];
}> {
  return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
  documentId: string,
  file: File,
  displayName?: string,
): Promise<DocketDocumentVersion> {
  const authHeaders = await getAuthHeader(true);
  const form = new FormData();
  form.append("file", file);
  if (displayName) form.append("display_name", displayName);
  const response = await fetch(
    `${API_BASE}/single-documents/${documentId}/versions`,
    {
      method: "POST",
      headers: { ...authHeaders },
      body: form,
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DocketDocumentVersion>;
}

export async function copyDocumentVersion(
  documentId: string,
  versionId: string,
  displayName?: string,
): Promise<DocketDocumentVersion> {
  return apiRequest<DocketDocumentVersion>(
    `/single-documents/${documentId}/versions/${versionId}/copy`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    },
  );
}

export async function replaceDocumentVersionFile(
  documentId: string,
  versionId: string,
  file: File,
  displayName?: string,
): Promise<DocketDocumentVersion> {
  const authHeaders = await getAuthHeader(true);
  const form = new FormData();
  form.append("file", file);
  if (displayName) form.append("display_name", displayName);
  const response = await fetch(
    `${API_BASE}/single-documents/${documentId}/versions/${versionId}/file`,
    {
      method: "PUT",
      headers: { ...authHeaders },
      body: form,
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DocketDocumentVersion>;
}

export async function deleteDocumentVersion(
  documentId: string,
  versionId: string,
): Promise<{
  deleted_version_id: string;
  current_version_id: string | null;
  deleted_at: string;
}> {
  return apiRequest(`/single-documents/${documentId}/versions/${versionId}`, {
    method: "DELETE",
  });
}

export async function renameDocumentVersion(
  documentId: string,
  versionId: string,
  displayName: string | null,
): Promise<DocketDocumentVersion> {
  return apiRequest<DocketDocumentVersion>(
    `/single-documents/${documentId}/versions/${versionId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    },
  );
}

export async function uploadProjectDocument(
  projectId: string,
  file: File,
): Promise<DocketDocument> {
  const authHeaders = await getAuthHeader(true);
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE}/projects/${projectId}/documents`, {
    method: "POST",
    headers: { ...authHeaders },
    body: form,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DocketDocument>;
}

export async function uploadStandaloneDocument(
  file: File,
): Promise<DocketDocument> {
  const authHeaders = await getAuthHeader(true);
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE}/single-documents`, {
    method: "POST",
    headers: { ...authHeaders },
    body: form,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DocketDocument>;
}

export async function listStandaloneDocuments(): Promise<DocketDocument[]> {
  return apiRequest<DocketDocument[]>("/single-documents");
}

export async function deleteDocument(documentId: string): Promise<void> {
  await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export async function getDocumentUrl(
  documentId: string,
  versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
  const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
  return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

export interface CaseLawOpinion {
  opinionId: number | null;
  type: string | null;
  author: string | null;
  per_curiam: string | null;
  joined_by_str: string | null;
  url: string | null;
  text: string | null;
  /** Server-side allowlisted CourtListener HTML. */
  html: string | null;
}

export async function getCourtlistenerOpinions(
  clusterId: number,
): Promise<CaseLawOpinion[]> {
  const result = await apiRequest<{ opinions?: CaseLawOpinion[] }>(
    "/case-law/case-opinions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cluster_id: clusterId }),
    },
  );
  return Array.isArray(result.opinions) ? result.opinions : [];
}

export async function downloadDocumentsZip(
  documentIds: string[],
): Promise<Blob> {
  const authHeaders = await getAuthHeader(true);
  const response = await fetch(`${API_BASE}/single-documents/download-zip`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ document_ids: documentIds }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `API error: ${response.status}`);
  }
  return response.blob();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
  project_id?: string;
}): Promise<{ id: string }> {
  return apiRequest<{ id: string }>("/chat/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
}

export async function listChats(): Promise<DocketChat[]> {
  return apiRequest<DocketChat[]>("/chat");
}

export async function listProjectChats(projectId: string): Promise<DocketChat[]> {
  return apiRequest<DocketChat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<DocketChatDetailOut> {
  const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
  const messages: DocketMessage[] = raw.messages.map((m) => {
    if (m.role === "user") {
      return {
        role: "user",
        content: typeof m.content === "string" ? m.content : "",
        files: m.files ?? undefined,
        workflow: m.workflow ?? undefined,
      };
    }
    const events = Array.isArray(m.content)
      ? (m.content as AssistantEvent[])
      : undefined;
    const pending = m.content == null;
    return {
      role: "assistant",
      content:
        events
          ?.filter((e) => e.type === "content")
          .map((e) => (e as { type: "content"; text: string }).text)
          .join("") ?? "",
      annotations: m.annotations ?? undefined,
      citations: m.citations ?? undefined,
      events:
        events ??
        (pending ? [{ type: "thinking" as const, isStreaming: true }] : undefined),
      pending,
    };
  });
  return { chat: raw.chat, messages };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
  await apiRequest(`/chat/${chatId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function deleteChat(chatId: string): Promise<void> {
  await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

export async function generateChatTitle(
  chatId: string,
  message: string,
): Promise<{ title: string }> {
  return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

export async function streamChat(payload: {
  messages: {
    role: string;
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
  }[];
  chat_id?: string;
  project_id?: string;
  model?: string;
  ask_inputs_response?: DocketAskInputsResponse;
  signal?: AbortSignal;
}): Promise<Response> {
  const { signal, ...body } = payload;
  const authHeaders = await getAuthHeader(true);
  return fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...authHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });
}

type StreamChatMessage = {
  role: string;
  content: string;
  files?: { filename: string; document_id?: string }[];
  workflow?: { id: string; title: string };
};

export async function streamProjectChat(payload: {
  projectId: string;
  messages: StreamChatMessage[];
  chat_id?: string;
  model?: string;
  displayed_doc?: { filename: string; document_id: string };
  attached_documents?: { filename: string; document_id: string }[];
  ask_inputs_response?: DocketAskInputsResponse;
  signal?: AbortSignal;
}): Promise<Response> {
  const { projectId, signal, ...body } = payload;
  const authHeaders = await getAuthHeader(true);
  return fetch(`${API_BASE}/projects/${projectId}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...authHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
  projectId?: string,
): Promise<TabularReview[]> {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return apiRequest<TabularReview[]>(`/tabular-review${qs}`);
}

export async function createTabularReview(payload: {
  title?: string;
  document_ids: string[];
  columns_config: { index: number; name: string; prompt: string }[];
  workflow_id?: string;
  project_id?: string;
}): Promise<TabularReview> {
  return apiRequest<TabularReview>("/tabular-review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getTabularReview(
  reviewId: string,
): Promise<TabularReviewDetailOut> {
  return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
  reviewId: string,
  payload: {
    title?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    document_ids?: string[];
    project_id?: string | null;
    shared_with?: string[];
  },
): Promise<TabularReview> {
  return apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getTabularReviewPeople(
  reviewId: string,
): Promise<ProjectPeople> {
  return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function generateTabularColumnPrompt(
  title: string,
  options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
  return apiRequest<{
    prompt: string;
    source: "preset" | "llm" | "fallback";
  }>("/tabular-review/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      format: options?.format,
      documentName: options?.documentName,
      tags: options?.tags,
    }),
  });
}

export async function uploadReviewDocument(
  reviewId: string,
  file: File,
  options?: {
    projectId?: string;
    documentIds?: string[];
    columnsConfig?: { index: number; name: string; prompt: string }[];
  },
): Promise<DocketDocument> {
  const uploaded = options?.projectId
    ? await uploadProjectDocument(options.projectId, file)
    : await uploadStandaloneDocument(file);

  await updateTabularReview(reviewId, {
    columns_config: options?.columnsConfig,
    document_ids: [...(options?.documentIds ?? []), uploaded.id],
  });

  return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
  await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
  reviewId: string,
): Promise<Response> {
  const authHeaders = await getAuthHeader(true);
  return fetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
    method: "POST",
    headers: { ...authHeaders },
  });
}

export async function streamTabularChat(
  reviewId: string,
  messages: { role: string; content: string }[],
  chat_id?: string | null,
  signal?: AbortSignal,
  context?: { reviewTitle?: string | null; projectName?: string | null },
): Promise<Response> {
  const authHeaders = await getAuthHeader(true);
  return fetch(`${API_BASE}/tabular-review/${reviewId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      messages,
      chat_id: chat_id ?? undefined,
      review_title: context?.reviewTitle ?? undefined,
      project_name: context?.projectName ?? undefined,
    }),
    signal: signal ?? undefined,
  });
}

export interface TRCitationAnnotation {
  type: "tabular_citation";
  ref: number;
  col_index: number;
  row_index: number;
  col_name: string;
  doc_name: string;
  quote: string;
}

interface RawTRMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string | AssistantEvent[] | null;
  annotations?: TRCitationAnnotation[] | null;
  created_at: string;
}

export interface TRDisplayMessage {
  role: "user" | "assistant";
  content: string;
  events?: AssistantEvent[];
  annotations?: TRCitationAnnotation[];
}

export interface TRChat {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
  return raw.map((m) => {
    if (m.role === "user") {
      return {
        role: "user" as const,
        content: typeof m.content === "string" ? m.content : "",
      };
    }
    const events = Array.isArray(m.content)
      ? (m.content as AssistantEvent[])
      : undefined;
    const content =
      events
        ?.filter((e) => e.type === "content")
        .map((e) => (e as { type: "content"; text: string }).text)
        .join("") ?? "";
    return {
      role: "assistant" as const,
      content,
      events,
      annotations: m.annotations ?? undefined,
    };
  });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
  return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
  reviewId: string,
  chatId: string,
): Promise<RawTRMessage[]> {
  return apiRequest<RawTRMessage[]>(
    `/tabular-review/${reviewId}/chats/${chatId}/messages`,
  );
}

export async function deleteTabularChat(
  reviewId: string,
  chatId: string,
): Promise<void> {
  await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
    method: "DELETE",
  });
}

export async function regenerateTabularCell(
  reviewId: string,
  documentId: string,
  columnIndex: number,
): Promise<{
  summary: string;
  flag: "green" | "grey" | "yellow" | "red";
  reasoning: string;
}> {
  return apiRequest(`/tabular-review/${reviewId}/regenerate-cell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_id: documentId,
      column_index: columnIndex,
    }),
  });
}

export async function clearTabularCells(
  reviewId: string,
  documentIds: string[],
): Promise<void> {
  await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document_ids: documentIds }),
  });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = DocketWorkflow["type"];

export async function listWorkflows(
  type: WorkflowType,
): Promise<DocketWorkflow[]> {
  return apiRequest<DocketWorkflow[]>(`/workflows?type=${type}`);
}

export async function getWorkflow(workflowId: string): Promise<DocketWorkflow> {
  return apiRequest<DocketWorkflow>(`/workflows/${workflowId}`);
}

export async function downloadWorkflowZip(workflowId: string): Promise<{
  blob: Blob;
  filename: string;
}> {
  const authHeaders = await getAuthHeader(true);
  const response = await fetch(`${API_BASE}/workflows/${workflowId}/export`, {
    cache: "no-store",
    headers: { Accept: "application/zip", ...authHeaders },
  });
  if (!response.ok) {
    const body = await response.text();
    let detail = body || `API error: ${response.status}`;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(body) as { detail?: unknown; code?: unknown };
      if (typeof parsed.detail === "string") detail = parsed.detail;
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      // The status text is enough when a proxy returned a non-JSON response.
    }
    throw new DocketApiError(detail, response.status, code);
  }
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(
      response.headers.get("content-disposition"),
      "docket-workflow.zip",
    ),
  };
}

export async function createWorkflow(payload: {
  title: string;
  type: "assistant" | "tabular";
  prompt_md?: string;
  columns_config?: { index: number; name: string; prompt: string }[];
  language?: string | null;
  practice?: string | null;
  jurisdictions?: string[] | null;
}): Promise<DocketWorkflow> {
  return apiRequest<DocketWorkflow>("/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateWorkflow(
  workflowId: string,
  payload: {
    title?: string;
    prompt_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    language?: string | null;
    practice?: string | null;
    jurisdictions?: string[] | null;
  },
): Promise<DocketWorkflow> {
  return apiRequest<DocketWorkflow>(`/workflows/${workflowId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function submitWorkflowForOpenSourceReview(
  workflowId: string,
  payload: {
    attribution: "named" | "docket-community";
    public_name?: string;
    confirmation: "SUBMIT DOCKET WORKFLOW";
  },
): Promise<DocketWorkflowContributionSubmission & { mode: "created" | "updated" }> {
  return apiRequest(`/workflows/${workflowId}/open-source-submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function withdrawWorkflowOpenSourceSubmission(
  workflowId: string,
  submissionId: string,
): Promise<DocketWorkflowContributionSubmission> {
  return apiRequest(
    `/workflows/${workflowId}/open-source-submissions/${submissionId}`,
    { method: "DELETE" },
  );
}

export async function listHiddenWorkflows(): Promise<string[]> {
  return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
  await apiRequest("/workflows/hidden", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_id: workflowId }),
  });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
  await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
  workflowId: string,
  payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
  await apiRequest<void>(`/workflows/${workflowId}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function listWorkflowShares(workflowId: string): Promise<
  {
    id: string;
    shared_with_email: string;
    allow_edit: boolean;
    created_at: string;
  }[]
> {
  return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
  workflowId: string,
  shareId: string,
): Promise<void> {
  await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
    method: "DELETE",
  });
}
