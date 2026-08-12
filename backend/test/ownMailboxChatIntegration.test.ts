import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

process.env.DATABASE_URL ??= "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

type AuditWrite = Record<string, unknown>;

type MailboxTurnState = {
  untrustedEmailObserved: boolean;
  allowedReadMessageIds: Set<string>;
};

function freshMailboxTurnState(): MailboxTurnState {
  return {
    untrustedEmailObserved: false,
    allowedReadMessageIds: new Set<string>(),
  };
}

function auditDb(failure?: "insert" | "update") {
  const sequence: string[] = [];
  const inserts: AuditWrite[] = [];
  const updates: AuditWrite[] = [];
  const chatUpdates: AuditWrite[] = [];
  const db = {
    from(table: string) {
      if (table === "chats") {
        return {
          update(row: AuditWrite) {
            sequence.push("chat-update");
            chatUpdates.push({ ...row });
            const filters: Array<[string, unknown]> = [];
            const query = {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return query;
              },
              is(column: string, value: unknown) {
                filters.push([column, value]);
                return query;
              },
              select(columns: string) {
                assert.equal(columns, "id");
                return {
                  async maybeSingle() {
                    return { data: { id: "chat-1" }, error: null };
                  },
                };
              },
            };
            return query;
          },
        };
      }
      assert.equal(table, "assistant_native_tool_audit_logs");
      return {
        insert(row: AuditWrite) {
          sequence.push("audit-insert");
          inserts.push({ ...row });
          return {
            select(columns: string) {
              assert.equal(columns, "id");
              return {
                async maybeSingle() {
                  return failure === "insert"
                    ? {
                        data: null,
                        error: { message: "audit insert unavailable" },
                      }
                    : { data: { id: "audit-1" }, error: null };
                },
              };
            },
          };
        },
        update(row: AuditWrite) {
          sequence.push("audit-update");
          updates.push({ ...row });
          return {
            async eq(column: string, value: unknown) {
              assert.equal(column, "id");
              assert.equal(value, "audit-1");
              return failure === "update"
                ? { error: { message: "audit update unavailable" } }
                : { error: null };
            },
          };
        },
      };
    },
  };
  return { db, inserts, updates, chatUpdates, sequence };
}

async function runMailboxTool(input: {
  db: unknown;
  toolName?: string;
  args: Record<string, unknown>;
  sequence: string[];
  projectId?: string | null;
  mailboxState?: MailboxTurnState;
  executor: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}) {
  const { runToolCalls } = await import("../src/lib/chatTools");
  const toolName = input.toolName ?? "search_own_email";
  const parameters: unknown[] = [
    [
      {
        id: "mail-call-1",
        function: { name: toolName, arguments: JSON.stringify(input.args) },
      },
    ],
    new Map(),
    "user-1",
    input.db,
    () => undefined,
  ];
  parameters[17] = async () => {
    throw new Error("MCP execution must not handle a native mailbox tool");
  };
  parameters[18] = {
    docketAccessToken: "DOCKET_TOKEN_SENTINEL",
    actorEmail: "user@example.com",
    chatId: "chat-1",
    assistantMessageId: "message-1",
    assistantRunId: "run-1",
    traceId: "trace-1",
    projectId: input.projectId ?? null,
  };
  parameters[19] = async (executorInput: Record<string, unknown>) => {
    input.sequence.push("mailbox-executor");
    return input.executor(executorInput);
  };
  parameters[20] = input.mailboxState;
  return (
    runToolCalls as unknown as (
      ...args: unknown[]
    ) => ReturnType<typeof runToolCalls>
  )(...parameters);
}

function toolPayload(result: Awaited<ReturnType<typeof runMailboxTool>>) {
  const row = result.toolResults[0] as { content?: unknown } | undefined;
  assert.equal(typeof row?.content, "string");
  return JSON.parse(row.content as string) as Record<string, unknown>;
}

test("mailbox execution fails closed when the pending audit row cannot be created", async () => {
  const state = auditDb("insert");
  let executions = 0;

  const result = await runMailboxTool({
    db: state.db,
    args: { query: "QUERY_SENTINEL" },
    sequence: state.sequence,
    executor: async () => {
      executions += 1;
      return { status: "ok", error: null, content: "{}", target: {} };
    },
  });

  assert.equal(executions, 0);
  assert.deepEqual(state.sequence, ["audit-insert"]);
  assert.match(String(toolPayload(result).error), /required audit record/i);
  assert.equal(state.updates.length, 0);
  assert.equal(state.chatUpdates.length, 0);
});

