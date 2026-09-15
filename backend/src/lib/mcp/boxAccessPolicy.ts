import { createHash } from "node:crypto";
import { canonicalMcpArguments } from "./approvals";
import { classifyMcpAction } from "./practicePantherAttribution";
import type { ConnectorRow, ToolCacheRow } from "./types";

// Only documented Box read operations may run without approval. A newly
// discovered tool stays available, but needs review even if its hints say read.
// https://developer.box.com/guides/box-mcp/tools
const BOX_READ_TOOLS = new Set([
    "who_am_i",
    "get_download_url",
    "get_file_content",
    "get_file_details",
    "get_file_preview",
    "get_folder_details",
    "list_folder_content_by_folder_id",
    "get_metadata_template_schema",
    "list_metadata_templates",
    "search_files_keyword",
    "search_files_metadata",
    "search_folders_by_name",
    "list_file_comments",
    "list_item_collaborations",
    "list_tasks",
    "ai_extract_freeform",
    "ai_extract_structured",
    "ai_extract_structured_from_fields",
    "ai_extract_structured_from_fields_enhanced",
    "ai_extract_structured_from_metadata_template",
    "ai_extract_structured_from_metadata_template_enhanced",
    "ai_qa_hub",
    "ai_qa_multi_file",
    "ai_qa_single_file",
    "get_hub_details",
    "get_hub_items",
    "list_hubs",
    "get_docgen_template_by_id",
    "list_docgen_templates",
]);

export function boxToolRequiresApproval(
    tool: Pick<ToolCacheRow, "tool_name" | "annotations" | "requires_confirmation">,
    args: Record<string, unknown> = {},
): boolean {
    // Neither cached flags nor a read-only hint can exempt an unrecognized
    // operation. Explicit mutation hints on a known read still require review.
    return (
        tool.requires_confirmation === true ||
        !BOX_READ_TOOLS.has(tool.tool_name) ||
        classifyMcpAction(tool.tool_name, args, {
            readOnlyHint: true,
            ...tool.annotations,
        }) === "mutation"
    );
}

export function boxApprovalPolicyVersion(
    connector: Pick<ConnectorRow, "server_url">,
    tool: Pick<ToolCacheRow, "tool_name" | "input_schema" | "annotations">,
): string {
    // An approval cannot survive a changed destination or tool contract.
    const fingerprint = createHash("sha256")
        .update(canonicalMcpArguments({
            serverUrl: connector.server_url,
            toolName: tool.tool_name,
            inputSchema: tool.input_schema,
            annotations: tool.annotations,
        }))
        .digest("hex");
    return `box-2026-09-15.1:${fingerprint}`;
}
