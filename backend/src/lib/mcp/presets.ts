import { createServerSupabase } from "../supabase";
import {
  authConfigPatch,
  toConnectorSummary,
  validateRemoteMcpUrl,
} from "./client";
import {
  backendManagedBy,
  boxMcpServerUrl,
  managedConnectorDisplayName,
} from "./defaults";
import type { ConnectorRow, Db, McpConnectorSummary } from "./types";

export type McpConnectorPresetSummary = {
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
};

type McpConnectorPreset = Omit<
  McpConnectorPresetSummary,
  "configured" | "missingEnv"
> & {
  envGroups: string[][];
};

const BOX_MCP_PRESET: McpConnectorPreset = {
  id: "box",
  name: "Box MCP",
  description: "Connect Docket to Box content through Box's hosted MCP server.",
  serverUrl: "https://mcp.box.com",
  authType: "oauth",
  docsUrl: "https://developer.box.com/guides/box-mcp",
  requiredEnv: ["BOX_MCP_OAUTH_CLIENT_ID", "BOX_MCP_OAUTH_CLIENT_SECRET"],
  optionalEnv: ["BOX_MCP_OAUTH_SCOPE"],
  envGroups: [
    ["BOX_MCP_OAUTH_CLIENT_ID", "MCP_OAUTH_CLIENT_ID"],
    ["BOX_MCP_OAUTH_CLIENT_SECRET", "MCP_OAUTH_CLIENT_SECRET"],
  ],
};

const MCP_CONNECTOR_PRESETS = [BOX_MCP_PRESET] as const;

function summarizePreset(
  preset: McpConnectorPreset,
): McpConnectorPresetSummary {
  const missingEnv = preset.envGroups
    .filter((group) => !group.some((name) => !!process.env[name]))
    .map((group) => group[0]);
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    serverUrl: preset.serverUrl,
    authType: preset.authType,
    docsUrl: preset.docsUrl,
    requiredEnv: preset.requiredEnv,
    optionalEnv: preset.optionalEnv,
    configured: missingEnv.length === 0,
    missingEnv,
  };
}

function findPreset(presetId: string) {
  return MCP_CONNECTOR_PRESETS.find((preset) => preset.id === presetId);
}

export function listUserMcpConnectorPresets(): McpConnectorPresetSummary[] {
  const managedBoxUrl = boxMcpServerUrl();
  return MCP_CONNECTOR_PRESETS.filter((preset) => {
    if (!managedBoxUrl) return true;
    return new URL(preset.serverUrl).toString() !== managedBoxUrl;
  }).map(summarizePreset);
}

export async function createUserMcpConnectorFromPreset(
  userId: string,
  presetId: string,
  db: Db = createServerSupabase(),
): Promise<McpConnectorSummary> {
  const preset = findPreset(presetId);
  if (!preset) throw new Error("Unknown MCP connector preset.");

  const serverUrl = await validateRemoteMcpUrl(preset.serverUrl);
  const managedBy = backendManagedBy({ server_url: serverUrl, tool_policy: null });
  if (managedBy) {
    throw new Error(
      `${managedConnectorDisplayName(managedBy)} is managed by the backend and is already connected.`,
    );
  }

  const { data: existing, error: existingError } = await db
    .from("user_mcp_connectors")
    .select("*")
    .eq("user_id", userId)
    .eq("server_url", serverUrl)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return toConnectorSummary(existing as ConnectorRow);

  const { data, error } = await db
    .from("user_mcp_connectors")
    .insert({
      user_id: userId,
      name: preset.name,
      transport: "streamable_http",
      server_url: serverUrl,
      auth_type: "none",
      enabled: true,
      tool_policy: {},
      ...authConfigPatch({}),
    })
    .select("*")
    .single();
  if (error) throw error;
  return toConnectorSummary(data as ConnectorRow);
}
