// Which tool an agent token may call, per source. Pure functions.
//
// The rule (christopher, 2026-10-02): Docket Agent may do what the user's own
// permissions let him do (his PracticePanther, Box and Quo sign-ins, his
// Docket role), except what christopher ordered or the partner assistant
// itself has off. Here that is: no delete anywhere and no raw PracticePanther
// API tool (K2); nothing that sends a message to a person (K3); PracticePanther
// changes only while the write switch is on (K1; the propose-first rule and
// the narrow WRITE session are the Docket Agent side's).
//
// Short version:
// - A tool the connector's tool cache does not know is denied.
// - Delete tools are denied. Tools that send a message to a person are denied.
// - PracticePanther: reads follow Docket's own policy file, plus the short
//   list of extra reads below; Docket's admin-only reads only for an admin.
//   Writes are limited to the lists below and only when the gateway write
//   switch is on; the admin-only ones only for an admin.
// - Box: documented reads, and a page preview. With the organize switch on,
//   also a new folder, a move, a copy, an item's properties (name,
//   description, tags, collections) and its metadata. Never a delete, a
//   comment, a shared link or a collaboration.
// - Quo: reads, and creating and updating contacts and tasks.

import { boxToolRequiresApproval } from "../mcp/boxAccessPolicy";
import { practicePantherToolPolicy } from "../mcp/practicePantherAccessPolicy";
import { classifyMcpAction } from "../mcp/practicePantherAttribution";
import type { ConnectorRow, ToolCacheRow } from "../mcp/types";
import type { AppUserRole } from "../userRoles";
import type { AgentSource } from "./config";

// Create and update tools any agent token may use when writes are switched
// on: the record types the partner assistant changes (tasks, time entries,
// notes, events, call logs, matters, logged emails, accounts,
// relationships, files). The names are the per-user connector's own. Not
// here, so refused: every delete, the raw API tool, PracticePanther messages
// (they go to a contact), and the money records Docket keeps admin-only
// (those are in the admin list below).
export const AGENT_PRACTICEPANTHER_WRITE_TOOLS = [
  "Tasks_PostTask",
  "Tasks_PutTask",
  "TimeEntries_PostAccount",
  "TimeEntries_PutAccount",
  "Notes_PostNote",
  "Notes_PutNote",
  "Events_PostAccount",
  "Events_PutAccount",
  "CallLogs_PostCallLog",
  "CallLogs_PutCallLog",
  "Matters_PostMatter",
  "Matters_PutMatter",
  "Emails_PostEmail",
  "Emails_PutAccount",
  "Accounts_PostAccount",
  "Accounts_PutAccount",
  "Relationships_PostAccount",
  "Relationships_PutRelationship",
  "Files_PostFile",
  "Files_PostFileToBox",
  "Files_PutFile",
] as const;

// Create and update tools of the records Docket keeps admin-only (bank
// accounts, expense categories, expenses, flat fees, items). Docket's own
// rule gives these to a user whose Docket role is admin, so an admin's agent
// token may use them while writes are switched on; nobody else's may.
// Invoices and payments have no create or update tool. Exactly Docket's
// admin-only creates and updates (a test holds the two files to that).
export const AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS = [
  "BankAccounts_PostBankAccount",
  "BankAccounts_PutBankAccount",
  "ExpenseCategories_PostExpenseCategory",
  "ExpenseCategories_PutExpenseCategory",
  "Expenses_PostAccount",
  "Expenses_PutAccount",
  "FlatFees_PostAccount",
  "FlatFees_PutAccount",
  "Items_PostItem",
  "Items_PutItem",
] as const;

// PracticePanther tools that write a message to a contact. In the
// connector's API definition a Message has a contact, a type ("Text": a text
// from the firm's text number, or "Secure": a client-portal message), a body
// and a sent date: it is the conversation with a person outside the firm,
// not a note. Creating one sends it. Changing one changes a message the
// contact has been sent or can read in the portal, and the definition does
// not say it is only a record. Docket Agent sends nothing to anyone but the
// requesting user (K3), so both are refused for every role, whatever the
// write switch says. Reading messages is allowed.
export const AGENT_PRACTICEPANTHER_SEND_TOOLS = [
  "Messages_PostMessage",
  "Messages_PutMessage",
] as const;

