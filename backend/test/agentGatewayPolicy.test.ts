import {
  BOX_URL,
  PER_USER_PP_URL,
  QUO_URL,
  setGatewayEnv,
} from "./helpers/agentGatewayFakes";
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_BOX_EXTRA_READS,
  AGENT_BOX_ORGANIZE_TOOLS,
  AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS,
  AGENT_PRACTICEPANTHER_EXTRA_READ_TOOLS,
  AGENT_PRACTICEPANTHER_SEND_TOOLS,
  AGENT_PRACTICEPANTHER_WRITE_TOOLS,
  AGENT_QUO_WRITE_TOOLS,
  authorizeAgentTool,
  boxOrganizeArgumentsAllowed,
  boxOrganizeTargetRefs,
  isQuoSendToolName,
  type AgentToolDecision,
} from "../src/lib/agentGateway/policy";
import type { AgentSource } from "../src/lib/agentGateway/config";
import { boxToolRequiresApproval } from "../src/lib/mcp/boxAccessPolicy";
import { toolRequiresConfirmation } from "../src/lib/mcp/client";
import {
  ADMIN_ONLY_PRACTICEPANTHER_TOOLS,
  READ_ALL_PRACTICEPANTHER_TOOLS,
  WRITE_WITH_APPROVAL_PRACTICEPANTHER_TOOLS,
} from "../src/lib/mcp/practicePantherAccessPolicy";
import type { ConnectorRow, ToolCacheRow } from "../src/lib/mcp/types";
import type { AppUserRole } from "../src/lib/userRoles";

setGatewayEnv();

