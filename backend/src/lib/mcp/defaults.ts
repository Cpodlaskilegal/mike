import { openaiToolName } from "./client";
import type { ConnectorRow, Db, ToolCacheRow } from "./types";

export type BackendManagedConnectorKey = "practicepanther" | "box";

const DEFAULT_PRACTICEPANTHER_MCP_SERVER_URL =
    "https://wild-spark-qn7iy.run.mcp-use.com/mcp";
const DEFAULT_BOX_MCP_SERVER_URL = "https://mcp.box.com";

type ManagedConnectorSpec = {
    key: BackendManagedConnectorKey;
    name: string;
    defaultServerUrl: string;
    serverUrlEnv: string;
    enabledEnv: string;
    authType: ConnectorRow["auth_type"];
};

const MANAGED_CONNECTORS: ManagedConnectorSpec[] = [
    {
        key: "practicepanther",
        name: "PracticePanther MCP",
        defaultServerUrl: DEFAULT_PRACTICEPANTHER_MCP_SERVER_URL,
        serverUrlEnv: "PRACTICEPANTHER_MCP_SERVER_URL",
        enabledEnv: "PRACTICEPANTHER_MCP_ENABLED",
        authType: "none",
    },
    {
        key: "box",
        name: "Box MCP",
        defaultServerUrl: DEFAULT_BOX_MCP_SERVER_URL,
        serverUrlEnv: "BOX_MCP_SERVER_URL",
        enabledEnv: "BOX_MCP_ENABLED",
        authType: "oauth",
    },
];

function normalizeUrl(rawUrl: string): string | null {
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== "https:") return null;
        url.username = "";
        url.password = "";
        url.hash = "";
        return url.toString();
    } catch {
        return null;
    }
}

export function practicePantherMcpServerUrl(): string | null {
    return managedMcpServerUrl("practicepanther");
}

export function boxMcpServerUrl(): string | null {
    return managedMcpServerUrl("box");
}

function managedConnectorSpec(key: BackendManagedConnectorKey) {
    return MANAGED_CONNECTORS.find((spec) => spec.key === key) ?? null;
}

function enabledManagedConnectorSpecs() {
    return MANAGED_CONNECTORS.filter(
        (spec) => process.env[spec.enabledEnv] !== "false",
    );
}

export function managedMcpServerUrl(key: BackendManagedConnectorKey): string | null {
    const spec = managedConnectorSpec(key);
    if (!spec || process.env[spec.enabledEnv] === "false") return null;
    return normalizeUrl(process.env[spec.serverUrlEnv] || spec.defaultServerUrl);
}

function policyManagedConnector(
    connector: Pick<ConnectorRow, "tool_policy"> | { tool_policy?: Record<string, unknown> | null },
): BackendManagedConnectorKey | null {
    const key = connector.tool_policy?.managedConnector;
    return key === "practicepanther" || key === "box" ? key : null;
}

export function backendManagedBy(
    connector: Pick<ConnectorRow, "server_url"> &
        Partial<Pick<ConnectorRow, "tool_policy">>,
): BackendManagedConnectorKey | null {
    const policyKey = policyManagedConnector(connector);
    if (policyKey) return policyKey;

    for (const spec of enabledManagedConnectorSpecs()) {
        const serverUrl = managedMcpServerUrl(spec.key);
        if (serverUrl && connector.server_url === serverUrl) return spec.key;
    }
    return null;
}

export function isBackendManagedMcpConnector(
    connector: Pick<ConnectorRow, "server_url"> &
        Partial<Pick<ConnectorRow, "tool_policy">>,
) {
    return backendManagedBy(connector) !== null;
}

export function managedConnectorDisplayName(key: BackendManagedConnectorKey) {
    return managedConnectorSpec(key)?.name ?? "Managed MCP connector";
}

function managedToolPolicy(row: ConnectorRow, spec: ManagedConnectorSpec) {
    return {
        ...(row.tool_policy ?? {}),
        managedBy: "backend",
        managedConnector: spec.key,
    };
}

function sameToolPolicy(
    left: Record<string, unknown> | null,
    right: Record<string, unknown>,
) {
    const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
    );
    const rightEntries = Object.entries(right).sort(([a], [b]) =>
        a.localeCompare(b),
    );
    return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

