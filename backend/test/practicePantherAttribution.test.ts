import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPracticePantherAuditNote,
  classifyMcpAction,
  docketActorTag,
  extractPracticePantherNoteId,
  extractPracticePantherTargetRefs,
  normalizeDocketActorEmail,
  tagPracticePantherMutationArgs,
} from "../src/lib/mcp/practicePantherAttribution";

test("classifies raw requests and unknown tools fail safe as mutations", () => {
  assert.equal(classifyMcpAction("pp_api_request", { method: "GET" }), "read");
  assert.equal(
    classifyMcpAction("pp_api_request", { method: "post" }),
    "mutation",
  );
  assert.equal(classifyMcpAction("Matters_GetMatters", {}), "read");
  assert.equal(classifyMcpAction("Files_UploadFile", {}), "mutation");
  assert.equal(classifyMcpAction("opaque_tool", {}), "mutation");
  assert.equal(
    classifyMcpAction("opaque_tool", {}, { readOnlyHint: true }),
    "read",
  );
});

test("normalizes the authenticated actor email", () => {
  assert.equal(
    normalizeDocketActorEmail("  Mike.User@PodlaskiLegal.com "),
    "mike.user@podlaskilegal.com",
  );
  assert.equal(normalizeDocketActorEmail("not-an-email"), null);
  assert.equal(normalizeDocketActorEmail("bad\nactor@example.com"), null);
  assert.equal(normalizeDocketActorEmail(null), null);
});

test("adds an actor tag without overwriting existing PracticePanther tags", () => {
  const actorEmail = "mike.user@podlaskilegal.com";
  const tag = docketActorTag(actorEmail);
  const schema = {
    type: "object",
    properties: { tags: { type: "array", items: { type: "string" } } },
  };

  assert.deepEqual(
    tagPracticePantherMutationArgs(
      "Tasks_PostAccount",
      { subject: "Call client" },
      schema,
      actorEmail,
    ),
    { subject: "Call client", tags: [tag] },
  );
  assert.deepEqual(
    tagPracticePantherMutationArgs(
      "Tasks_PutAccount",
      { id: "task-1", tags: ["Urgent"] },
      schema,
      actorEmail,
    ),
    { id: "task-1", tags: ["Urgent", tag] },
  );
  assert.deepEqual(
    tagPracticePantherMutationArgs(
      "Tasks_PutAccount",
      { id: "task-1" },
      schema,
      actorEmail,
    ),
    { id: "task-1" },
  );
  assert.deepEqual(
    tagPracticePantherMutationArgs(
      "pp_api_request",
      {
        method: "PATCH",
        path: "/api/v2/tasks/task-1",
        body: { tags: ["Urgent"] },
      },
      null,
      actorEmail,
    ),
    {
      method: "PATCH",
      path: "/api/v2/tasks/task-1",
      body: { tags: ["Urgent", tag] },
    },
  );
});

test("extracts PracticePanther target references from args, paths, and results", () => {
  assert.deepEqual(
    extractPracticePantherTargetRefs(
      "Tasks_PostAccount",
      { matter_ref: { id: "matter-1" } },
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: "task-1",
              account_ref: { id: "account-1" },
            }),
          },
        ],
      },
    ),
    {
      resourceType: "Tasks",
      resourceId: "task-1",
      matterId: "matter-1",
      accountId: "account-1",
    },
  );

  assert.deepEqual(
    extractPracticePantherTargetRefs("pp_api_request", {
      method: "DELETE",
      path: "/api/v2/matters/3f2b6a91-2150-4e22-a911-015d22f0ab11",
    }),
    {
      resourceType: "matters",
      matterId: "3f2b6a91-2150-4e22-a911-015d22f0ab11",
    },
  );
});

test("builds a visible PracticePanther audit note with Docket correlation", () => {
  const note = buildPracticePantherAuditNote({
    actionId: "audit-1",
    actorEmail: "mike.user@podlaskilegal.com",
    toolName: "Tasks_PostAccount",
    phase: "attempting",
    timestamp: "2026-07-22T12:00:00.000Z",
    refs: { matterId: "matter-1", accountId: "account-1" },
    attachToTarget: true,
    context: {
      assistantRunId: "run-1",
      toolCallId: "call-1",
    },
  });

  assert.equal(note.subject, "[Docket] ATTEMPTING: Tasks_PostAccount");
  assert.deepEqual(note.matter_ref, { id: "matter-1" });
  assert.deepEqual(note.account_ref, { id: "account-1" });
  assert.deepEqual(note.tags, [
    "Docket",
    "Docket Assistant",
    "Docket actor: mike.user@podlaskilegal.com",
  ]);
  assert.match(String(note.note), /Actor email: mike\.user@podlaskilegal\.com/);
  assert.match(String(note.note), /Docket assistant run ID: run-1/);
  assert.match(String(note.note), /shared API identity/);

  const detached = buildPracticePantherAuditNote({
    actionId: "audit-2",
    actorEmail: "mike.user@podlaskilegal.com",
    toolName: "Matters_DeleteMatter",
    phase: "attempting",
    timestamp: "2026-07-22T12:00:00.000Z",
    refs: { matterId: "matter-1", accountId: "account-1" },
    attachToTarget: false,
  });
  assert.equal("matter_ref" in detached, false);
  assert.equal("account_ref" in detached, false);
  assert.match(String(detached.note), /Matter ID: matter-1/);
});

test("extracts a PracticePanther audit note ID from MCP result shapes", () => {
  assert.equal(
    extractPracticePantherNoteId({ structuredContent: { id: "note-1" } }),
    "note-1",
  );
  assert.equal(
    extractPracticePantherNoteId({
      content: [
        {
          type: "text",
          text: JSON.stringify({ result: { id: "note-2" } }),
        },
      ],
    }),
    "note-2",
  );
  assert.equal(
    extractPracticePantherNoteId({
      structuredContent: { data: { value: { id: "note-3" } } },
    }),
    "note-3",
  );
});