// Read tools an agent token of any role may call beyond Docket's read list:
// one the connector has and Docket's policy file does not name, and the
// firm's PracticePanther user list, which Docket chat keeps admin-only.
export const AGENT_PRACTICEPANTHER_EXTRA_READ_TOOLS = [
  "Messages_GetMessageAsync",
  "Users_GetUsers",
  "Users_GetUser",
  "Users_Me",
] as const;

// Box changes Docket Agent may make when the organize switch is on, through
// the user's own Box sign-in: a new folder, a move, a copy, an item's
// properties (its name, description, tags and collections) and a metadata
// instance on a file or folder. Box itself decides what his account may
// change (christopher, 2026-10-02: the user's own permissions, except
// K1-K5). Not here, so refused: every delete (K2); comments, shared links
// and collaborations, each of which can reach another person (K3); changes
// to the firm's metadata templates and uploads as tool calls (open for
// christopher, GATEWAY-DESIGN.md 15.11).
export const AGENT_BOX_ORGANIZE_TOOLS = [
  "create_folder",
  "move_file",
  "move_folder",
  "update_file_properties",
  "update_folder_properties",
  "copy_file",
  "copy_folder",
  "set_file_metadata",
  "set_folder_metadata",
] as const;

// Box reads any agent token may make beyond the reads Docket chat runs
// without asking (BOX_READ_TOOLS in mcp/boxAccessPolicy.ts, which this file
// does not change): one page of a file's preview. A read the user's own Box
// account allows.
export const AGENT_BOX_EXTRA_READS = ["get_preview_page"] as const;

// Quo changes Docket Agent may make, through the user's own Quo sign-in:
// creating and updating a contact or a task, as the partner assistant's tool
// list has them. Quo itself decides what his account may change. Never a
// message (any Quo tool that sends is refused, K3) and never a delete (K2).
export const AGENT_QUO_WRITE_TOOLS = [
  "create-contact",
  "update-contact",
  "create-task",
  "update-task",
] as const;

// The arguments an organize tool may carry, each with its shape (the
// shapes of Box's own MCP tools). An argument this table does not list is
// refused, so a new option Box adds to one of these tools (a share setting,
// a lock, a collaborator) stays off until someone has looked at it: a share
// or a collaborator reaches another person (K3).
//
// Not checked, on purpose: where a move or a copy goes. parent_folder_id
// may be any folder, Box's root ("0") included. In Box access follows the
// parent folder, so a move or a copy can change who sees the item. The
// user's own Box permissions decide what he may put where (christopher,
// 2026-10-02: Docket Agent adds no restriction of its own beyond K1-K5), and
// the partner assistant has no such limit either. A copy names its
// destination: Box would otherwise put it in the user's root folder.
type BoxArgumentShape =
  | "text" // a non-empty string: an id, a name, a template key
  | "any_text" // any string, the empty one included: a description
  | "tags" // a list of strings
  | "collections" // a list of {"id": "<string>"}
  | "scope" // "enterprise" or "global"
  | "fields"; // an object of strings, numbers and lists of strings

const BOX_ORGANIZE_ARGUMENTS: Record<
  string,
  {
    allowed: Readonly<Record<string, BoxArgumentShape>>;
    required: readonly string[];
    /** At least one of these must be set (a change that changes nothing is refused). */
    oneOf?: readonly string[];
  }