test("mailbox execution does not change chat visibility before Graph", async () => {
  const state = auditDb();
  let executions = 0;

  await runMailboxTool({
    db: state.db,
    args: { query: "QUERY_SENTINEL" },
    sequence: state.sequence,
    executor: async () => {
      executions += 1;
      return {
        status: "ok",
        error: null,
        content: "{}",
        structured_content: {
          kind: "email_search_results",
          messages: [],
        },
        target: {},
      };
    },
  });

  assert.equal(executions, 1);
  assert.deepEqual(state.sequence, [
    "audit-insert",
    "mailbox-executor",
    "audit-update",
  ]);
  assert.equal(state.chatUpdates.length, 0);
});

test("mailbox audit is finalized around execution without persisting query, body, or token", async () => {
  const state = auditDb();
  const resultContent = JSON.stringify({
    ok: true,
    messages: [{ subject: "Matter update", body: "BODY_SENTINEL" }],
  });

  const result = await runMailboxTool({
    db: state.db,
    args: { query: "QUERY_SENTINEL" },
    sequence: state.sequence,
    executor: async (executorInput) => {
      assert.equal(executorInput.docketAccessToken, "DOCKET_TOKEN_SENTINEL");
      assert.deepEqual(executorInput.args, { query: "QUERY_SENTINEL" });
      return {
        status: "ok",
        error: null,
        content: resultContent,
        target: { query: "QUERY_SENTINEL" },
      };
    },
  });

  assert.deepEqual(state.sequence, [
    "audit-insert",
    "mailbox-executor",
    "audit-update",
  ]);
  assert.equal(state.inserts.length, 1);
  assert.equal(state.updates.length, 1);
  assert.equal(state.inserts[0].status, "pending");
  assert.equal(state.updates[0].status, "ok");
  assert.equal(state.updates[0].result_size_chars, resultContent.length);
  assert.deepEqual(toolPayload(result), JSON.parse(resultContent));

  const durableAudit = JSON.stringify({
    insert: state.inserts[0],
    update: state.updates[0],
  });
  for (const secret of [
    "QUERY_SENTINEL",
    "BODY_SENTINEL",
    "DOCKET_TOKEN_SENTINEL",
  ]) {
    assert.doesNotMatch(durableAudit, new RegExp(secret));
  }
});

test("cancelled mailbox reads terminalize the audit before propagating cancellation", async () => {
  const state = auditDb();
  const abortError = new DOMException(
    "The operation was aborted",
    "AbortError",
  );

  await assert.rejects(
    runMailboxTool({
      db: state.db,
      args: { query: "QUERY_SENTINEL" },
      sequence: state.sequence,
      executor: async () => {
        throw abortError;
      },
    }),
    (error) => error === abortError,
  );

  assert.deepEqual(state.sequence, [
    "audit-insert",
    "mailbox-executor",
    "audit-update",
  ]);
  assert.equal(state.updates[0].status, "error");
  assert.equal(state.updates[0].error_code, "cancelled");
  assert.doesNotMatch(JSON.stringify(state.updates[0]), /QUERY_SENTINEL/);
});

test("normal tools remain available until a mailbox result succeeds", async () => {
  const state = auditDb();
  const mailboxState = freshMailboxTurnState();

  const beforeMail = await runMailboxTool({
    db: state.db,
    toolName: "ask_inputs",
    args: { items: [{ id: "next", kind: "choice" }] },
    sequence: state.sequence,
    mailboxState,
    executor: async () => {
      throw new Error("mailbox executor must not handle unrelated tools");
    },
  });
  assert.match(String(toolPayload(beforeMail).error), /available only/i);
  assert.doesNotMatch(
    String(toolPayload(beforeMail).error),
    /untrusted email/i,
  );

  const failedSearch = await runMailboxTool({
    db: state.db,
    args: { query: "matter" },
    sequence: state.sequence,
    mailboxState,
    executor: async () => ({
      status: "error",
      error: { code: "graph_request_failed" },
      content: "Own-mailbox read failed (graph_request_failed).",
      structured_content: null,
      target: {},
    }),
  });
  assert.match(
    String(
      (failedSearch.toolResults[0] as { content?: unknown } | undefined)
        ?.content,
    ),
    /graph_request_failed/,
  );
  assert.equal(mailboxState.untrustedEmailObserved, false);

  const afterFailedMail = await runMailboxTool({
    db: state.db,
    toolName: "ask_inputs",
    args: { items: [{ id: "next", kind: "choice" }] },
    sequence: state.sequence,
    mailboxState,
    executor: async () => {
      throw new Error("mailbox executor must not handle unrelated tools");
    },
  });
  assert.match(String(toolPayload(afterFailedMail).error), /available only/i);
  assert.doesNotMatch(
    String(toolPayload(afterFailedMail).error),
    /untrusted email/i,
  );
});

