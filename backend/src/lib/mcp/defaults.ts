import { openaiToolName } from "./client";
import type { ConnectorRow, Db, ToolCacheRow } from "./types";

export type BackendManagedConnectorKey = "practicepanther" | "box";

const DEFAULT_PRACTICEPANTHER_MCP_SERVER_URL =
    "https://wild-spark-qn7iy.run.mcp-use.com/mcp";
const PRACTICEPANTHER_USER_MCP_SERVER_URL_ENV =
    "PRACTICEPANTHER_USER_MCP_SERVER_URL";
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

function perUserPracticePantherRequested(): boolean {
    return !!process.env[PRACTICEPANTHER_USER_MCP_SERVER_URL_ENV]?.trim();
}

function hostname(rawUrl: string): string | null {
    try {
        return new URL(rawUrl).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function legacyPracticePantherHosts(): Set<string> {
    return new Set(
        [
            DEFAULT_PRACTICEPANTHER_MCP_SERVER_URL,
            process.env.PRACTICEPANTHER_MCP_SERVER_URL,
        ]
            .filter((url): url is string => !!url)
            .map(hostname)
            .filter((url): url is string => !!url),
    );
}

export function managedMcpAuthType(
    key: BackendManagedConnectorKey,
): ConnectorRow["auth_type"] {
    return key === "practicepanther" && perUserPracticePantherRequested()
        ? "oauth"
        : managedConnectorSpec(key)?.authType ?? "none";
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
    if (key === "practicepanther" && perUserPracticePantherRequested()) {
        const serverUrl = normalizeUrl(
            process.env[PRACTICEPANTHER_USER_MCP_SERVER_URL_ENV]!.trim(),
        );
        // A misconfigured cutover must never point the per-user OAuth connector
        // back at a shared-identity service.
        return serverUrl && !legacyPracticePantherHosts().has(hostname(serverUrl) ?? "")
            ? serverUrl
            : null;
    }
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

    if (legacyPracticePantherHosts().has(hostname(connector.server_url) ?? "")) {
        return "practicepanther";
    }

    for (const spec of enabledManagedConnectorSpecs()) {
        const serverUrl = managedMcpServerUrl(spec.key);
        if (serverUrl && connector.server_url === serverUrl) return spec.key;
    }
    return null;
}

export function isPrimaryPracticePantherConnector(
    connector: Pick<ConnectorRow, "server_url" | "auth_type"> &
        Partial<Pick<ConnectorRow, "tool_policy">>,
): boolean {
    const activeUrl = practicePantherMcpServerUrl();
    return !!activeUrl &&
        connector.server_url === activeUrl &&
        connector.auth_type === managedMcpAuthType("practicepanther") &&
        backendManagedBy(connector) === "practicepanther";
}

export function isRetiredPracticePantherConnector(
    connector: Pick<ConnectorRow, "server_url" | "auth_type"> &
        Partial<Pick<ConnectorRow, "tool_policy">>,
): boolean {
    return perUserPracticePantherRequested() &&
        backendManagedBy(connector) === "practicepanther" &&
        !isPrimaryPracticePantherConnector(connector);
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
        const authType = managedMcpAuthType(spec.key);
        if (row.auth_type !== authType) update.auth_type = authType;
        if (spec.key === "practicepanther" && authType === "oauth" && row.encrypted_auth_config) {
            update.encrypted_auth_config = null;
            update.auth_config_iv = null;
            update.auth_config_tag = null;
        }
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
            auth_type: managedMcpAuthType(spec.key),
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

async function retireLegacyPracticePantherConnectors(userId: string, db: Db) {
    if (!perUserPracticePantherRequested()) return;
    const { data, error } = await db
        .from("user_mcp_connectors")
        .select("*")
        .eq("user_id", userId);
    if (error) throw error;
    for (const row of (data ?? []) as ConnectorRow[]) {
        if (!row.enabled || !isRetiredPracticePantherConnector(row)) continue;
        const { error: updateError } = await db
            .from("user_mcp_connectors")
            .update({ enabled: false, updated_at: new Date().toISOString() })
            .eq("user_id", userId)
            .eq("id", row.id);
        if (updateError) throw updateError;
    }
}

export async function ensureDefaultMcpConnectors(
    userId: string,
    db: Db,
): Promise<void> {
    await retireLegacyPracticePantherConnectors(userId, db);
    for (const spec of enabledManagedConnectorSpecs()) {
        await ensureDefaultMcpConnector(spec, userId, db);
    }
}