> = {
  create_folder: {
    allowed: { name: "text", parent_folder_id: "text" },
    required: ["name"],
  },
  move_file: {
    allowed: { file_id: "text", parent_folder_id: "text", name: "text" },
    required: ["file_id", "parent_folder_id"],
  },
  move_folder: {
    allowed: { folder_id: "text", parent_folder_id: "text", name: "text" },
    required: ["folder_id", "parent_folder_id"],
  },
  copy_file: {
    allowed: { file_id: "text", parent_folder_id: "text", name: "text" },
    required: ["file_id", "parent_folder_id"],
  },
  copy_folder: {
    allowed: { folder_id: "text", parent_folder_id: "text", name: "text" },
    required: ["folder_id", "parent_folder_id"],
  },
  update_file_properties: {
    allowed: {
      file_id: "text",
      name: "text",
      description: "any_text",
      tags: "tags",
      collections: "collections",
    },
    required: ["file_id"],
    oneOf: ["name", "description", "tags", "collections"],
  },
  update_folder_properties: {
    allowed: {
      folder_id: "text",
      name: "text",
      description: "any_text",
      tags: "tags",
      collections: "collections",
    },
    required: ["folder_id"],
    oneOf: ["name", "description", "tags", "collections"],
  },
  set_file_metadata: {
    allowed: {
      file_id: "text",
      scope: "scope",
      template_key: "text",
      metadata_fields: "fields",
    },
    required: ["file_id", "scope", "template_key", "metadata_fields"],
  },
  set_folder_metadata: {
    allowed: {
      folder_id: "text",
      scope: "scope",
      template_key: "text",
      metadata_fields: "fields",
    },
    required: ["folder_id", "scope", "template_key", "metadata_fields"],
  },
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function boxArgumentHasShape(shape: BoxArgumentShape, value: unknown): boolean {
  switch (shape) {
    case "text":
      return isText(value);
    case "any_text":
      return typeof value === "string";
    case "tags":
      return Array.isArray(value) && value.every(isText);
    case "collections":
      return (
        Array.isArray(value) &&
        value.every(
          (item) =>
            isPlainRecord(item) &&
            Object.keys(item).length === 1 &&
            isText(item.id),
        )
      );
    case "scope":
      return value === "enterprise" || value === "global";
    case "fields":
      return (
        isPlainRecord(value) &&
        Object.keys(value).length > 0 &&
        Object.values(value).every(
          (field) =>
            typeof field === "string" ||
            (typeof field === "number" && Number.isFinite(field)) ||
            (Array.isArray(field) && field.every((item) => typeof item === "string")),
        )
      );
    default:
      return false;
  }
}

export type AgentToolDecision =
  | { effect: "allow"; kind: "read" | "write" }
  | {
      effect: "deny";
      reason:
        | "unknown_tool"
        | "delete_denied"
        | "send_denied"
        | "raw_api_denied"
        | "admin_only"
        | "write_not_allowed_for_agent"
        | "writes_off"
        | "organize_off"
        | "organize_arguments"
        | "tool_disabled"
        | "needs_approval_in_docket"
        | "not_a_read";
    };

const AGENT_WRITE = new Set<string>(AGENT_PRACTICEPANTHER_WRITE_TOOLS);
const AGENT_ADMIN_WRITE = new Set<string>(AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS);
const AGENT_SEND = new Set<string>(AGENT_PRACTICEPANTHER_SEND_TOOLS);
const AGENT_EXTRA_READ = new Set<string>(AGENT_PRACTICEPANTHER_EXTRA_READ_TOOLS);
const BOX_ORGANIZE = new Set<string>(AGENT_BOX_ORGANIZE_TOOLS);
const BOX_EXTRA_READ = new Set<string>(AGENT_BOX_EXTRA_READS);
const QUO_WRITE = new Set<string>(AGENT_QUO_WRITE_TOOLS);

// Same test Docket uses for a delete (isDeleteMutation in mcp/servers.ts).
const DELETE_NAME_RE = /(^|[_-])(delete|remove)/i;

// A Quo tool that sends a message: send-message, send-group-message,
// send-bulk-messages today, and any later tool named the same way.
const SEND_NAME_RE = /(^|[_-])send/i;

function deny(
  reason: Extract<AgentToolDecision, { effect: "deny" }>["reason"],
): AgentToolDecision {
  return { effect: "deny", reason };
}

/**
 * The connector names a tool after PracticePanther's operation id. When an
 * operation id repeats, the second tool gets a numeric suffix
 * (Tasks_PutTask_2). Policy is decided on the name without that suffix.
 */
export function practicePantherBaseToolName(toolName: string): string {
  return toolName.replace(/_\d+$/, "");
}

export function isDeleteToolName(toolName: string): boolean {
  return DELETE_NAME_RE.test(toolName);
}

function isPracticePantherReadName(baseName: string): boolean {
  return /_Get/.test(baseName) || baseName === "Users_Me";
}

function authorizePracticePanther(input: {
  role: AppUserRole;
  tool: ToolCacheRow | null;
  toolName: string;
  practicePantherWritesEnabled: boolean;
}): AgentToolDecision {
  const base = practicePantherBaseToolName(input.toolName);

  // The raw API tool can send any method, deletes too. Never, admins included.
  if (base.toLowerCase() === "pp_api_request") return deny("raw_api_denied");
  if (isDeleteToolName(base)) return deny("delete_denied");
  // A message to a contact. Never, admins included, whatever the switch.
  if (AGENT_SEND.has(base)) return deny("send_denied");
  if (!input.tool) return deny("unknown_tool");

  // Any of the listed write tools, for any agent token, while the switch is
  // on. Nothing here knows which entries a user approved: Docket Agent's
  // poller narrows the session's own tool list to its proposal's tools, and
  // which record is changed is not checked anywhere (GATEWAY-DESIGN.md 14.6).
  if (AGENT_WRITE.has(base)) {
    return input.practicePantherWritesEnabled
      ? { effect: "allow", kind: "write" }
      : deny("writes_off");
  }
  if (AGENT_EXTRA_READ.has(base)) return { effect: "allow", kind: "read" };

  const policy = practicePantherToolPolicy(base);
  if (policy === "read_all") return { effect: "allow", kind: "read" };
  if (policy === "admin_only") {
    // Docket's own rule: this group is for a user whose Docket role is
    // admin. Read from the database on every request, so a role taken
    // away takes these away at once.
    if (input.role !== "admin") return deny("admin_only");
    if (isPracticePantherReadName(base)) return { effect: "allow", kind: "read" };
    if (AGENT_ADMIN_WRITE.has(base)) {
      return input.practicePantherWritesEnabled
        ? { effect: "allow", kind: "write" }
        : deny("writes_off");
    }
    // An admin-only name that is neither a read nor on the admin list (a
    // tool Docket adds to the group later) stays off until someone looks.
    return deny("admin_only");
  }
  if (policy === "write_with_approval") {
    // Left here: only names in Docket's file the connector does not have.
    return deny("write_not_allowed_for_agent");
  }
  return deny("unknown_tool");
}

/** True for a Box tool that changes Box and that the organize switch opens. */
export function isAgentBoxOrganizeTool(toolName: string): boolean {
  return BOX_ORGANIZE.has(toolName);
}

/**
 * Whether these arguments are what an organize tool may carry: every
 * required one is there, every one set has its shape, and nothing else is
 * set.
 */
export function boxOrganizeArgumentsAllowed(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  // Only the listed names have a rule. ("constructor" is not one.)
  if (!BOX_ORGANIZE.has(toolName)) return false;
  if (!Object.prototype.hasOwnProperty.call(BOX_ORGANIZE_ARGUMENTS, toolName)) {
    return false;
  }
  const rule = BOX_ORGANIZE_ARGUMENTS[toolName];
  for (const [key, value] of Object.entries(args)) {
    if (!Object.prototype.hasOwnProperty.call(rule.allowed, key)) return false;
    if (!boxArgumentHasShape(rule.allowed[key], value)) return false;
  }
  if (!rule.required.every((key) => Object.prototype.hasOwnProperty.call(args, key))) {
    return false;
  }
  return (
    !rule.oneOf ||
    rule.oneOf.some((key) => Object.prototype.hasOwnProperty.call(args, key))
  );
}

/**
 * The Box ids an organize call names, for its audit row. Ids only: never
 * the name a file or folder is given.
 */
export function boxOrganizeTargetRefs(
  args: Record<string, unknown>,
): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const key of ["file_id", "folder_id", "parent_folder_id"]) {
    const value = args[key];
    // Box's MCP server also writes a folder id as "d_123".
    if (typeof value === "string" && /^(?:[a-z]_)?\d{1,30}$/i.test(value)) {
      refs[key] = value;
    }
  }
  return refs;
}

