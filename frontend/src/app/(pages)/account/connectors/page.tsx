"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Box as BoxIcon,
  Check,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DocketApiError,
  type McpConnectorPresetSummary,
  type McpConnectorSummary,
  createMcpConnector,
  createMcpConnectorFromPreset,
  deleteMcpConnector,
  listMcpConnectorPresets,
  listMcpConnectors,
  refreshMcpConnectorTools,
  setMcpToolEnabled,
  startMcpConnectorOAuth,
  updateMcpConnector,
} from "@/app/lib/docketApi";

type Draft = {
  name: string;
  serverUrl: string;
  bearerToken: string;
  headers: string;
};

const emptyDraft: Draft = {
  name: "",
  serverUrl: "",
  bearerToken: "",
  headers: "",
};

const oauthMessageOrigin = new URL(
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001",
).origin;

function parseHeaders(raw: string): Record<string, string> | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error("Header values must be strings.");
    }
    headers[key] = value;
  }
  return headers;
}

export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<McpConnectorSummary[]>([]);
  const [presets, setPresets] = useState<McpConnectorPresetSummary[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presetWarning, setPresetWarning] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPresetWarning(null);
    try {
      const [connectorsResult, presetsResult] = await Promise.allSettled([
        listMcpConnectors(),
        listMcpConnectorPresets(),
      ]);
      if (connectorsResult.status === "rejected") {
        throw connectorsResult.reason;
      }
      setConnectors(connectorsResult.value);

      if (presetsResult.status === "fulfilled") {
        setPresets(presetsResult.value);
      } else {
        setPresets([]);
        const message =
          presetsResult.reason instanceof Error
            ? presetsResult.reason.message
            : "Failed to load connector presets.";
        setPresetWarning(
          `Connector presets are unavailable from this backend: ${message}`,
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load connectors.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceConnector = (connector: McpConnectorSummary) => {
    setConnectors((prev) => {
      const exists = prev.some((item) => item.id === connector.id);
      if (!exists) return [connector, ...prev];
      return prev.map((item) => (item.id === connector.id ? connector : item));
    });
  };

  const runOAuth = async (connectorId: string) => {
    const popup = window.open(
      "about:blank",
      "docket_mcp_oauth",
      "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
    );
    const { authorizationUrl, alreadyAuthorized } =
      await startMcpConnectorOAuth(connectorId);
    if (alreadyAuthorized) {
      popup?.close();
      replaceConnector(await refreshMcpConnectorTools(connectorId));
      return;
    }
    if (!authorizationUrl) {
      popup?.close();
      throw new Error("OAuth authorization URL was not returned.");
    }
    if (!popup) {
      window.location.assign(authorizationUrl);
      return;
    }
    popup.location.href = authorizationUrl;

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => {
          cleanup();
          reject(new Error("OAuth authorization timed out."));
        },
        5 * 60 * 1000,
      );
      const poll = window.setInterval(() => {
        if (popup.closed) {
          cleanup();
          reject(new Error("OAuth window was closed."));
        }
      }, 700);
      const onMessage = (
        event: MessageEvent<{
          type?: string;
          success?: boolean;
          connectorId?: string;
          detail?: string;
        }>,
      ) => {
        if (event.origin !== oauthMessageOrigin) return;
        if (event.data?.type !== "mcp_oauth_result") return;
        if (event.data.connectorId && event.data.connectorId !== connectorId) {
          return;
        }
        cleanup();
        if (event.data.success) resolve();
        else reject(new Error(event.data.detail || "OAuth failed."));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        window.clearInterval(poll);
        window.removeEventListener("message", onMessage);
      };
      window.addEventListener("message", onMessage);
    });

    replaceConnector(await refreshMcpConnectorTools(connectorId));
  };

  const refreshOrAuthorize = async (connectorId: string) => {
    try {
      replaceConnector(await refreshMcpConnectorTools(connectorId));
    } catch (err) {
      if (err instanceof DocketApiError && err.code === "oauth_required") {
        await runOAuth(connectorId);
        return;
      }
      throw err;
    }
  };

  const handleCreatePreset = async (preset: McpConnectorPresetSummary) => {
    setBusy(`preset:${preset.id}`);
    setError(null);
    setSavedId(null);
    try {
      const connector = await createMcpConnectorFromPreset(preset.id);
      replaceConnector(connector);
      await refreshOrAuthorize(connector.id);
      setSavedId(connector.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : `Failed to add ${preset.name}.`,
      );
    } finally {
      setBusy(null);
    }
  };

  const handleCreate = async () => {
    setBusy("create");
    setError(null);
    setSavedId(null);
    try {
      const connector = await createMcpConnector({
        name: draft.name,
        serverUrl: draft.serverUrl,
        bearerToken: draft.bearerToken.trim() || null,
        headers: parseHeaders(draft.headers),
      });
      replaceConnector(connector);
      await refreshOrAuthorize(connector.id);
      setDraft(emptyDraft);
      setSavedId(connector.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add connector.");
    } finally {
      setBusy(null);
    }
  };

  const handleRefresh = async (connectorId: string) => {
    setBusy(`refresh:${connectorId}`);
    setError(null);
    try {
      await refreshOrAuthorize(connectorId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh tools.");
    } finally {
      setBusy(null);
    }
  };

  const handleConnectorEnabled = async (
    connector: McpConnectorSummary,
    enabled: boolean,
  ) => {
    setBusy(`connector:${connector.id}`);
    setError(null);
    try {
      replaceConnector(await updateMcpConnector(connector.id, { enabled }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update connector.",
      );
    } finally {
      setBusy(null);
    }
  };

  const handleToolEnabled = async (
    connectorId: string,
    toolId: string,
    enabled: boolean,
  ) => {
    setBusy(`tool:${toolId}`);
    setError(null);
    try {
      replaceConnector(await setMcpToolEnabled(connectorId, toolId, enabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update tool.");
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (connectorId: string) => {
    if (!window.confirm("Delete this connector?")) return;
    setBusy(`delete:${connectorId}`);
    setError(null);
    try {
      await deleteMcpConnector(connectorId);
      setConnectors((prev) => prev.filter((item) => item.id !== connectorId));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete connector.",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-2xl font-medium font-serif mb-2">Connectors</h2>
        <p className="text-sm text-gray-500 max-w-xl">
          Add remote HTTPS MCP servers. Docket can expose enabled, non-destructive
          tools to chat after discovery.
        </p>
      </section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {presetWarning && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {presetWarning}
        </div>
      )}

      {presets.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">
            Available connectors
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            {presets.map((preset) => {
              const normalizedUrl = new URL(preset.serverUrl).toString();
              const existing = connectors.find(
                (connector) =>
                  connector.serverUrl === normalizedUrl ||
                  connector.serverUrl === preset.serverUrl,
              );
              const isBusy = busy === `preset:${preset.id}`;
              return (
                <div
                  key={preset.id}
                  className="rounded-md border border-gray-200 bg-white p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="rounded-md border border-gray-200 p-2 text-gray-700">
                      <BoxIcon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-semibold text-gray-900">
                          {preset.name}
                        </h4>
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
                          {preset.authType}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {preset.description}
                      </p>
                      <p className="mt-2 truncate text-xs text-gray-500">
                        {preset.serverUrl}
                      </p>
                      {!preset.configured && (
                        <p className="mt-2 text-xs text-amber-700">
                          Configure {preset.missingEnv.join(", ")} before OAuth.
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      onClick={() => void handleCreatePreset(preset)}
                      disabled={!!existing || isBusy || !preset.configured}
                      className="bg-black text-white hover:bg-gray-900"
                    >
                      {isBusy ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Adding
                        </>
                      ) : existing ? (
                        <>
                          <Check className="h-4 w-4 mr-2" />
                          Added
                        </>
                      ) : (
                        <>
                          <BoxIcon className="h-4 w-4 mr-2" />
                          Add Box
                        </>
                      )}
                    </Button>
                    <a
                      href={preset.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-gray-500 hover:text-gray-900"
                    >
                      Setup docs
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="space-y-3 rounded-md border border-gray-200 bg-white p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="text-sm text-gray-600 block mb-2">Name</label>
            <Input
              value={draft.name}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  name: event.target.value,
                }))
              }
              placeholder="Custom MCP"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600 block mb-2">
              Server URL
            </label>
            <Input
              value={draft.serverUrl}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  serverUrl: event.target.value,
                }))
              }
              placeholder="https://example.com/mcp"
            />
          </div>
        </div>
        <div>
          <label className="text-sm text-gray-600 block mb-2">
            Bearer token
          </label>
          <div className="relative">
            <Input
              type={showToken ? "text" : "password"}
              value={draft.bearerToken}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  bearerToken: event.target.value,
                }))
              }
              placeholder="Optional"
              className="pr-10"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowToken((value) => !value)}
              className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600"
              aria-label={showToken ? "Hide token" : "Show token"}
            >
              {showToken ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((value) => !value)}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            {showAdvanced ? "Hide" : "Show"} custom headers
          </button>
          {showAdvanced && (
            <textarea
              value={draft.headers}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  headers: event.target.value,
                }))
              }
              placeholder='{"X-API-Key":"..."}'
              className="mt-2 min-h-24 w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-black/10"
            />
          )}
        </div>
        <Button
          onClick={handleCreate}
          disabled={
            busy === "create" || !draft.name.trim() || !draft.serverUrl.trim()
          }
          className="bg-black text-white hover:bg-gray-900"
        >
          {busy === "create" ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Adding
            </>
          ) : savedId ? (
            <>
              <Check className="h-4 w-4 mr-2" />
              Added
            </>
          ) : (
            "Add connector"
          )}
        </Button>
      </section>

      <section className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading connectors
          </div>
        ) : connectors.length === 0 ? (
          <p className="text-sm text-gray-500">No connectors yet.</p>
        ) : (
          connectors.map((connector) => (
            <ConnectorPanel
              key={connector.id}
              connector={connector}
              busy={busy}
              onRefresh={handleRefresh}
              onDelete={handleDelete}
              onConnectorEnabled={handleConnectorEnabled}
              onToolEnabled={handleToolEnabled}
            />
          ))
        )}
      </section>
    </div>
  );
}