test("a successful search allows only distinct returned message IDs", async () => {
  const state = auditDb();
  const mailboxState = freshMailboxTurnState();
  const search = await runMailboxTool({
    db: state.db,
    args: { query: "matter" },
    sequence: state.sequence,
    mailboxState,
    executor: async () => ({
      status: "ok",
      error: null,
      content: JSON.stringify({ messages: [] }),
      structured_content: {
        kind: "email_search_results",
        messages: [
          { id: "message-1" },
          { id: "message-2" },
          { id: "message-2" },
        ],
      },
      target: {},
    }),
  });
  assert.deepEqual(toolPayload(search), { messages: [] });
  assert.equal(mailboxState.untrustedEmailObserved, true);
  assert.deepEqual(
    [...mailboxState.allowedReadMessageIds],
    ["message-1", "message-2"],
  );

  let blockedExecutions = 0;
  const blockedSearch = await runMailboxTool({
    db: state.db,
    args: { query: "another matter" },
    sequence: state.sequence,
    mailboxState,
    executor: async () => {
      blockedExecutions += 1;
      return { status: "ok", content: "{}", target: {} };
    },
  });
  assert.match(String(toolPayload(blockedSearch).error), /untrusted email/i);

  const blockedUnrelated = await runMailboxTool({
    db: state.db,
    toolName: "ask_inputs",
    args: { items: [{ id: "next", kind: "choice" }] },
    sequence: state.sequence,
    mailboxState,
    executor: async () => {
      blockedExecutions += 1;
      return { status: "ok", content: "{}", target: {} };
    },
  });
  assert.match(String(toolPayload(blockedUnrelated).error), /untrusted email/i);

  const blockedUnlistedRead = await runMailboxTool({
    db: state.db,
    toolName: "read_own_email",
    args: { message_id: "message-not-returned" },
    sequence: state.sequence,
    mailboxState,
    executor: async () => {
      blockedExecutions += 1;
      return { status: "ok", content: "{}", target: {} };
    },
  });
  assert.match(
    String(toolPayload(blockedUnlistedRead).error),
    /untrusted email/i,
  );
  assert.equal(blockedExecutions, 0);
});

test("each distinct search result can be read once before the turn locks", async () => {
  const state = auditDb();
  const mailboxState: MailboxTurnState = {
    untrustedEmailObserved: true,
    allowedReadMessageIds: new Set(["message-1", "message-2"]),
  };
  const readIds: string[] = [];

  const readReturnedMessage = async (messageId: string) =>
    runMailboxTool({
      db: state.db,
      toolName: "read_own_email",
      args: { message_id: messageId },
      sequence: state.sequence,
      mailboxState,
      executor: async (executorInput) => {
        const args = executorInput.args as Record<string, unknown>;
        readIds.push(String(args.message_id));
        return {
          status: "ok",
          error: null,
          content: JSON.stringify({ body: `Body for ${messageId}` }),
          structured_content: {
            kind: "email_message",
            message: { id: messageId },
          },
          target: { message_id: messageId },
        };
      },
    });

  assert.deepEqual(toolPayload(await readReturnedMessage("message-1")), {
    body: "Body for message-1",
  });
  assert.deepEqual([...mailboxState.allowedReadMessageIds], ["message-2"]);

  const repeated = await readReturnedMessage("message-1");
  assert.match(String(toolPayload(repeated).error), /untrusted email/i);

  assert.deepEqual(toolPayload(await readReturnedMessage("message-2")), {
    body: "Body for message-2",
  });
  assert.deepEqual([...mailboxState.allowedReadMessageIds], []);
  assert.deepEqual(readIds, ["message-1", "message-2"]);

  const afterAllReads = await runMailboxTool({
    db: state.db,
    toolName: "ask_inputs",
    args: { items: [{ id: "next", kind: "choice" }] },
    sequence: state.sequence,
    mailboxState,
    executor: async () => {
      throw new Error("mailbox executor must not handle unrelated tools");
    },
  });
  assert.match(String(toolPayload(afterAllReads).error), /untrusted email/i);
});