function authorizeBox(input: {
  tool: ToolCacheRow | null;
  toolName: string;
  args: Record<string, unknown>;
  boxOrganizeEnabled: boolean;
  forListing: boolean;
}): AgentToolDecision {
  if (isDeleteToolName(input.toolName)) return deny("delete_denied");
  if (!input.tool) return deny("unknown_tool");
  // The same switch the user sees in Docket's connector settings.
  if (input.tool.enabled !== true) return deny("tool_disabled");
  if (BOX_ORGANIZE.has(input.tool.tool_name)) {
    if (!input.boxOrganizeEnabled) return deny("organize_off");
    // A tool list has no arguments to check; a call does.
    if (
      !input.forListing &&
      !boxOrganizeArgumentsAllowed(input.tool.tool_name, input.args)
    ) {
      return deny("organize_arguments");
    }
    return { effect: "allow", kind: "write" };
  }
  // A read Docket chat's list does not name (a page preview). Docket chat's
  // own confirmation flag is not consulted, as for the organize tools; a
  // hint that the tool changes something still refuses it.
  if (BOX_EXTRA_READ.has(input.tool.tool_name)) {
    return classifyMcpAction(input.tool.tool_name, input.args, {
      readOnlyHint: true,
      ...input.tool.annotations,
    }) === "read"
      ? { effect: "allow", kind: "read" }
      : deny("not_a_read");
  }
  // Otherwise only what Docket chat runs without asking the user:
  // documented reads.
  if (boxToolRequiresApproval(input.tool, input.args)) {
    return deny("needs_approval_in_docket");
  }
  return { effect: "allow", kind: "read" };
}