function connector(source: AgentSource): ConnectorRow {
  return {
    id: `connector-${source}`,
    user_id: "user-1",
    name: source,
    transport: "streamable_http",
    server_url:
      source === "box" ? BOX_URL : source === "quo" ? QUO_URL : PER_USER_PP_URL,
    auth_type: "oauth",
    // PracticePanther and Box: the rows Docket itself keeps and chat uses.
    // Quo: the gateway's own row, switched off for chat.
    enabled: source !== "quo",
    tool_policy:
      source === "quo"
        ? { docketAgentSource: source }
        : { managedBy: "backend", managedConnector: source },
    encrypted_auth_config: null,
    auth_config_iv: null,
    auth_config_tag: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

function cached(
  source: AgentSource,
  toolName: string,
  overrides: Partial<ToolCacheRow> = {},
): ToolCacheRow {
  return {
    id: `tool-${toolName}`,
    connector_id: `connector-${source}`,
    tool_name: toolName,
    openai_tool_name: `mcp_${toolName}`,
    title: null,
    description: null,
    input_schema: { type: "object", properties: {} },
    output_schema: null,
    annotations: {},
    // The cached flags must not matter for PracticePanther. Policy decides.
    enabled: source !== "practicepanther",
    requires_confirmation: false,
    last_seen_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function decide(
  source: AgentSource,
  toolName: string,
  options: {
    role?: AppUserRole;
    writes?: boolean;
    organize?: boolean;
    listing?: boolean;
    known?: boolean;
    tool?: Partial<ToolCacheRow>;
    args?: Record<string, unknown>;
  } = {},
): AgentToolDecision {
  return authorizeAgentTool({
    source,
    role: options.role ?? "user",
    connector: connector(source),
    tool: options.known === false ? null : cached(source, toolName, options.tool),
    toolName,
    args: options.args ?? {},
    practicePantherWritesEnabled: options.writes ?? false,
    ...(options.organize === undefined ? {} : { boxOrganizeEnabled: options.organize }),
    ...(options.listing === undefined ? {} : { forListing: options.listing }),
  });
}

// The firm's PracticePanther user list: admin-only in Docket chat, a read
// for an agent token of any role.
const STAFF_READS = ["Users_GetUsers", "Users_GetUser", "Users_Me"];

// Valid arguments for each Box organize tool.
const ORGANIZE_CALLS: Record<string, Record<string, unknown>> = {
  create_folder: { name: "Pleadings", parent_folder_id: "5001" },
  move_file: { file_id: "7001", parent_folder_id: "5001" },
  move_folder: { folder_id: "5002", parent_folder_id: "5001" },
  update_file_properties: { file_id: "7001", name: "2026-09-30 Complaint.docx" },
  update_folder_properties: { folder_id: "5002", name: "Discovery" },
  copy_file: { file_id: "7001", parent_folder_id: "5001" },
  copy_folder: { folder_id: "5002", parent_folder_id: "5001", name: "Discovery (copy)" },
  set_file_metadata: {
    file_id: "7001",
    scope: "enterprise",
    template_key: "matterRecord",
    metadata_fields: { matterNumber: "2026-0042", pages: 12, parties: ["A", "B"] },
  },
  set_folder_metadata: {
    folder_id: "5002",
    scope: "global",
    template_key: "properties",
    metadata_fields: { status: "closed" },
  },
};

function reasonOf(decision: AgentToolDecision): string {
  return decision.effect === "deny" ? decision.reason : `allow:${decision.kind}`;
}

test("a non-admin is denied every tool Docket marks admin-only, except the firm's user list", () => {
  const allowed: string[] = [];
  for (const toolName of ADMIN_ONLY_PRACTICEPANTHER_TOOLS) {
    for (const writes of [false, true]) {
      const decision = decide("practicepanther", toolName, { writes });
      if (STAFF_READS.includes(toolName)) {
        assert.deepEqual(decision, { effect: "allow", kind: "read" }, toolName);
        if (!writes) allowed.push(toolName);
      } else {
        assert.equal(decision.effect, "deny", toolName);
      }
    }
  }
  // Exactly three names left the admin-only group. Nothing else did.
  assert.deepEqual(allowed.sort(), [...STAFF_READS].sort());
});

test("the firm's PracticePanther user list is a read for any role; a user can never be deleted", () => {
  for (const toolName of STAFF_READS) {
    assert.ok((ADMIN_ONLY_PRACTICEPANTHER_TOOLS as readonly string[]).includes(toolName));
    for (const role of ["user", "admin"] as const) {
      for (const writes of [false, true]) {
        assert.deepEqual(
          decide("practicepanther", toolName, { role, writes }),
          { effect: "allow", kind: "read" },
          `${toolName} as ${role}`,
        );
      }
      // Still only a tool the connector's cache knows.
      assert.equal(
        reasonOf(decide("practicepanther", toolName, { role, known: false })),
        "unknown_tool",
      );
    }
  }
  for (const role of ["user", "admin"] as const) {
    for (const toolName of ["Users_Delete", "Users_Delete_2"]) {
      assert.equal(
        reasonOf(decide("practicepanther", toolName, { role, writes: true })),
        "delete_denied",
      );
    }
    // There is no tool that changes a user. A made-up one is refused.
    for (const toolName of ["Users_PostUser", "Users_PutUser"]) {
      assert.equal(
        reasonOf(decide("practicepanther", toolName, { role, writes: true })),
        "unknown_tool",
      );
    }
  }
  // The money records stay admin-only reads.
  for (const toolName of [
    "BankAccounts_GetBankAccounts",
    "Invoices_GetInvoice",
    "Payments_GetPayments",
    "Expenses_GetExpensess",
    "ExpenseCategories_GetExpenseCategories",
    "FlatFees_GetFlatFees",
    "Items_GetItems",
  ]) {
    assert.equal(reasonOf(decide("practicepanther", toolName)), "admin_only", toolName);
  }
});

test("every delete tool is denied for both roles, with or without a numeric suffix", () => {
  const deleteTools = [
    "Tasks_Delete",
    "Tasks_Delete_2",
    "Notes_Delete",
    "Notes_Delete_2",
    "TimeEntries_Delete",
    "Accounts_Delete",
    "Matters_Delete_2",
    "Users_Delete",
    "BankAccounts_Delete",
  ];
  for (const toolName of deleteTools) {
    for (const role of ["user", "admin"] as const) {
      assert.equal(
        reasonOf(decide("practicepanther", toolName, { role, writes: true })),
        "delete_denied",
        `${toolName} as ${role}`,
      );
    }
  }
  // Box and Quo deletes are refused by the same rule.
  assert.equal(reasonOf(decide("box", "delete_file")), "delete_denied");
  assert.equal(reasonOf(decide("quo", "remove_contact")), "delete_denied");
});

test("the raw PracticePanther API tool is denied for both roles", () => {
  for (const role of ["user", "admin"] as const) {
    for (const args of [{}, { method: "GET" }, { method: "DELETE" }]) {
      assert.equal(
        reasonOf(decide("practicepanther", "pp_api_request", { role, writes: true, args })),
        "raw_api_denied",
      );
    }
  }
});

test("every Docket read tool and the extra read tool is allowed as a read", () => {
  for (const toolName of [
    ...READ_ALL_PRACTICEPANTHER_TOOLS,
    ...AGENT_PRACTICEPANTHER_EXTRA_READ_TOOLS,
  ]) {
    for (const role of ["user", "admin"] as const) {
      assert.deepEqual(
        decide("practicepanther", toolName, { role }),
        { effect: "allow", kind: "read" },
        `${toolName} as ${role}`,
      );
    }
  }
  assert.ok(AGENT_PRACTICEPANTHER_EXTRA_READ_TOOLS.includes("Messages_GetMessageAsync"));
});

test("the write tools are denied while writes are off and allowed when on", () => {
  for (const toolName of AGENT_PRACTICEPANTHER_WRITE_TOOLS) {
    for (const name of [toolName, `${toolName}_2`]) {
      assert.equal(
        reasonOf(decide("practicepanther", name, { writes: false })),
        "writes_off",
        name,
      );
      assert.deepEqual(
        decide("practicepanther", name, { writes: true }),
        { effect: "allow", kind: "write" },
        name,
      );
    }
  }
});

test("the record types the partner assistant changes can be written with writes on, and only then", () => {
  // The create and update tools added on 2026-10-02, by the per-user
  // connector's own names: matters, logged emails, accounts, relationships.
  const added = [
    "Matters_PostMatter",
    "Matters_PutMatter",
    "Emails_PostEmail",
    "Emails_PutAccount",
    "Accounts_PostAccount",
    "Accounts_PutAccount",
    "Relationships_PostAccount",
    "Relationships_PutRelationship",
  ];
  for (const toolName of added) {
    assert.ok((AGENT_PRACTICEPANTHER_WRITE_TOOLS as readonly string[]).includes(toolName), toolName);
    for (const name of [toolName, `${toolName}_2`]) {
      for (const role of ["user", "admin"] as const) {
        assert.equal(
          reasonOf(decide("practicepanther", name, { role, writes: false })),
          "writes_off",
          `${name} as ${role}`,
        );
        assert.deepEqual(
          decide("practicepanther", name, { role, writes: true }),
          { effect: "allow", kind: "write" },
          `${name} as ${role}`,
        );
        assert.equal(
          reasonOf(decide("practicepanther", name, { role, writes: true, known: false })),
          "unknown_tool",
          `${name} as ${role}`,
        );
      }
    }
  }
});

test("every other PracticePanther write is denied even with writes on", () => {
  // [reason for a non-admin, reason for an admin]
  const expected: Record<string, [string, string]> = {
    // PracticePanther messages go to a contact (a text, or a client-portal
    // message). Docket Agent sends nothing to anyone but the requesting
    // user (K3).
    Messages_PostMessage: ["send_denied", "send_denied"],
    Messages_PutMessage: ["send_denied", "send_denied"],
    Messages_PutMessage_2: ["send_denied", "send_denied"],
    // Names in Docket's policy file that the connector does not have.
    Matters_PutAccount: ["write_not_allowed_for_agent", "write_not_allowed_for_agent"],
    Matters_PostAccount: ["write_not_allowed_for_agent", "write_not_allowed_for_agent"],
    Tasks_PostAccount: ["write_not_allowed_for_agent", "write_not_allowed_for_agent"],
    // The money records Docket keeps admin-only: refused for a non-admin.
    // (For an admin they are writes: the admin test below.)
    BankAccounts_PostBankAccount: ["admin_only", "allow:write"],
    BankAccounts_PutBankAccount: ["admin_only", "allow:write"],
    BankAccounts_PutBankAccount_2: ["admin_only", "allow:write"],
    ExpenseCategories_PostExpenseCategory: ["admin_only", "allow:write"],
    ExpenseCategories_PutExpenseCategory: ["admin_only", "allow:write"],
    Expenses_PostAccount: ["admin_only", "allow:write"],
    Expenses_PutAccount: ["admin_only", "allow:write"],
    FlatFees_PostAccount: ["admin_only", "allow:write"],
    FlatFees_PutAccount: ["admin_only", "allow:write"],
    Items_PostItem: ["admin_only", "allow:write"],
    Items_PutItem: ["admin_only", "allow:write"],
    // No such tool exists: invoices and payments cannot be written at all.
    Invoices_PostInvoice: ["unknown_tool", "unknown_tool"],
    Payments_PostPayment: ["unknown_tool", "unknown_tool"],
    // Contacts and tags have no write tool either.
    Contacts_PostContact: ["unknown_tool", "unknown_tool"],
  };
  for (const [toolName, [asUser, asAdmin]] of Object.entries(expected)) {
    assert.equal(
      reasonOf(decide("practicepanther", toolName, { role: "user", writes: true })),
      asUser,
      `${toolName} as user`,
    );
    assert.equal(
      reasonOf(decide("practicepanther", toolName, { role: "admin", writes: true })),
      asAdmin,
      `${toolName} as admin`,
    );
  }
});

test("PracticePanther files can be written with writes on, by any role, and only then", () => {
  // Files_PostFile and Files_PostFileToBox take no arguments in the
  // connector's API definition; PracticePanther decides what they do.
  // Files_PutFile changes a file's record (its name, description, links).
  // None of them sends anything to anyone.
  const files = ["Files_PostFile", "Files_PostFileToBox", "Files_PutFile", "Files_PutFile_2"];
  for (const name of files) {
    for (const role of ["user", "admin"] as const) {
      assert.equal(
        reasonOf(decide("practicepanther", name, { role, writes: false })),
        "writes_off",
        `${name} as ${role}`,
      );
      assert.deepEqual(
        decide("practicepanther", name, { role, writes: true }),
        { effect: "allow", kind: "write" },
        `${name} as ${role}`,
      );
      assert.deepEqual(
        decide("practicepanther", name, { role, writes: true, listing: true }),
        { effect: "allow", kind: "write" },
        `${name} as ${role}`,
      );
      assert.equal(
        reasonOf(decide("practicepanther", name, { role, writes: true, known: false })),
        "unknown_tool",
        `${name} as ${role}`,
      );
    }
  }
  // Reading files was always allowed; deleting one never is.
  for (const name of ["Files_GetFile", "Files_GetFiles", "Files_DownloadFile"]) {
    assert.deepEqual(decide("practicepanther", name), { effect: "allow", kind: "read" }, name);
  }
  for (const name of ["Files_Delete", "Files_Delete_2"]) {
    assert.equal(
      reasonOf(decide("practicepanther", name, { role: "admin", writes: true })),
      "delete_denied",
      name,
    );
  }
});

test("a PracticePanther message is never written, for any role, whatever the switch (K3); messages can be read", () => {
  assert.deepEqual([...AGENT_PRACTICEPANTHER_SEND_TOOLS], ["Messages_PostMessage", "Messages_PutMessage"]);
  for (const name of ["Messages_PostMessage", "Messages_PutMessage", "Messages_PutMessage_2"]) {
    for (const role of ["user", "admin"] as const) {
      for (const writes of [false, true]) {
        for (const listing of [false, true]) {
          assert.equal(
            reasonOf(decide("practicepanther", name, { role, writes, listing, organize: true })),
            "send_denied",
            `${name} as ${role}, writes ${writes}, listing ${listing}`,
          );
        }
      }
      // Refused by name, before the cache is looked at.
      assert.equal(
        reasonOf(decide("practicepanther", name, { role, writes: true, known: false })),
        "send_denied",
      );
    }
  }
  // Never on any write list. Reading the conversation stays allowed.
  for (const name of AGENT_PRACTICEPANTHER_SEND_TOOLS) {
    assert.ok(!(AGENT_PRACTICEPANTHER_WRITE_TOOLS as readonly string[]).includes(name), name);
    assert.ok(!(AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS as readonly string[]).includes(name), name);
  }
  for (const name of ["Messages_GetMessagesAsync", "Messages_GetMessageAsync"]) {
    for (const role of ["user", "admin"] as const) {
      assert.deepEqual(decide("practicepanther", name, { role }), { effect: "allow", kind: "read" }, name);
    }
  }
  assert.equal(
    reasonOf(decide("practicepanther", "Messages_Delete", { role: "admin", writes: true })),
    "delete_denied",
  );
});

test("an unknown name, and a known name with no cache row, are denied", () => {
  assert.equal(
    reasonOf(decide("practicepanther", "Made_Up_Tool", { writes: true })),
    "unknown_tool",
  );
  assert.equal(
    reasonOf(decide("practicepanther", "Tasks_GetTasks", { known: false })),
    "unknown_tool",
  );
  assert.equal(
    reasonOf(decide("practicepanther", "Tasks_PostTask", { known: false, writes: true })),
    "unknown_tool",
  );
  assert.equal(reasonOf(decide("box", "search_files_keyword", { known: false })), "unknown_tool");
  assert.equal(reasonOf(decide("quo", "list_calls", { known: false })), "unknown_tool");

  // A cache row that belongs to another connector does not count.
  assert.equal(
    reasonOf(
      decide("practicepanther", "Tasks_GetTasks", {
        tool: { connector_id: "someone-elses-connector" },
      }),
    ),
    "unknown_tool",
  );
});

test("an admin may read admin-only data, and write it while writes are on; a non-admin may do neither", () => {
  for (const toolName of ["Invoices_GetInvoices", "BankAccounts_GetBankAccount", "Payments_GetPayment"]) {
    assert.deepEqual(
      decide("practicepanther", toolName, { role: "admin" }),
      { effect: "allow", kind: "read" },
      toolName,
    );
    assert.equal(reasonOf(decide("practicepanther", toolName, { role: "user" })), "admin_only");
  }
  for (const toolName of AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS) {
    const names = /_Put/.test(toolName) ? [toolName, `${toolName}_2`] : [toolName];
    for (const name of names) {
      // An admin, writes on: a write. Writes off: the switch says no.
      assert.deepEqual(
        decide("practicepanther", name, { role: "admin", writes: true }),
        { effect: "allow", kind: "write" },
        name,
      );
      assert.deepEqual(
        decide("practicepanther", name, { role: "admin", writes: true, listing: true }),
        { effect: "allow", kind: "write" },
        name,
      );
      assert.equal(
        reasonOf(decide("practicepanther", name, { role: "admin", writes: false })),
        "writes_off",
        name,
      );
      // A non-admin: refused with writes on or off, in a call or a list.
      for (const writes of [false, true]) {
        for (const listing of [false, true]) {
          assert.equal(
            reasonOf(decide("practicepanther", name, { role: "user", writes, listing })),
            "admin_only",
            `${name} as user`,
          );
        }
      }
      // Still only a tool the connector's cache knows.
      assert.equal(
        reasonOf(decide("practicepanther", name, { role: "admin", writes: true, known: false })),
        "unknown_tool",
        name,
      );
    }
  }
  // The Box organize switch opens none of them.
  assert.equal(
    reasonOf(decide("practicepanther", "Items_PostItem", { role: "admin", organize: true })),
    "writes_off",
  );
});

test("an admin with writes on: every admin-only tool is a read, a write, or refused as a delete or the raw tool", () => {
  // Walks Docket's whole admin-only group. Nothing is left over: a tool
  // Docket adds to the group later is refused until it is placed.
  const seen: Record<string, string[]> = {};
  for (const toolName of ADMIN_ONLY_PRACTICEPANTHER_TOOLS) {
    const reason = reasonOf(decide("practicepanther", toolName, { role: "admin", writes: true }));
    (seen[reason] ??= []).push(toolName);
  }
  assert.deepEqual(Object.keys(seen).sort(), [
    "allow:read",
    "allow:write",
    "delete_denied",
    "raw_api_denied",
  ]);
  assert.deepEqual(seen["allow:write"].sort(), [...AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS].sort());
  for (const name of seen["allow:read"]) assert.match(name, /_Get|^Users_Me$/, name);
  for (const name of seen["delete_denied"]) assert.match(name, /_Delete$/, name);
  assert.deepEqual(seen["raw_api_denied"], ["pp_api_request"]);
  // A made-up admin-only change is not opened by being in the group.
  assert.equal(
    reasonOf(decide("practicepanther", "Invoices_PostInvoice", { role: "admin", writes: true })),
    "unknown_tool",
  );
});

test("the admin write list is exactly Docket's admin-only creates and updates", () => {
  // Docket's own rule gives the admin-only group to an admin. The gateway
  // takes from it every create and update; deletes and the raw tool stay
  // off (K2). If Docket's file changes, this test says so.
  const docketAdminChanges = (ADMIN_ONLY_PRACTICEPANTHER_TOOLS as readonly string[]).filter(
    (name) => /_(Post|Put)/.test(name),
  );
  assert.deepEqual([...AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS].sort(), [...docketAdminChanges].sort());
  for (const name of AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS) {
    assert.doesNotMatch(name, /delete|remove|_\d+$/i, name);
    assert.ok(!(AGENT_PRACTICEPANTHER_WRITE_TOOLS as readonly string[]).includes(name), name);
  }
  assert.equal(new Set(AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS).size, 10);
});

test("with the organize switch off, Box is read-only: documented reads only, and only tools switched on in Docket", () => {
  assert.deepEqual(decide("box", "search_files_keyword"), {
    effect: "allow",
    kind: "read",
  });
  assert.deepEqual(decide("box", "get_file_content", { args: { file_id: "123" } }), {
    effect: "allow",
    kind: "read",
  });
  // A write, an undocumented tool, and a read flagged as a change.
  assert.equal(reasonOf(decide("box", "upload_file")), "needs_approval_in_docket");
  assert.equal(reasonOf(decide("box", "brand_new_box_tool")), "needs_approval_in_docket");
  assert.equal(
    reasonOf(decide("box", "get_file_details", { tool: { requires_confirmation: true } })),
    "needs_approval_in_docket",
  );
  // The user switched the tool off in Docket's connector settings.
  assert.equal(
    reasonOf(decide("box", "search_files_keyword", { tool: { enabled: false } })),
    "tool_disabled",
  );
});

// The names Quo's MCP server gives its tools, as the partner assistant's
// tool list names them.
const QUO_READS = ["list-inboxes", "fetch-messages", "fetch-missed-calls", "fetch-call-transcripts"];
const QUO_SENDS = ["send-message", "send-group-message", "send-bulk-messages"];

/** A Quo tool row as Docket's own tool refresh leaves it on the agent row. */
function quoRowAsDocketCachesIt(toolName: string): Partial<ToolCacheRow> {
  const requiresConfirmation = toolRequiresConfirmation({}, toolName);
  return { requires_confirmation: requiresConfirmation, enabled: !requiresConfirmation };
}

test("Quo: reads, and the user's own contacts and tasks created and updated, as writes", () => {
  for (const name of QUO_READS) {
    assert.deepEqual(decide("quo", name, { tool: quoRowAsDocketCachesIt(name) }), {
      effect: "allow",
      kind: "read",
    }, name);
  }
  assert.deepEqual(decide("quo", "list_calls"), { effect: "allow", kind: "read" });
  assert.deepEqual(decide("quo", "get_call_transcript"), { effect: "allow", kind: "read" });

  assert.deepEqual([...AGENT_QUO_WRITE_TOOLS], ["create-contact", "update-contact", "create-task", "update-task"]);
  for (const name of AGENT_QUO_WRITE_TOOLS) {
    // Docket's tool refresh marks each of the four as needing confirmation
    // and switches it off for chat; the user cannot switch it on. Those
    // flags are chat's and do not decide here.
    assert.equal(toolRequiresConfirmation({}, name), true, name);
    for (const tool of [
      quoRowAsDocketCachesIt(name),
      { enabled: false, requires_confirmation: true },
      { enabled: true, requires_confirmation: false },
    ]) {
      for (const role of ["user", "admin"] as const) {
        // No switch opens or closes them: neither the PracticePanther write
        // switch nor the Box organize switch is Quo's.
        for (const writes of [false, true]) {
          for (const organize of [false, true]) {
            assert.deepEqual(
              decide("quo", name, { role, writes, organize, tool }),
              { effect: "allow", kind: "write" },
              `${name} as ${role}`,
            );
          }
        }
        assert.deepEqual(
          decide("quo", name, { role, tool, listing: true }),
          { effect: "allow", kind: "write" },
          name,
        );
      }
    }
    // Still only a tool the connector's cache knows.
    assert.equal(reasonOf(decide("quo", name, { known: false })), "unknown_tool", name);
  }

  // Any other change stays refused: the underscore spellings are not
  // Quo's names, and a change nobody has looked at is not a read.
  assert.equal(reasonOf(decide("quo", "create_contact")), "not_a_read");
  assert.equal(reasonOf(decide("quo", "update-conversation")), "not_a_read");
  assert.equal(reasonOf(decide("quo", "archive-conversation")), "not_a_read");
  // A name the classifier does not recognise counts as a change.
  assert.equal(reasonOf(decide("quo", "mystery")), "not_a_read");
  // A read the user switched off in Docket, or one flagged as a change.
  assert.equal(
    reasonOf(decide("quo", "list_calls", { tool: { requires_confirmation: true } })),
    "needs_approval_in_docket",
  );
  assert.equal(
    reasonOf(decide("quo", "list_calls", { tool: { enabled: false } })),
    "tool_disabled",
  );
});

test("Quo: a message is never sent and nothing is deleted, for any role, whatever the cached flags say (K2, K3)", () => {
  const sends = [...QUO_SENDS, "send_message", "SEND-MESSAGE", "send-scheduled-message"];
  for (const name of sends) {
    assert.equal(isQuoSendToolName(name), true, name);
    for (const role of ["user", "admin"] as const) {
      for (const tool of [
        quoRowAsDocketCachesIt(name),
        { enabled: true, requires_confirmation: false, annotations: { readOnlyHint: true } },
      ]) {
        for (const listing of [false, true]) {
          assert.equal(
            reasonOf(decide("quo", name, { role, tool, listing, writes: true, organize: true })),
            "send_denied",
            `${name} as ${role}`,
          );
        }
      }
      assert.equal(reasonOf(decide("quo", name, { role, known: false })), "send_denied", name);
    }
    assert.ok(!(AGENT_QUO_WRITE_TOOLS as readonly string[]).includes(name), name);
  }
  for (const name of ["delete-contact", "delete-task", "remove-contact", "delete-message"]) {
    for (const role of ["user", "admin"] as const) {
      assert.equal(
        reasonOf(decide("quo", name, { role, tool: { enabled: true, requires_confirmation: false } })),
        "delete_denied",
        `${name} as ${role}`,
      );
    }
  }
  // Reading messages is not sending them.
  for (const name of ["fetch-messages", "list-messages", "list-inboxes"]) {
    assert.equal(isQuoSendToolName(name), false, name);
  }
  for (const name of AGENT_QUO_WRITE_TOOLS) assert.equal(isQuoSendToolName(name), false, name);
});

test("the exported lists are small, unique and limited to the ten record types", () => {
  const writes = [...AGENT_PRACTICEPANTHER_WRITE_TOOLS];
  const reads = [...AGENT_PRACTICEPANTHER_EXTRA_READ_TOOLS];
  assert.equal(new Set(writes).size, writes.length);
  assert.equal(new Set(reads).size, reads.length);
  // One create and one update tool for each of nine record types, and for
  // files two creates (a file, a file to Box) and an update.
  assert.equal(writes.length, 21);
  const families = new Map<string, string[]>();
  for (const toolName of writes) {
    assert.match(
      toolName,
      /^(Tasks|TimeEntries|Notes|Events|CallLogs|Matters|Emails|Accounts|Relationships|Files)_(Post|Put)[A-Za-z]+$/,
      toolName,
    );
    const [family, verb] = toolName.split("_");
    families.set(family, [...(families.get(family) ?? []), verb.slice(0, verb.startsWith("Post") ? 4 : 3)]);
  }
  assert.equal(families.size, 10);
  for (const [family, verbs] of families) {
    assert.deepEqual(
      verbs.sort(),
      family === "Files" ? ["Post", "Post", "Put"] : ["Post", "Put"],
      family,
    );
  }
  // Never a delete, never an admin-only name, never a message, never a
  // name with a numeric suffix (policy strips it).
  for (const toolName of writes) {
    assert.doesNotMatch(toolName, /delete|remove/i, toolName);
    assert.doesNotMatch(toolName, /^(Messages|Users|BankAccounts|Invoices|Payments|Expenses|ExpenseCategories|FlatFees|Items)_/, toolName);
    assert.doesNotMatch(toolName, /_\d+$/, toolName);
    assert.ok(!(ADMIN_ONLY_PRACTICEPANTHER_TOOLS as readonly string[]).includes(toolName), toolName);
  }
  // Every write Docket chat offers under a real connector name is on the
  // list too: the gateway is not narrower than chat there. Messages are the
  // one exception, on purpose (K3).
  const realChatWrites = (WRITE_WITH_APPROVAL_PRACTICEPANTHER_TOOLS as readonly string[]).filter(
    (name) =>
      /^(TimeEntries|Notes|Events|CallLogs|Emails|Accounts|Relationships|Files)_(Post|Put)/.test(name),
  );
  assert.equal(realChatWrites.length, 17);
  for (const name of realChatWrites) assert.ok(writes.includes(name as (typeof writes)[number]), name);
  const chatOnly = (WRITE_WITH_APPROVAL_PRACTICEPANTHER_TOOLS as readonly string[]).filter(
    (name) => /_(Post|Put)/.test(name) && !writes.includes(name as (typeof writes)[number]),
  );
  // Messages (K3), and four names the connector does not have.
  assert.deepEqual(chatOnly.sort(), [
    "Matters_PostAccount",
    "Matters_PutAccount",
    "Messages_PostMessage",
    "Messages_PutMessage",
    "Tasks_PostAccount",
    "Tasks_PutAccount",
  ]);

  assert.deepEqual(reads, ["Messages_GetMessageAsync", "Users_GetUsers", "Users_GetUser", "Users_Me"]);
  for (const toolName of reads) assert.match(toolName, /_Get|^Users_Me$/);
  // No overlap between any two of the PracticePanther lists.
  const lists: string[][] = [
    writes,
    reads,
    [...AGENT_PRACTICEPANTHER_ADMIN_WRITE_TOOLS],
    [...AGENT_PRACTICEPANTHER_SEND_TOOLS],
  ];
  const all = lists.flat();
  assert.equal(new Set(all).size, all.length);

  // Quo: four names, all changes to a contact or a task, never a send or a delete.
  const quo = [...AGENT_QUO_WRITE_TOOLS];
  assert.equal(new Set(quo).size, 4);
  for (const name of quo) {
    assert.match(name, /^(create|update)-(contact|task)$/, name);
  }

  const organize = [...AGENT_BOX_ORGANIZE_TOOLS];
  assert.deepEqual(organize, [
    "create_folder",
    "move_file",
    "move_folder",
    "update_file_properties",
    "update_folder_properties",
    "copy_file",
    "copy_folder",
    "set_file_metadata",
    "set_folder_metadata",
  ]);
  // Nothing on it deletes, comments, shares, invites, uploads or edits the
  // firm's metadata templates.
  for (const name of organize) {
    assert.doesNotMatch(name, /delete|remove|trash|comment|share|collab|invite|upload|template/i, name);
  }
  assert.deepEqual([...AGENT_BOX_EXTRA_READS], ["get_preview_page"]);
});

test("Box organize: off by default, and off means every organize tool is refused", () => {
  for (const [toolName, args] of Object.entries(ORGANIZE_CALLS)) {
    // No switch given, and the switch given as off.
    assert.equal(reasonOf(decide("box", toolName, { args })), "organize_off", toolName);
    assert.equal(
      reasonOf(decide("box", toolName, { args, organize: false })),
      "organize_off",
      toolName,
    );
    assert.equal(
      reasonOf(decide("box", toolName, { organize: false, listing: true })),
      "organize_off",
      toolName,
    );
  }
});

test("Box organize: on allows a new folder, a move, a copy, an item's properties and its metadata, as writes", () => {
  assert.deepEqual(Object.keys(ORGANIZE_CALLS).sort(), [...AGENT_BOX_ORGANIZE_TOOLS].sort());
  for (const [toolName, args] of Object.entries(ORGANIZE_CALLS)) {
    for (const role of ["user", "admin"] as const) {
      assert.deepEqual(
        decide("box", toolName, { role, args, organize: true }),
        { effect: "allow", kind: "write" },
        `${toolName} as ${role}`,
      );
    }
    // Box marks these as changes that need the user's approval in Docket
    // chat. That flag does not stop the gateway, and the gateway does not
    // change it.
    assert.deepEqual(
      decide("box", toolName, { args, organize: true, tool: { requires_confirmation: true } }),
      { effect: "allow", kind: "write" },
      toolName,
    );
    // A tool list has no arguments; the tool is listed.
    assert.deepEqual(
      decide("box", toolName, { organize: true, listing: true }),
      { effect: "allow", kind: "write" },
      toolName,
    );
    // The user switched the tool off in Docket's connector settings.
    assert.equal(
      reasonOf(decide("box", toolName, { args, organize: true, tool: { enabled: false } })),
      "tool_disabled",
      toolName,
    );
    // Not in the connector's tool cache.
    assert.equal(
      reasonOf(decide("box", toolName, { args, organize: true, known: false })),
      "unknown_tool",
      toolName,
    );
  }
  // A move may rename on the way. A folder may be made in the root.
  assert.equal(
    decide("box", "move_file", {
      organize: true,
      args: { file_id: "7001", parent_folder_id: "0", name: "Order.pdf" },
    }).effect,
    "allow",
  );
  assert.equal(
    decide("box", "create_folder", { organize: true, args: { name: "Correspondence" } }).effect,
    "allow",
  );
});

test("Box organize: the gateway does not judge where a move goes, the root included; Box's own permissions decide", () => {
  // In Box, who can see an item follows the folder it is in. A move to the
  // account's root ("0") takes a folder away from everyone who had it
  // through the tree it left; a move into a widely shared folder shows the
  // item to everyone there. christopher's rule of 2026-10-02: Docket Agent
  // may do what the user's own permissions allow, except K1-K5, and none of
  // those is about where a move goes. So the user's own Box permissions
  // decide, as for the partner assistant, and any destination passes the
  // gateway. This test holds that: a destination rule added later must be
  // added on purpose, with christopher's word.
  for (const parent of ["0", "5001", "d_9", "999999999999"]) {
    assert.deepEqual(
      decide("box", "move_folder", {
        organize: true,
        args: { folder_id: "5002", parent_folder_id: parent },
      }),
      { effect: "allow", kind: "write" },
      `move_folder to ${parent}`,
    );
    assert.deepEqual(
      decide("box", "move_file", {
        organize: true,
        args: { file_id: "7001", parent_folder_id: parent },
      }),
      { effect: "allow", kind: "write" },
      `move_file to ${parent}`,
    );
  }
  // What the gateway does refuse on a move: anything but the item, the
  // destination and a name. A share setting on a move stays off.
  for (const extra of [{ shared_link: "open" }, { collaborators: "all" }, { description: "x" }]) {
    assert.equal(
      reasonOf(
        decide("box", "move_folder", {
          organize: true,
          args: { folder_id: "5002", parent_folder_id: "5001", ...extra },
        }),
      ),
      "organize_arguments",
      JSON.stringify(extra),
    );
  }
  // And the sharing and collaboration tools themselves stay refused.
  for (const toolName of ["create_shared_link", "add_collaboration", "update_collaboration"]) {
    assert.equal(decide("box", toolName, { organize: true }).effect, "deny", toolName);
  }
});

test("Box organize: each tool carries only its own arguments, in their own shapes", () => {
  const refused: Array<[string, Record<string, unknown>]> = [
    // A properties call that changes nothing.
    ["update_file_properties", { file_id: "7001" }],
    ["update_folder_properties", { folder_id: "5002" }],
    // An option Box might add later: sharing, a lock, a collaborator (K3).
    ["update_file_properties", { file_id: "7001", name: "a.pdf", shared_link: { access: "open" } }],
    ["update_folder_properties", { folder_id: "5002", name: "A", shared_link: { access: "open" } }],
    ["update_file_properties", { file_id: "7001", lock: { type: "lock" } }],
    ["move_file", { file_id: "7001", parent_folder_id: "5001", shared_link: { access: "open" } }],
    ["move_folder", { folder_id: "5002", parent_folder_id: "5001", collaborators: ["x@example.com"] }],
    ["copy_file", { file_id: "7001", parent_folder_id: "5001", shared_link: { access: "open" } }],
    ["copy_folder", { folder_id: "5002", parent_folder_id: "5001", collaborators: ["x@example.com"] }],
    ["create_folder", { name: "A", parent_folder_id: "5001", shared_link: { access: "open" } }],
    ["set_file_metadata", { file_id: "7001", scope: "enterprise", template_key: "t", metadata_fields: { a: "b" }, notify: true }],
    // A move or a copy takes no description; a new folder takes no tags.
    ["move_folder", { folder_id: "5002", parent_folder_id: "5001", description: "x" }],
    ["copy_file", { file_id: "7001", parent_folder_id: "5001", tags: ["x"] }],
    ["create_folder", { name: "A", tags: ["x"] }],
    // A required argument is missing, empty, or not text.
    ["move_file", { file_id: "7001" }],
    ["move_file", { parent_folder_id: "5001" }],
    ["move_folder", { folder_id: "5002" }],
    ["move_file", { file_id: 7001, parent_folder_id: "5001" }],
    ["move_file", { file_id: "7001", parent_folder_id: "" }],
    ["create_folder", {}],
    ["create_folder", { name: "   " }],
    ["create_folder", { name: ["A"] }],
    // A copy names where it goes (Box would otherwise use the root).
    ["copy_file", { file_id: "7001" }],
    ["copy_folder", { folder_id: "5002", name: "B" }],
    // Tags, collections and descriptions in the wrong shape.
    ["update_file_properties", { file_id: "7001", tags: "x" }],
    ["update_file_properties", { file_id: "7001", tags: ["x", 3] }],
    ["update_file_properties", { file_id: "7001", tags: [""] }],
    ["update_file_properties", { file_id: "7001", collections: ["1"] }],
    ["update_file_properties", { file_id: "7001", collections: [{ id: "1", name: "x" }] }],
    ["update_file_properties", { file_id: "7001", collections: [{ id: 1 }] }],
    ["update_folder_properties", { folder_id: "5002", description: 7 }],
    ["update_folder_properties", { folder_id: "5002", name: "" }],
    // Metadata: the scope, the template key and the fields, each required.
    ["set_file_metadata", { file_id: "7001", scope: "enterprise", template_key: "t" }],
    ["set_file_metadata", { file_id: "7001", scope: "user", template_key: "t", metadata_fields: { a: "b" } }],
    ["set_file_metadata", { file_id: "7001", scope: "enterprise", template_key: "", metadata_fields: { a: "b" } }],
    ["set_file_metadata", { file_id: "7001", scope: "enterprise", template_key: "t", metadata_fields: {} }],
    ["set_file_metadata", { file_id: "7001", scope: "enterprise", template_key: "t", metadata_fields: ["a"] }],
    ["set_file_metadata", { file_id: "7001", scope: "enterprise", template_key: "t", metadata_fields: { a: { b: "c" } } }],
    ["set_file_metadata", { file_id: "7001", scope: "enterprise", template_key: "t", metadata_fields: { a: null } }],
    ["set_folder_metadata", { file_id: "7001", scope: "enterprise", template_key: "t", metadata_fields: { a: "b" } }],
    // The wrong id for the tool.
    ["update_file_properties", { folder_id: "5002", name: "A" }],
    ["move_folder", { file_id: "7001", parent_folder_id: "5001" }],
    ["copy_folder", { file_id: "7001", parent_folder_id: "5001" }],
    // A name that is not a real argument, on an object's prototype.
    ["move_file", { file_id: "7001", parent_folder_id: "5001", constructor: "x" }],
  ];
  for (const [toolName, args] of refused) {
    assert.equal(boxOrganizeArgumentsAllowed(toolName, args), false, `${toolName} ${JSON.stringify(args)}`);
    assert.equal(
      reasonOf(decide("box", toolName, { args, organize: true })),
      "organize_arguments",
      `${toolName} ${JSON.stringify(args)}`,
    );
  }
  for (const [toolName, args] of Object.entries(ORGANIZE_CALLS)) {
    assert.equal(boxOrganizeArgumentsAllowed(toolName, args), true, toolName);
  }
  // What the two properties tools may set besides a name (christopher's
  // rule, 2026-10-02: an item's description, tags and collections are the
  // user's to change). An empty description or tag list clears it.
  const allowed: Array<[string, Record<string, unknown>]> = [
    ["update_file_properties", { file_id: "7001", description: "Signed copy" }],
    ["update_file_properties", { file_id: "7001", description: "" }],
    ["update_file_properties", { file_id: "7001", name: "a.pdf", tags: ["pleading", "2026"] }],
    ["update_file_properties", { file_id: "7001", tags: [] }],
    ["update_file_properties", { file_id: "7001", collections: [{ id: "1" }] }],
    ["update_folder_properties", { folder_id: "5002", name: "A", description: "x", tags: ["x"], collections: [] }],
    ["copy_file", { file_id: "7001", parent_folder_id: "0", name: "Order (copy).pdf" }],
    ["set_folder_metadata", { folder_id: "5002", scope: "enterprise", template_key: "t", metadata_fields: { n: 1.5, s: "", l: [] } }],
  ];
  for (const [toolName, args] of allowed) {
    assert.equal(boxOrganizeArgumentsAllowed(toolName, args), true, `${toolName} ${JSON.stringify(args)}`);
    assert.deepEqual(
      decide("box", toolName, { args, organize: true }),
      { effect: "allow", kind: "write" },
      `${toolName} ${JSON.stringify(args)}`,
    );
  }
  // A tool that is not an organize tool has no allowed arguments at all.
  assert.equal(boxOrganizeArgumentsAllowed("upload_file", { name: "a" }), false);
  assert.equal(boxOrganizeArgumentsAllowed("constructor", {}), false);
});

test("Box organize: with the switch on, every other Box change is still refused", () => {
  const expected: Record<string, string> = {
    // Deleting: refused by name, whatever the switch says.
    delete_file: "delete_denied",
    delete_folder: "delete_denied",
    remove_collaboration: "delete_denied",
    delete_shared_link: "delete_denied",
    "remove-file": "delete_denied",
    // Sharing and collaboration.
    create_shared_link: "needs_approval_in_docket",
    update_shared_link: "needs_approval_in_docket",
    share_file: "needs_approval_in_docket",
    add_collaboration: "needs_approval_in_docket",
    create_collaboration: "needs_approval_in_docket",
    update_collaboration: "needs_approval_in_docket",
    invite_collaborator: "needs_approval_in_docket",
    // The other changes Box's MCP server offers today: a comment can
    // notify collaborators (K3); uploads as tool calls and template edits
    // are open for christopher (GATEWAY-DESIGN.md 15.11).
    upload_file: "needs_approval_in_docket",
    upload_file_version: "needs_approval_in_docket",
    create_file_comment: "needs_approval_in_docket",
    create_metadata_template: "needs_approval_in_docket",
    update_metadata_template: "needs_approval_in_docket",
    // A tool nobody has looked at yet.
    trash_file: "needs_approval_in_docket",
    restore_file: "needs_approval_in_docket",
    lock_file: "needs_approval_in_docket",
    brand_new_box_tool: "needs_approval_in_docket",
  };
  for (const [toolName, reason] of Object.entries(expected)) {
    for (const role of ["user", "admin"] as const) {
      for (const listing of [false, true]) {
        assert.equal(
          reasonOf(
            decide("box", toolName, {
              role,
              organize: true,
              listing,
              args: listing ? {} : { file_id: "7001", parent_folder_id: "5001", name: "x" },
            }),
          ),
          reason,
          `${toolName} as ${role}`,
        );
      }
    }
  }
  // Reads are what they were, with the switch on or off.
  for (const organize of [false, true]) {
    assert.deepEqual(decide("box", "search_files_keyword", { organize }), {
      effect: "allow",
      kind: "read",
    });
    assert.deepEqual(decide("box", "list_item_collaborations", { organize }), {
      effect: "allow",
      kind: "read",
    });
  }
});

test("Box: a page preview is a read for any role, with the organize switch on or off", () => {
  // Docket chat's own read list does not name it (it asks the user first),
  // and this file does not change that list. For an agent token it is a
  // read the user's own Box account allows.
  assert.ok(boxToolRequiresApproval({ tool_name: "get_preview_page", annotations: null, requires_confirmation: false }));
  for (const role of ["user", "admin"] as const) {
    for (const organize of [false, true]) {
      for (const listing of [false, true]) {
        assert.deepEqual(
          decide("box", "get_preview_page", { role, organize, listing, tool: { requires_confirmation: true } }),
          { effect: "allow", kind: "read" },
          `${role} organize=${organize} listing=${listing}`,
        );
      }
    }
  }
  // The user switched it off in Docket, or the cache does not know it.
  assert.equal(reasonOf(decide("box", "get_preview_page", { tool: { enabled: false } })), "tool_disabled");
  assert.equal(reasonOf(decide("box", "get_preview_page", { known: false })), "unknown_tool");
  // A hint that it changes something refuses it.
  for (const annotations of [{ readOnlyHint: false }, { destructiveHint: true }]) {
    assert.equal(
      reasonOf(decide("box", "get_preview_page", { tool: { annotations } })),
      "not_a_read",
      JSON.stringify(annotations),
    );
  }
  // Only Box: the name means nothing to PracticePanther or Quo here.
  assert.equal(decide("practicepanther", "get_preview_page").effect, "deny");
});

test("the Box organize switch opens nothing in PracticePanther or Quo", () => {
  assert.equal(
    reasonOf(decide("practicepanther", "Tasks_PostTask", { organize: true })),
    "writes_off",
  );
  assert.equal(
    reasonOf(decide("practicepanther", "Matters_PostMatter", { organize: true })),
    "writes_off",
  );
  for (const toolName of ["move_file", "create_folder", "create_contact"]) {
    assert.equal(decide("quo", toolName, { organize: true }).effect, "deny", toolName);
  }
  for (const toolName of ["move_file", "create_folder", "create_contact", "update-task"]) {
    assert.equal(
      decide("practicepanther", toolName, { organize: true, writes: true }).effect,
      "deny",
      toolName,
    );
  }
  // A Quo task or contact does not depend on it either way.
  for (const organize of [false, true]) {
    assert.deepEqual(decide("quo", "update-task", { organize }), { effect: "allow", kind: "write" });
  }
  // And the PracticePanther write switch opens nothing in Box.
  for (const [toolName, args] of Object.entries(ORGANIZE_CALLS)) {
    assert.equal(reasonOf(decide("box", toolName, { args, writes: true })), "organize_off", toolName);
  }
});

test("Docket chat still asks the user before every Box organize tool", () => {
  // The gateway's list does not touch Docket's own Box rule.
  for (const toolName of AGENT_BOX_ORGANIZE_TOOLS) {
    assert.equal(
      boxToolRequiresApproval(
        { tool_name: toolName, annotations: {}, requires_confirmation: false },
        ORGANIZE_CALLS[toolName],
      ),
      true,
      toolName,
    );
    assert.equal(
      boxToolRequiresApproval(
        { tool_name: toolName, annotations: { readOnlyHint: true }, requires_confirmation: false },
        ORGANIZE_CALLS[toolName],
      ),
      true,
      toolName,
    );
  }
});

test("the audit references of a Box organize call are ids only", () => {
  assert.deepEqual(
    boxOrganizeTargetRefs({ file_id: "7001", parent_folder_id: "d_5001", name: "Smith v. Jones.pdf" }),
    { file_id: "7001", parent_folder_id: "d_5001" },
  );
  assert.deepEqual(boxOrganizeTargetRefs({ folder_id: "5002", name: "Client Name" }), {
    folder_id: "5002",
  });
  // Anything that is not an id is left out, never copied.
  assert.deepEqual(
    boxOrganizeTargetRefs({ file_id: "Smith v. Jones", folder_id: 5002, parent_folder_id: "../x" }),
    {},
  );
});

test("the three change switches stay kill switches: off unless set to exactly on", async () => {
  // christopher's go-live turns Box organizing and Box filing on (runbook);
  // the code default stays off, so unsetting a value switches it off again.
  const { agentBoxOrganizeEnabled, agentPracticePantherWritesEnabled } = await import(
    "../src/lib/agentGateway/config"
  );
  const { agentBoxUploadsEnabled } = await import("../src/lib/agentGateway/boxFiles");
  const switches: Array<[string, () => boolean]> = [
    ["DOCKET_AGENT_PRACTICEPANTHER_WRITES", agentPracticePantherWritesEnabled],
    ["DOCKET_AGENT_BOX_ORGANIZE", agentBoxOrganizeEnabled],
    ["DOCKET_AGENT_BOX_UPLOADS", agentBoxUploadsEnabled],
  ];
  try {
    for (const [name, isOn] of switches) {
      setGatewayEnv();
      assert.equal(isOn(), false, `${name} unset`);
      for (const value of ["off", "", "true", "1", "yes", "enabled", "o n"]) {
        setGatewayEnv({ [name]: value });
        assert.equal(isOn(), false, `${name}=${value}`);
      }
      for (const value of ["on", "ON", " on "]) {
        setGatewayEnv({ [name]: value });
        assert.equal(isOn(), true, `${name}=${value}`);
      }
      // One switch never turns on another.
      setGatewayEnv({ [name]: "on" });
      for (const [other, otherOn] of switches) {
        if (other !== name) assert.equal(otherOn(), false, `${name} on, ${other}`);
      }
    }
  } finally {
    setGatewayEnv();
  }
});
