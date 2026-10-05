// The mark that says "this connector row serves a Docket Agent source".
// It lives in the row's tool_policy JSON. Only provisioning writes it.

export const DOCKET_AGENT_SOURCE_KEY = "docketAgentSource";
export type DocketAgentMarkedSource = "practicepanther" | "quo";

/** The Docket Agent source a connector row serves, or null. */
export function docketAgentSourceOf(
  toolPolicy: Record<string, unknown> | null | undefined,
): DocketAgentMarkedSource | null {
  const value = toolPolicy?.[DOCKET_AGENT_SOURCE_KEY];
  return value === "practicepanther" || value === "quo" ? value : null;
}
