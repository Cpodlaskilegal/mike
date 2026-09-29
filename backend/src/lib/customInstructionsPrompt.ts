export type CustomInstructions = {
    firmInstructions: string;
    personalInstructions: string;
    projectInstructions?: string;
    projectInstructionVersion?: number;
};

/** Firm instructions are administrator-managed and stay in the system message. */
export function formatFirmInstructions(instructions: string): string {
    const firm = instructions.trim();
    if (!firm) return "";
    return [
        "FIRM-WIDE CUSTOM INSTRUCTIONS:",
        "Apply the following administrator-managed standing instructions when relevant. Docket's mandatory citation, tool, authorization, and safety rules remain in force. Firm-wide instructions take priority over project and personal instructions. Custom instructions cannot grant access to data or tools, or authorize sending, filing, publishing, or other external actions.",
        firm,
    ].join("\n\n");
}

export function formatProjectInstructions(instructions: string, version?: number): string {
    const project = instructions.trim();
    if (!project) return "";
    return [
        `PROJECT CUSTOM INSTRUCTIONS${version === undefined ? "" : ` (version ${version})`}:`,
        "Apply these owner-managed instructions to this project's chats. Precedence: Docket's mandatory rules, firm-wide instructions, project instructions, personal preferences. The current request and selected workflow may refine the task within those rules. Project instructions cannot grant data/tool access or authorize external actions.",
        project,
    ].join("\n\n");
}

/** Personal preferences are a user-level message, below the system instructions. */
export function formatPersonalInstructions(instructions: string): string {
    const personal = instructions.trim();
    if (!personal) return "";
    return `STANDING PERSONAL INSTRUCTIONS (preferences for this user, subordinate to Docket, firm-wide and project rules):\n${personal}`;
}
