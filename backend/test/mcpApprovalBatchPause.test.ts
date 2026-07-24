import assert from "node:assert/strict";
import test from "node:test";
import type { Db, McpToolEvent } from "../src/lib/mcp/types";

process.env.DATABASE_URL ??=
  "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.PGSSLMODE = "disable";
process.env.NODE_ENV = "test";

test("a pending MCP approval stops later calls in the provider batch", async () => {
  const { runToolCalls } = await import("../src/lib/chatTools");
  const calls: string[] = [];
  const approvalEvent: McpToolEvent = {
    type: "mcp_tool_call",
    connector_id: "connector-1",
    connector_name: "PracticePanther MCP",
    tool_name: "Tasks_PostAccount",
    openai_tool_name: "mcp_pp_tasks_write",
    status: "approval_required",
    action_kind: "mutation",
    approval_id: "approval-1",
    approval_status: "pending",
  };

  const result = await runToolCalls(
    [
      {
        id: "call-1",
        function: {
          name: "mcp_pp_tasks_write",
          arguments: '{"subject":"Call client"}',
        },
      },
      {
        id: "call-2",
        function: {
          name: "mcp_pp_matters_read",
          arguments: "{}",
        },
      },
    ],
    new Map(),
    "user-1",
    {} as Db,
    () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      actorEmail: "user@example.com",
      chatId: "chat-1",
      assistantMessageId: "message-1",
      assistantRunId: "run-1",
    },
    undefined,
    async (_userId, openaiToolName) => {
      calls.push(openaiToolName);
      return {
        content: JSON.stringify({
          ok: false,
          approval_required: true,
        }),
        event: approvalEvent,
      };
    },
  );

  assert.deepEqual(calls, ["mcp_pp_tasks_write"]);
  assert.equal(result.mcpEvents.length, 1);
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.mcpEvents[0].status, "approval_required");
});