function ConnectorPanel({
  connector,
  busy,
  onRefresh,
  onDelete,
  onConnectorEnabled,
  onToolEnabled,
}: {
  connector: McpConnectorSummary;
  busy: string | null;
  onRefresh: (connectorId: string) => Promise<void>;
  onDelete: (connectorId: string) => Promise<void>;
  onConnectorEnabled: (
    connector: McpConnectorSummary,
    enabled: boolean,
  ) => Promise<void>;
  onToolEnabled: (
    connectorId: string,
    toolId: string,
    enabled: boolean,
  ) => Promise<void>;
}) {
  const isBackendManaged = connector.managedBy !== null;

  return (
    <div className="rounded-md border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-gray-900">
              {connector.name}
            </h3>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">
              {connector.authType}
            </span>
            {connector.oauthConnected && (
              <span className="rounded bg-green-50 px-1.5 py-0.5 text-[11px] text-green-700">
                OAuth connected
              </span>
            )}
            {isBackendManaged && (
              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">
                Backend managed
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-gray-500">
            {connector.serverUrl}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={connector.enabled}
              disabled={
                isBackendManaged || busy === `connector:${connector.id}`
              }
              onChange={(event) =>
                void onConnectorEnabled(connector, event.target.checked)
              }
            />
            Enabled
          </label>
          <button
            type="button"
            onClick={() => void onRefresh(connector.id)}
            disabled={busy === `refresh:${connector.id}`}
            className="rounded-md border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-50"
            title="Refresh tools"
          >
            <RefreshCw
              className={`h-4 w-4 ${
                busy === `refresh:${connector.id}` ? "animate-spin" : ""
              }`}
            />
          </button>
          {!isBackendManaged && (
            <button
              type="button"
              onClick={() => void onDelete(connector.id)}
              disabled={busy === `delete:${connector.id}`}
              className="rounded-md border border-red-200 p-2 text-red-500 hover:bg-red-50 disabled:cursor-wait disabled:opacity-50"
              title="Delete connector"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {connector.tools.length === 0 ? (
          <p className="text-xs text-gray-500">No tools discovered yet.</p>
        ) : (
          connector.tools.map((tool) => (
            <div
              key={tool.id}
              className="flex items-start justify-between gap-3 rounded-md border border-gray-100 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-800">
                  {tool.title || tool.toolName}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {tool.toolName}
                </p>
                {tool.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-gray-500">
                    {tool.description}
                  </p>
                )}
                {tool.requiresConfirmation && (
                  <p className="mt-1 text-xs text-amber-700">
                    Requires confirmation; disabled for chat.
                  </p>
                )}
              </div>
              <label className="flex shrink-0 items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={tool.enabled}
                  disabled={
                    tool.requiresConfirmation || busy === `tool:${tool.id}`
                  }
                  onChange={(event) =>
                    void onToolEnabled(
                      connector.id,
                      tool.id,
                      event.target.checked,
                    )
                  }
                />
                Chat
              </label>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