/** True for a Quo tool that sends a message (K3: never through the gateway). */
export function isQuoSendToolName(toolName: string): boolean {
  return SEND_NAME_RE.test(toolName);
}

function authorizeQuo(input: {
  tool: ToolCacheRow | null;
  toolName: string;
  args: Record<string, unknown>;
}): AgentToolDecision {
  if (isDeleteToolName(input.toolName)) return deny("delete_denied");
  if (isQuoSendToolName(input.toolName)) return deny("send_denied");
  if (!input.tool) return deny("unknown_tool");
  // A contact or a task, created or updated through the user's own Quo
  // sign-in. The cached flags are not consulted for these four, as for
  // PracticePanther: when Docket reads the tool list of a row it does not
  // manage, it marks every tool whose name says "create" or "update" as
  // needing confirmation and switches it off for chat, and the user cannot
  // switch it on. Those flags are Docket chat's, not the user's choice.
  if (QUO_WRITE.has(input.tool.tool_name)) {
    return { effect: "allow", kind: "write" };
  }
  if (input.tool.enabled !== true) return deny("tool_disabled");
  if (input.tool.requires_confirmation === true) {
    return deny("needs_approval_in_docket");
  }
  const kind = classifyMcpAction(
    input.tool.tool_name,
    input.args,
    input.tool.annotations,
  );
  return kind === "read" ? { effect: "allow", kind: "read" } : deny("not_a_read");
}

export function authorizeAgentTool(input: {
  source: AgentSource;
  role: AppUserRole;
  connector: ConnectorRow;
  tool: ToolCacheRow | null; // null = not in the connector's tool cache
  toolName: string;
  args: Record<string, unknown>;
  practicePantherWritesEnabled: boolean;
  /** The Box organize switch. Left out means off. */
  boxOrganizeEnabled?: boolean;
  /** True when building a tool list: there are no arguments to check. */
  forListing?: boolean;
}): AgentToolDecision {
  // A cache row of another connector is never this connector's tool.
  const tool =
    input.tool && input.tool.connector_id === input.connector.id
      ? input.tool
      : null;

  if (input.source === "practicepanther") {
    return authorizePracticePanther({
      role: input.role,
      tool,
      toolName: input.toolName,
      practicePantherWritesEnabled: input.practicePantherWritesEnabled,
    });
  }
  if (input.source === "box") {
    return authorizeBox({
      tool,
      toolName: input.toolName,
      args: input.args,
      boxOrganizeEnabled: input.boxOrganizeEnabled === true,
      forListing: input.forListing === true,
    });
  }
  if (input.source === "quo") {
    return authorizeQuo({ tool, toolName: input.toolName, args: input.args });
  }
  return deny("unknown_tool");
}