async function toolCount(connectorId: string, db: Db) {
    const { count, error } = await db
        .from("user_mcp_connector_tools")
        .select("id", { count: "exact", head: true })
        .eq("connector_id", connectorId);
    if (error) throw error;
    return count ?? 0;
}

async function copyToolsFromTemplate(
    spec: ManagedConnectorSpec,
    userId: string,
    connector: ConnectorRow,
    db: Db,
) {
    const serverUrl = managedMcpServerUrl(spec.key);
    if (!serverUrl) return;

    const { data: templateConnectors, error: templateConnectorError } = await db
        .from("user_mcp_connectors")
        .select("*")
        .eq("server_url", serverUrl)
        .neq("id", connector.id)
        .limit(1);
    if (templateConnectorError) throw templateConnectorError;

    const template = (templateConnectors ?? [])[0] as ConnectorRow | undefined;
    if (!template) return;

    const { data: templateTools, error: templateToolsError } = await db
        .from("user_mcp_connector_tools")
        .select("*")
        .eq("connector_id", template.id);
    if (templateToolsError) throw templateToolsError;

    const tools = (templateTools ?? []) as ToolCacheRow[];
    if (!tools.length) return;

    const rows = tools.map((tool) => ({
        connector_id: connector.id,
        tool_name: tool.tool_name,
        openai_tool_name: openaiToolName(connector, tool.tool_name),
        title: tool.title,
        description: tool.description,
        input_schema: tool.input_schema,
        output_schema: tool.output_schema,
        annotations: tool.annotations,
        enabled: tool.enabled,
        requires_confirmation: tool.requires_confirmation,
        last_seen_at: new Date().toISOString(),
    }));

    const { error } = await db
        .from("user_mcp_connector_tools")
        .upsert(rows, { onConflict: "connector_id,tool_name" });
    if (error) throw error;

    console.info("[mcp-connectors] seeded default managed MCP tools", {
        managedConnector: spec.key,
        userId,
        connectorId: connector.id,
        toolCount: rows.length,
    });
}

async function ensureDefaultMcpConnector(
    spec: ManagedConnectorSpec,
    userId: string,
    db: Db,
): Promise<void> {
    const serverUrl = managedMcpServerUrl(spec.key);
    if (!serverUrl) return;

    const { data: existing, error: existingError } = await db
        .from("user_mcp_connectors")
        .select("*")
        .eq("user_id", userId)
        .eq("server_url", serverUrl)
        .maybeSingle();
    if (existingError) throw existingError;

    if (existing) {
        const row = existing as ConnectorRow;
        const update: Record<string, unknown> = {};
        if (!row.enabled) update.enabled = true;
        if (row.name !== spec.name) update.name = spec.name;
        if (row.auth_type !== spec.authType) update.auth_type = spec.authType;
        const nextPolicy = managedToolPolicy(row, spec);
        if (!sameToolPolicy(row.tool_policy, nextPolicy)) {
            update.tool_policy = nextPolicy;
        }

        if (Object.keys(update).length) {
            update.updated_at = new Date().toISOString();
            const { error } = await db
                .from("user_mcp_connectors")
                .update(update)
                .eq("user_id", userId)
                .eq("id", row.id);
            if (error) throw error;
        }
        if ((await toolCount(row.id, db)) === 0) {
            await copyToolsFromTemplate(spec, userId, row, db);
        }
        return;
    }

    const { data, error } = await db
        .from("user_mcp_connectors")
        .insert({
            user_id: userId,
            name: spec.name,
            transport: "streamable_http",
            server_url: serverUrl,
            auth_type: spec.authType,
            enabled: true,
            tool_policy: {
                managedBy: "backend",
                managedConnector: spec.key,
            },
            encrypted_auth_config: null,
            auth_config_iv: null,
            auth_config_tag: null,
        })
        .select("*")
        .single();
    if (error) throw error;

    await copyToolsFromTemplate(spec, userId, data as ConnectorRow, db);
}

export async function ensureDefaultMcpConnectors(
    userId: string,
    db: Db,
): Promise<void> {
    for (const spec of enabledManagedConnectorSpecs()) {
        await ensureDefaultMcpConnector(spec, userId, db);
    }
}
