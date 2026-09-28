import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_ONLY_PRACTICEPANTHER_TOOLS,
  PRACTICEPANTHER_POLICY_VERSION,
  READ_ALL_PRACTICEPANTHER_TOOLS,
  WRITE_WITH_APPROVAL_PRACTICEPANTHER_TOOLS,
  authorizePracticePantherTool,
  practicePantherToolPolicy,
} from "../src/lib/mcp/practicePantherAccessPolicy";

test("the reviewed PracticePanther policy covers 109 unique current and legacy tools", () => {
  assert.ok(PRACTICEPANTHER_POLICY_VERSION);
  assert.equal(ADMIN_ONLY_PRACTICEPANTHER_TOOLS.length, 36);
  assert.equal(READ_ALL_PRACTICEPANTHER_TOOLS.length, 35);
  assert.equal(WRITE_WITH_APPROVAL_PRACTICEPANTHER_TOOLS.length, 38);

  const all = [
    ...ADMIN_ONLY_PRACTICEPANTHER_TOOLS,
    ...READ_ALL_PRACTICEPANTHER_TOOLS,
    ...WRITE_WITH_APPROVAL_PRACTICEPANTHER_TOOLS,
  ];
  assert.equal(all.length, 109);
  assert.equal(new Set(all).size, 109);

  // Generated provider spellings are part of the reviewed external contract.
  assert.ok(all.includes("Expenses_GetExpensess"));
  assert.ok(all.includes("TimeEntries_GetTimeEntrys"));
  assert.ok(all.includes("BankAccounts_Delete"));
});

test("individual PracticePanther connector's new read operation is available to users", () => {
  assert.equal(
    authorizePracticePantherTool({
      role: "user",
      toolName: "Messages_GetMessageAsync",
    }).effect,
    "allow",
  );
});

test("individual PracticePanther connector's matter and task writes require approval", () => {
  for (const toolName of [
    "Matters_PostMatter",
    "Matters_PutMatter",
    "Tasks_PostTask",
    "Tasks_PutTask",
  ]) {
    assert.equal(
      authorizePracticePantherTool({ role: "user", toolName }).effect,
      "approval_required",
      toolName,
    );
    assert.equal(
      authorizePracticePantherTool({
        role: "user",
        toolName,
        approvalGranted: true,
      }).effect,
      "allow",
      toolName,
    );
  }
});

test("all nine selected capability groups are direct admin access and deny users", () => {
  for (const toolName of ADMIN_ONLY_PRACTICEPANTHER_TOOLS) {
    assert.equal(practicePantherToolPolicy(toolName), "admin_only");
    assert.equal(
      authorizePracticePantherTool({ role: "user", toolName }).effect,
      "deny",
      toolName,
    );
    assert.equal(
      authorizePracticePantherTool({ role: "admin", toolName }).effect,
      "allow",
      toolName,
    );
  }
});

test("all remaining reads are available to authenticated users and admins", () => {
  for (const toolName of READ_ALL_PRACTICEPANTHER_TOOLS) {
    assert.equal(practicePantherToolPolicy(toolName), "read_all");
    assert.equal(
      authorizePracticePantherTool({ role: "user", toolName }).effect,
      "allow",
      toolName,
    );
    assert.equal(
      authorizePracticePantherTool({ role: "admin", toolName }).effect,
      "allow",
      toolName,
    );
  }
});

test("all remaining writes require the initiating user's one-time approval", () => {
  for (const toolName of WRITE_WITH_APPROVAL_PRACTICEPANTHER_TOOLS) {
    for (const role of ["user", "admin"] as const) {
      assert.equal(
        authorizePracticePantherTool({ role, toolName }).effect,
        "approval_required",
        `${role}:${toolName}`,
      );
      assert.equal(
        authorizePracticePantherTool({
          role,
          toolName,
          approvalGranted: true,
        }).effect,
        "allow",
        `${role}:${toolName}`,
      );
    }
  }
});

test("unknown tools deny by default and raw API never inherits method-level read access", () => {
  for (const role of ["user", "admin"] as const) {
    assert.equal(
      authorizePracticePantherTool({
        role,
        toolName: "NewProviderTool_GetEverything",
      }).effect,
      "deny",
    );
  }

  assert.equal(
    authorizePracticePantherTool({
      role: "user",
      toolName: "pp_api_request",
      args: { method: "GET" },
    }).effect,
    "deny",
  );
  assert.equal(
    authorizePracticePantherTool({
      role: "admin",
      toolName: "pp_api_request",
      args: { method: "DELETE" },
    }).effect,
    "allow",
  );
});

test("only the internal attribution purpose bypasses approval for audit notes", () => {
  assert.equal(
    authorizePracticePantherTool({
      role: "user",
      toolName: "Notes_PostNote",
    }).effect,
    "approval_required",
  );
  assert.equal(
    authorizePracticePantherTool({
      role: "user",
      toolName: "Notes_PostNote",
      internalPurpose: "practicepanther_actor_audit",
    }).effect,
    "allow",
  );
  assert.equal(
    authorizePracticePantherTool({
      role: "user",
      toolName: "Notes_Delete",
      internalPurpose: "practicepanther_actor_audit",
    }).effect,
    "approval_required",
  );
});