test("a successful direct read blocks every later tool in the same turn", async () => {
  const state = auditDb();
  const mailboxState = freshMailboxTurnState();

  await runMailboxTool({
    db: state.db,
    toolName: "read_own_email",
    args: { message_id: "direct-message" },
    sequence: state.sequence,
    mailboxState,
    executor: async () => ({
      status: "ok",
      error: null,
      content: JSON.stringify({ body: "Message body" }),
      structured_content: {
        kind: "email_message",
        message: { id: "direct-message" },
      },
      target: { message_id: "direct-message" },
    }),
  });
  assert.equal(mailboxState.untrustedEmailObserved, true);
  assert.deepEqual([...mailboxState.allowedReadMessageIds], []);

  const blocked = await runMailboxTool({
    db: state.db,
    args: { query: "another matter" },
    sequence: state.sequence,
    mailboxState,
    executor: async () => {
      throw new Error("mailbox executor must not run after direct read");
    },
  });
  assert.match(String(toolPayload(blocked).error), /untrusted email/i);
});

test("failed mailbox reads finalize the audit with only a bounded error code", async () => {
  const state = auditDb();
  const result = await runMailboxTool({
    db: state.db,
    toolName: "read_own_email",
    args: { message_id: "MESSAGE_ID_SENTINEL" },
    sequence: state.sequence,
    executor: async () => ({
      status: "error",
      error: {
        code: "graph_request_failed",
        message: "SAFE_MESSAGE_SENTINEL",
        http_status: 503,
      },
      content: "Own-mailbox read failed (graph_request_failed).",
      target: {
        service: "microsoft_graph",
        mailbox: "self",
        resource: "message",
        message_id: "MESSAGE_ID_SENTINEL",
      },
    }),
  });

  assert.equal(state.updates[0].status, "error");
  assert.equal(state.updates[0].error_code, "graph_request_failed");
  assert.match(String(state.updates[0].target_ref_hash), /^[a-f0-9]{64}$/);
  const durableAudit = JSON.stringify({
    insert: state.inserts[0],
    update: state.updates[0],
  });
  for (const sensitive of [
    "MESSAGE_ID_SENTINEL",
    "SAFE_MESSAGE_SENTINEL",
    "DOCKET_TOKEN_SENTINEL",
  ]) {
    assert.doesNotMatch(durableAudit, new RegExp(sensitive));
  }
  assert.match(
    String(
      (result.toolResults[0] as { content?: unknown } | undefined)?.content,
    ),
    /graph_request_failed/,
  );
});

test("mailbox result is withheld when the audit cannot be finalized", async () => {
  const state = auditDb("update");
  const result = await runMailboxTool({
    db: state.db,
    args: { query: "QUERY_SENTINEL" },
    sequence: state.sequence,
    executor: async () => ({
      status: "ok",
      error: null,
      content: JSON.stringify({ body: "BODY_SENTINEL" }),
      target: {},
    }),
  });

  assert.deepEqual(state.sequence, [
    "audit-insert",
    "mailbox-executor",
    "audit-update",
  ]);
  const payload = toolPayload(result);
  assert.match(String(payload.error), /finalize the required audit record/i);
  assert.doesNotMatch(JSON.stringify(payload), /BODY_SENTINEL/);
});

function runLlmStreamArguments(relativePath: string) {
  const path = resolve(import.meta.dirname, "..", relativePath);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const calls: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "runLLMStream" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      calls.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, source };
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
        (ts.isStringLiteral(candidate.name) && candidate.name.text === name)),
  );
}

test("latest user-message mailbox intent is explicit and deterministic", async () => {
  const runtime = (await import("../src/lib/chatTools")) as unknown as {
    latestUserMessageHasOwnMailboxIntent?: (
      messages: { role: string; content: string | null }[],
    ) => boolean;
  };
  assert.equal(
    typeof runtime.latestUserMessageHasOwnMailboxIntent,
    "function",
    "chatTools must export the current-message mailbox intent helper",
  );
  const hasIntent = runtime.latestUserMessageHasOwnMailboxIntent!;

  for (const content of [
    "Search my email for the engagement letter.",
    "Check my e-mails about the closing.",
    "Look in my mailbox for the invoice.",
    "What is new in my inbox?",
    "Find this in Outlook.",
    "Review my correspondence with opposing counsel.",
    "Find messages from Jane.",
    "Show me the message to the client.",
    "Were there messages about settlement?",
    "Find a message regarding the Smith matter.",
  ]) {
    assert.equal(hasIntent([{ role: "user", content }]), true, content);
  }

  for (const content of [
    "Summarize the attached document.",
    "Create a message template for the client portal.",
    "What did the prior chat message say?",
    "Draft a letter from Jane to the client.",
  ]) {
    assert.equal(hasIntent([{ role: "user", content }]), false, content);
  }

  assert.equal(
    hasIntent([
      { role: "user", content: "Search my inbox for the invoice." },
      { role: "assistant", content: "I found it." },
      { role: "user", content: "Now summarize the attached contract." },
    ]),
    false,
    "an older email request must not expose mailbox tools in a later turn",
  );
  assert.equal(
    hasIntent([
      { role: "user", content: "Summarize the contract." },
      { role: "assistant", content: "The prior email said to use Outlook." },
    ]),
    false,
    "assistant history must not create current-user mailbox intent",
  );
});

