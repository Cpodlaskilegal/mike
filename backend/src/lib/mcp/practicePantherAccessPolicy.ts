import type { AppUserRole } from "../userRoles";

export const PRACTICEPANTHER_POLICY_VERSION = "2026-07-23.1";

export const ADMIN_ONLY_PRACTICEPANTHER_TOOLS = [
  "BankAccounts_GetBankAccount",
  "BankAccounts_GetBankAccounts",
  "BankAccounts_PutBankAccount",
  "BankAccounts_PostBankAccount",
  "BankAccounts_Delete",
  "ExpenseCategories_GetExpenseCategory",
  "ExpenseCategories_GetExpenseCategories",
  "ExpenseCategories_PutExpenseCategory",
  "ExpenseCategories_PostExpenseCategory",
  "ExpenseCategories_Delete",
  "Expenses_GetExpense",
  "Expenses_GetExpensess",
  "Expenses_PutAccount",
  "Expenses_PostAccount",
  "Expenses_Delete",
  "FlatFees_GetFlatFee",
  "FlatFees_GetFlatFees",
  "FlatFees_PutAccount",
  "FlatFees_PostAccount",
  "FlatFees_Delete",
  "Invoices_GetInvoice",
  "Invoices_GetInvoices",
  "Invoices_Delete",
  "Items_GetItem",
  "Items_GetItems",
  "Items_PutItem",
  "Items_PostItem",
  "Items_Delete",
  "Payments_GetPayment",
  "Payments_GetPayments",
  "Payments_Delete",
  "Users_Me",
  "Users_GetUser",
  "Users_GetUsers",
  "Users_Delete",
  "pp_api_request",
] as const;

export const READ_ALL_PRACTICEPANTHER_TOOLS = [
  "Accounts_GetAccount",
  "Accounts_GetAccounts",
  "CallLogs_GetCallLog",
  "CallLogs_GetCallLogs",
  "Contacts_GetContact",
  "Contacts_GetContacts",
  "CustomFields_GetCustomFieldsForAccount",
  "CustomFields_GetCustomFieldsForMatter",
  "CustomFields_GetCustomFieldsForContact",
  "CustomFields_GetCustomField",
  "Emails_GetEmail",
  "Emails_GetEmails",
  "Events_GetEvent",
  "Events_GetEvents",
  "Files_GetFile",
  "Files_DownloadFile",
  "Files_GetFiles",
  "Matters_GetMatter",
  "Matters_GetMatters",
  "Messages_GetMessagesAsync",
  "Notes_GetNote",
  "Notes_GetNotes",
  "Relationships_GetRelationship",
  "Relationships_GetRelationships",
  "Tags_GetTagsForAccounts",
  "Tags_GetTagsForProjects",
  "Tags_GetTagsForActivities",
  "Tasks_GetTask",
  "Tasks_GetTasks",
  "TimeEntries_GetTimeEntry",
  "TimeEntries_GetTimeEntrys",
  "pp_oauth_status",
  "pp_get_box_embed",
  "pp_get_matter_box_folder",
] as const;

export const WRITE_WITH_APPROVAL_PRACTICEPANTHER_TOOLS = [
  "Accounts_PutAccount",
  "Accounts_PostAccount",
  "Accounts_Delete",
  "CallLogs_PutCallLog",
  "CallLogs_PostCallLog",
  "CallLogs_Delete",
  "Emails_PutAccount",
  "Emails_PostEmail",
  "Emails_Delete",
  "Events_PutAccount",
  "Events_PostAccount",
  "Events_Delete",
  "Files_PostFileToBox",
  "Files_PutFile",
  "Files_PostFile",
  "Files_Delete",
  "Matters_PutAccount",
  "Matters_PostAccount",
  "Matters_Delete",
  "Messages_PutMessage",
  "Messages_PostMessage",
  "Messages_Delete",
  "Notes_PutNote",
  "Notes_PostNote",
  "Notes_Delete",
  "Relationships_PutRelationship",
  "Relationships_PostAccount",
  "Relationships_Delete",
  "Tasks_PutAccount",
  "Tasks_PostAccount",
  "Tasks_Delete",
  "TimeEntries_PutAccount",
  "TimeEntries_PostAccount",
  "TimeEntries_Delete",
] as const;

export type PracticePantherToolPolicy =
  | "admin_only"
  | "read_all"
  | "write_with_approval"
  | "deny";

export type PracticePantherPolicyDecision = {
  effect: "allow" | "approval_required" | "deny";
  reason:
    | "admin_only"
    | "read_allowed"
    | "user_approval_required"
    | "approved_once"
    | "internal_actor_audit"
    | "unknown_tool";
  policy: PracticePantherToolPolicy;
  policyVersion: string;
};

const ADMIN_ONLY = new Set<string>(ADMIN_ONLY_PRACTICEPANTHER_TOOLS);
const READ_ALL = new Set<string>(READ_ALL_PRACTICEPANTHER_TOOLS);
const WRITE_WITH_APPROVAL = new Set<string>(
  WRITE_WITH_APPROVAL_PRACTICEPANTHER_TOOLS,
);
const INTERNAL_ACTOR_AUDIT_TOOLS = new Set(["Notes_PostNote", "Notes_PutNote"]);

export function practicePantherToolPolicy(
  toolName: string,
): PracticePantherToolPolicy {
  if (ADMIN_ONLY.has(toolName)) return "admin_only";
  if (READ_ALL.has(toolName)) return "read_all";
  if (WRITE_WITH_APPROVAL.has(toolName)) return "write_with_approval";
  return "deny";
}

export function authorizePracticePantherTool(input: {
  role: AppUserRole;
  toolName: string;
  args?: Record<string, unknown>;
  approvalGranted?: boolean;
  internalPurpose?: "practicepanther_actor_audit";
}): PracticePantherPolicyDecision {
  const policy = practicePantherToolPolicy(input.toolName);

  if (
    input.internalPurpose === "practicepanther_actor_audit" &&
    INTERNAL_ACTOR_AUDIT_TOOLS.has(input.toolName)
  ) {
    return {
      effect: "allow",
      reason: "internal_actor_audit",
      policy,
      policyVersion: PRACTICEPANTHER_POLICY_VERSION,
    };
  }

  if (policy === "admin_only") {
    return {
      effect: input.role === "admin" ? "allow" : "deny",
      reason: "admin_only",
      policy,
      policyVersion: PRACTICEPANTHER_POLICY_VERSION,
    };
  }

  if (policy === "read_all") {
    return {
      effect: "allow",
      reason: "read_allowed",
      policy,
      policyVersion: PRACTICEPANTHER_POLICY_VERSION,
    };
  }

  if (policy === "write_with_approval") {
    return {
      effect: input.approvalGranted ? "allow" : "approval_required",
      reason: input.approvalGranted
        ? "approved_once"
        : "user_approval_required",
      policy,
      policyVersion: PRACTICEPANTHER_POLICY_VERSION,
    };
  }

  return {
    effect: "deny",
    reason: "unknown_tool",
    policy,
    policyVersion: PRACTICEPANTHER_POLICY_VERSION,
  };
}
