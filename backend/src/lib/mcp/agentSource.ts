export const DOCKET_AGENT_SOURCE_KEY = "docketAgentSource";

// Only Quo has a connector row of its own for Docket Agent. PracticePanther
// and Box are served by the rows Docket itself keeps for the user.
export type DocketAgentMarkedSource = "quo";

/** The Docket Agent source a connector row was made for, or null. */
export function docketAgentSourceOf(
  toolPolicy: Record<string, unknown> | null | undefined,
): DocketAgentMarkedSource | null {
  return toolPolicy?.[DOCKET_AGENT_SOURCE_KEY] === "quo" ? "quo" : null;
}

/** True when the row carries a Docket Agent mark of any kind, known or not. */
export function hasDocketAgentMark(
  toolPolicy: Record<string, unknown> | null | undefined,
): boolean {
  return !!toolPolicy && DOCKET_AGENT_SOURCE_KEY in toolPolicy;
}
