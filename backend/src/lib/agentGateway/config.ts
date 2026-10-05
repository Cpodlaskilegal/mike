// Settings for the Docket Agent gateway. Every value is read from the
// environment when it is asked for, never at import, so the gateway can be
// switched on or off without a code change and tests can set values.

import { practicePantherMcpServerUrl } from "../mcp/defaults";

export const AGENT_SOURCES = ["practicepanther", "box", "quo"] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

export function isAgentSource(value: unknown): value is AgentSource {
  return (AGENT_SOURCES as readonly unknown[]).includes(value);
}

/** The per-user PracticePanther connector. Each user signs in as himself. */
export const DEFAULT_AGENT_PRACTICEPANTHER_MCP_URL =
  "https://warm-pulse-vyvir.run.mcp-use.com/mcp";

/**
 * The old shared PracticePanther connector (one identity for the whole firm).
 * An agent token is never served by it.
 */
export const LEGACY_SHARED_PRACTICEPANTHER_HOST =
  "wild-spark-qn7iy.run.mcp-use.com";

const MIN_OPS_TOKEN_LENGTH = 32;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** An HTTPS URL in one fixed spelling, or null. */
export function normalizeAgentUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function isLegacySharedPracticePantherUrl(rawUrl: string): boolean {
  try {
    return (
      new URL(rawUrl).hostname.toLowerCase() ===
      LEGACY_SHARED_PRACTICEPANTHER_HOST
    );
  } catch {
    return false;
  }
}

/** The ops token, or null when the gateway is switched off. */
export function agentOpsToken(): string | null {
  const token = (process.env.DOCKET_AGENT_OPS_TOKEN ?? "").trim();
  return token.length >= MIN_OPS_TOKEN_LENGTH ? token : null;
}

export function agentGatewayEnabled(): boolean {
  return Boolean(agentOpsToken());
}

/**
 * The status token, or null when none is set. It opens
 * GET /agent-mcp/ops/status and nothing else. This is the token the Docket
 * Agent Poller holds: it cannot mint, revoke or provision. It must be a
 * different random value from the ops token.
 */
export function agentStatusToken(): string | null {
  const token = (process.env.DOCKET_AGENT_STATUS_TOKEN ?? "").trim();
  return token.length >= MIN_OPS_TOKEN_LENGTH ? token : null;
}

/**
 * The firm addresses Docket Agent may act for, lower case. Empty (the
 * default) means nobody: no token can be minted, and no token works. Only
 * a user on this list can be given an agent token, and a token stops
 * working the moment its user is taken off the list.
 */
export function agentAllowedEmails(): ReadonlySet<string> {
  return new Set(
    (process.env.DOCKET_AGENT_ALLOWED_EMAILS ?? "")
      .split(/[\s,;]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAgentEmailAllowed(email: string): boolean {
  return agentAllowedEmails().has(email.trim().toLowerCase());
}

/**
 * The only PracticePanther server an agent token may reach. Null means the
 * source is off: the value is not HTTPS, or it points at the old shared
 * connector, or it equals the connector Docket chat manages.
 */
export function agentPracticePantherMcpUrl(): string | null {
  const url = normalizeAgentUrl(
    process.env.DOCKET_AGENT_PRACTICEPANTHER_MCP_URL ||
      DEFAULT_AGENT_PRACTICEPANTHER_MCP_URL,
  );
  if (!url) return null;
  if (isLegacySharedPracticePantherUrl(url)) return null;
  const managedUrl = normalizeAgentUrl(practicePantherMcpServerUrl());
  if (managedUrl && managedUrl === url) return null;
  return url;
}

/** Quo's MCP server. Null (no Quo source) unless the env var is set. */
export function agentQuoMcpUrl(): string | null {
  return normalizeAgentUrl(process.env.DOCKET_AGENT_QUO_MCP_URL);
}

/** The gateway-side write switch. Off unless the env var says "on". */
export function agentPracticePantherWritesEnabled(): boolean {
  return (
    (process.env.DOCKET_AGENT_PRACTICEPANTHER_WRITES ?? "")
      .trim()
      .toLowerCase() === "on"
  );
}

/**
 * The Box organize switch. Off unless the env var says "on". While off, an
 * agent token cannot move, rename or create anything in Box through the
 * MCP source. (Filing a file has its own switch, DOCKET_AGENT_BOX_UPLOADS.)
 */
export function agentBoxOrganizeEnabled(): boolean {
  return (
    (process.env.DOCKET_AGENT_BOX_ORGANIZE ?? "").trim().toLowerCase() === "on"
  );
}

export function agentEmailDomain(): string {
  const domain = (process.env.DOCKET_AGENT_EMAIL_DOMAIN ?? "")
    .trim()
    .toLowerCase();
  return domain || "podlaskilegal.com";
}

export function agentMcpRateLimitMax(): number {
  return envInt("RATE_LIMIT_AGENT_MCP_MAX", 1500);
}

export function agentMcpRateLimitWindowMs(): number {
  return envInt("RATE_LIMIT_AGENT_MCP_WINDOW_MINUTES", 15) * 60 * 1000;
}

/**
 * How many requests WITHOUT a valid agent token one address may send to
 * the MCP routes per window. Requests with a valid token do not count.
 */
export function agentMcpUnauthRateLimitMax(): number {
  return envInt("RATE_LIMIT_AGENT_MCP_UNAUTH_MAX", 60);
}