test("main and project assistants pass the authenticated token and canonical user intent", () => {
  for (const route of ["src/routes/chat.ts", "src/routes/projectChat.ts"]) {
    const { calls, source } = runLlmStreamArguments(route);
    assert.equal(calls.length, 1, `${route} should have one assistant runtime`);
    const tokenProperty = property(calls[0], "docketAccessToken");
    assert.ok(tokenProperty, `${route} must pass the request-scoped token`);
    assert.equal(
      tokenProperty.initializer.getText(source),
      "res.locals.token as string",
    );
    assert.equal(property(calls[0], "allowOwnMailboxAccess"), undefined);
    assert.equal(property(calls[0], "mailboxDataAlreadyPersisted"), undefined);
    assert.match(
      source.getFullText(),
      /const ownMailboxIntent\s*=\s*latestUserMessageHasOwnMailboxIntent\(streamMessages\)/,
      `${route} must derive intent before prompt and attachment decoration`,
    );
    assert.equal(
      calls[0].properties.some(
        (candidate) =>
          ts.isShorthandPropertyAssignment(candidate) &&
          candidate.name.text === "ownMailboxIntent",
      ),
      true,
      `${route} must pass the canonical intent into the runtime`,
    );
  }

  const { calls: tabularCalls } = runLlmStreamArguments(
    "src/routes/tabular.ts",
  );
  assert.equal(tabularCalls.length, 1);
  assert.equal(property(tabularCalls[0], "docketAccessToken"), undefined);
  assert.equal(
    tabularCalls[0].properties.some(
      (candidate) =>
        ts.isShorthandPropertyAssignment(candidate) &&
        candidate.name.text === "ownMailboxIntent",
    ),
    false,
  );
});

test("mailbox exposure is current-intent gated without persistent chat restrictions", () => {
  const chatRouteSource = readFileSync(
    resolve(import.meta.dirname, "..", "src/routes/chat.ts"),
    "utf8",
  );
  const runtimeSource = readFileSync(
    resolve(import.meta.dirname, "..", "src/lib/chatTools.ts"),
    "utf8",
  );
  assert.doesNotMatch(chatRouteSource, /contains_mailbox_data/);
  assert.doesNotMatch(runtimeSource, /contains_mailbox_data/);
  assert.doesNotMatch(runtimeSource, /mailboxDataAlreadyPersisted/);
  assert.doesNotMatch(
    runtimeSource,
    /latestUserMessageHasOwnMailboxIntent\(chatMessages\)/,
    "decorated provider messages must never establish mailbox intent",
  );
  assert.match(
    runtimeSource,
    /const mailboxTools\s*=\s*ownMailboxIntent\s*&&\s*!tabularStore\s*&&\s*docketAccessToken\s*&&\s*ownMailboxAccessConfigured\(\)/,
  );
  assert.match(
    runtimeSource,
    /ownMailboxIntent\s*&&\s*!tabularStore\s*&&\s*docketAccessToken\s*\?\s*\{\s*docketAccessToken,/,
    "the dispatcher must not receive mailbox credentials without current-message intent",
  );
  assert.match(
    runtimeSource,
    /const activeTools\s*=\s*extraTools\?\.length\s*\?\s*\[\.\.\.baseTools,\s*\.\.\.extraTools\]\s*:\s*baseTools/,
  );
  assert.match(
    runtimeSource,
    /const ownMailboxTurnState:\s*OwnMailboxTurnState\s*=\s*\{\s*untrustedEmailObserved:\s*false,\s*allowedReadMessageIds:\s*new Set\(\),\s*\}/,
  );
});

test("document reads do not write extracted content samples to runtime logs", () => {
  const runtimeSource = readFileSync(
    resolve(import.meta.dirname, "..", "src/lib/chatTools.ts"),
    "utf8",
  );
  assert.doesNotMatch(runtimeSource, /firstChars\s*=/);
  assert.doesNotMatch(runtimeSource, /text\.slice\(0,\s*120\)/);
});
