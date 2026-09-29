import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertAssistantCompletionOutcome,
  extractRichCitations,
  consumeAskInputsResponse,
  previewAskInputsResponse,
  createCitationSseBridge,
  hasAssistantCompletionOutcome,
  parseAskInputsResponsePayload,
  parsePartialRichCitationObjects,
  persistAskInputsRequest,
  validateAskInputsResponse,
  type AskInputsEvent,
} from "../src/lib/assistantContracts";

const backendRoot = resolve(new URL("..", import.meta.url).pathname);

test("assistant contract module exists for Docket-native input and citation flows", () => {
  assert.equal(
    existsSync(resolve(backendRoot, "src/lib/assistantContracts.ts")),
    true,
    "expected the Docket-native assistant contract module",
  );
});

const inputRequest: AskInputsEvent = {
  type: "ask_inputs",
  request_id: "input-request-1",
  items: [
    {
      id: "jurisdiction",
      kind: "choice",
      question: "Which jurisdiction governs?",
      options: [{ value: "Indiana" }, { value: "Illinois" }],
      allow_other: true,
      other_label: "Other",
    },
    {
      id: "source-documents",
      kind: "documents",
      document_types: ["contract", "amendment"],
    },
  ],
};

test("normal assistant completion requires visible text or an intentional pause", () => {
  const invalidOutcomes = [
    [],
    [{ type: "reasoning", text: "Researching" }],
    [{ type: "courtlistener_search_case_law", query: "standing" }],
    [{ type: "doc_created", filename: "draft.docx" }],
    [
      {
        type: "mcp_tool_call",
        status: "ok",
        approval_id: "approval-1",
        approval_status: "succeeded",
      },
    ],
    [{ type: "content", text: "   \n" }],
    [
      {
        type: "mcp_tool_call",
        status: "approval_required",
        approval_status: "pending",
      },
    ],
    [
      {
        type: "mcp_tool_call",
        status: "approval_required",
        approval_status: "succeeded",
        approval_id: "approval-1",
      },
    ],
  ];

  for (const events of invalidOutcomes) {
    assert.equal(hasAssistantCompletionOutcome(events), false);
  }

  assert.equal(
    hasAssistantCompletionOutcome([
      { type: "content", text: "The requested answer." },
    ]),
    true,
  );
  assert.equal(
    hasAssistantCompletionOutcome([
      { type: "content", text: "I cannot help with that request." },
    ]),
    true,
  );
  assert.equal(hasAssistantCompletionOutcome([inputRequest]), true);
  assert.equal(
    hasAssistantCompletionOutcome([
      {
        type: "mcp_tool_call",
        status: "approval_required",
        approval_status: "pending",
        approval_id: "approval-1",
      },
    ]),
    true,
  );

  assert.throws(
    () =>
      assertAssistantCompletionOutcome([
        { type: "courtlistener_search_case_law", query: "standing" },
      ]),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ASSISTANT_INCOMPLETE_RESPONSE",
  );
});

test("both chat routes fail closed before claiming a completed run", () => {
  for (const relativePath of [
    "src/routes/chat.ts",
    "src/routes/projectChat.ts",
  ]) {
    const source = readFileSync(resolve(backendRoot, relativePath), "utf8");
    const guardIndex = source.indexOf(
      "assertAssistantCompletionOutcome(events)",
    );
    const completedClaimIndex = source.indexOf(
      "claimBackgroundRunFinalization({",
      guardIndex,
    );

    assert.ok(guardIndex >= 0, `${relativePath} must enforce the outcome guard`);
    assert.ok(
      completedClaimIndex > guardIndex,
      `${relativePath} must guard before claiming completion`,
    );
    assert.equal(source.includes("if (!events.length)"), false);
  }
});

test("Ask Inputs accepts a bounded response and canonicalizes trusted prompt text", () => {
  const parsed = parseAskInputsResponsePayload({
    request_id: "input-request-1",
    responses: [
      {
        id: "jurisdiction",
        kind: "choice",
        question: "client supplied text must not win",
        answer: "Indiana",
      },
      {
        id: "source-documents",
        kind: "documents",
        filenames: ["Master Services Agreement.docx"],
      },
    ],
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.response) return;

  const requestWithoutOther: AskInputsEvent = {
    ...inputRequest,
    items: inputRequest.items.map((item) =>
      item.kind === "choice" ? { ...item, allow_other: false } : item,
    ),
  };
  const checked = validateAskInputsResponse(parsed.response, requestWithoutOther);
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  assert.equal(
    checked.response.responses[0].kind === "choice"
      ? checked.response.responses[0].question
      : "",
    "Which jurisdiction governs?",
  );
  assert.match(checked.content, /Indiana/);
  assert.match(checked.content, /Master Services Agreement\.docx/);
});

test("Ask Inputs rejects duplicate responses and choices outside the request options", () => {
  const duplicate = parseAskInputsResponsePayload({
    request_id: "input-request-1",
    responses: [
      { id: "jurisdiction", kind: "choice", answer: "Indiana" },
      { id: "jurisdiction", kind: "choice", answer: "Illinois" },
    ],
  });
  assert.equal(duplicate.ok, false);

  const parsed = parseAskInputsResponsePayload({
    request_id: "input-request-1",
    responses: [
      { id: "jurisdiction", kind: "choice", answer: "Ohio" },
      {
        id: "source-documents",
        kind: "documents",
        filenames: ["Source.pdf"],
      },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.response) return;
  const requestWithoutOther: AskInputsEvent = {
    ...inputRequest,
    items: inputRequest.items.map((item) =>
      item.kind === "choice" ? { ...item, allow_other: false } : item,
    ),
  };
  const checked = validateAskInputsResponse(parsed.response, requestWithoutOther);
  assert.equal(checked.ok, false);
});

test("rich citations retain spreadsheet cells and CourtListener case metadata", () => {
  const text = `Analysis [1] and controlling authority [2].
<CITATIONS>
[
  {"ref":1,"doc_id":"doc-0","page":1,"quote":"Payment is due","sheet":"Fees","cell":"B7","quotes":[{"page":1,"quote":"Payment is due","sheet":"Fees","cell":"B7"}]},
  {"ref":2,"cluster_id":456,"quote":"The court held...","quotes":[{"opinion_id":89,"type":"majority","author":"Smith","quote":"The court held..."}]}
]
</CITATIONS>`;
  const citations = extractRichCitations(
    text,
    {
      "doc-0": {
        document_id: "document-1",
        filename: "Fee Schedule.xlsx",
        version_id: "version-1",
        version_number: 3,
      },
    },
    [
      {
        type: "case_citation",
        cluster_id: 456,
        case_name: "Example v. Docket",
        citation: "123 N.E.3d 456",
        url: "https://www.courtlistener.com/opinion/456/",
        dateFiled: "2025-01-02",
      },
    ],
  );

  assert.equal(citations.length, 2);
  assert.deepEqual(citations[0], {
    type: "citation_data",
    kind: "document",
    ref: 1,
    doc_id: "doc-0",
    document_id: "document-1",
    version_id: "version-1",
    version_number: 3,
    filename: "Fee Schedule.xlsx",
    page: 1,
    quote: "Payment is due",
    sheet: "Fees",
    cell: "B7",
    quotes: [
      { page: 1, quote: "Payment is due", sheet: "Fees", cell: "B7" },
    ],
  });
  assert.deepEqual(citations[1], {
    type: "citation_data",
    kind: "case",
    ref: 2,
    cluster_id: 456,
    case_name: "Example v. Docket",
    citation: "123 N.E.3d 456",
    url: "https://www.courtlistener.com/opinion/456/",
    pdfUrl: null,
    dateFiled: "2025-01-02",
    quotes: [
      {
        opinionId: 89,
        type: "majority",
        author: "Smith",
        quote: "The court held...",
      },
    ],
  });
});

test("rich citation parser emits only complete partial objects while streaming", () => {
  const partial = parsePartialRichCitationObjects(
    `<CITATIONS>[{"ref":1,"doc_id":"doc-0","page":2,"quote":"Complete"},{"ref":2,"doc_id":"doc-1"`,
  );
  assert.equal(partial.length, 1);
  assert.equal(partial[0]?.kind, "document");
  assert.equal(partial[0]?.ref, 1);
});

test("rich citation extraction preserves complete partial citations after an interrupted stream", () => {
  const citations = extractRichCitations(
    `<CITATIONS>[{"ref":1,"doc_id":"doc-0","page":7,"quote":"Preserved"},{"ref":2`,
    {
      "doc-0": {
        document_id: "document-1",
        filename: "Source.pdf",
      },
    },
  );
  assert.equal(citations.length, 1);
  assert.equal(citations[0]?.kind, "document");
  assert.equal(citations[0]?.ref, 1);
});

test("Azure schema has durable Ask Inputs records and a separate rich citation field", () => {
  const migrationPath = resolve(
    backendRoot,
    "migrations/20260709_01_assistant_contracts.sql",
  );
  assert.equal(existsSync(migrationPath), true, "expected assistant contracts migration");
  const migration = readFileSync(migrationPath, "utf8");
  assert.match(migration, /create table if not exists public\.assistant_input_requests/i);
  assert.match(migration, /create table if not exists public\.assistant_input_responses/i);
  assert.match(migration, /add column if not exists citations jsonb/i);
});

test("fresh PostgreSQL schemas include assistant contracts", () => {
  for (const relativePath of ["schema.sql", "migrations/azure_postgres_schema.sql"]) {
    const schema = readFileSync(resolve(backendRoot, relativePath), "utf8");
    assert.match(schema, /citations jsonb/i, `${relativePath} is missing citations`);
    assert.match(
      schema,
      /create table if not exists public\.assistant_input_requests/i,
      `${relativePath} is missing assistant input requests`,
    );
    assert.match(
      schema,
      /create table if not exists public\.assistant_input_responses/i,
      `${relativePath} is missing assistant input responses`,
    );
  }
});

function createAssistantContractsDb() {
  const tables: Record<string, Record<string, unknown>[]> = {
    assistant_input_requests: [],
    assistant_input_responses: [],
    chat_messages: [
      {
        id: "assistant-message-1",
        chat_id: "chat-1",
        role: "assistant",
        content: [inputRequest],
      },
    ],
  };

  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let updateValues: Record<string, unknown> | null = null;
    const matching = () =>
      (tables[table] ?? []).filter((row) =>
        filters.every(([key, value]) => row[key] === value),
      );
    const result = () => {
      const rows = matching();
      if (updateValues) {
        for (const row of rows) Object.assign(row, updateValues);
      }
      return { data: rows, error: null };
    };
    const query: Record<string, unknown> = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        filters.push([key, value]);
        return query;
      },
      maybeSingle: async () => {
        const rows = matching();
        return { data: rows[0] ?? null, error: null };
      },
      insert: async (row: Record<string, unknown>) => {
        if (table === "assistant_input_responses") {
          const duplicate = (tables[table] ?? []).some(
            (existing) => existing.request_id === row.request_id,
          );
          if (duplicate) return { data: null, error: { message: "duplicate" } };
        }
        tables[table] ??= [];
        tables[table].push({ ...row });
        return { data: row, error: null };
      },
      update: (values: Record<string, unknown>) => {
        updateValues = values;
        return query;
      },
      then: (resolve: (value: unknown) => unknown) => resolve(result()),
    };
    return query;
  };

  return { db: { from, transaction: createAskInputsTransaction(tables) }, tables };
}

function createAskInputsTransaction(
  tables: Record<string, Record<string, unknown>[]>,
  failAt: "append" | "status" | null = null,
) {
  let nextFailure = failAt;
  let previous = Promise.resolve();
  return async function transact<T>(
    operation: (client: {
      query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    }) => Promise<T>,
  ): Promise<T> {
    const prior = previous;
    let release!: () => void;
    previous = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    const snapshot = structuredClone(tables);
    const client = {
      async query(sql: string, values: unknown[] = []) {
        if (sql.includes("from public.assistant_input_requests") && sql.includes("for update")) {
          return { rows: tables.assistant_input_requests.filter((row) =>
            row.id === values[0] && row.chat_id === values[1]) };
        }
        if (sql.includes("from public.chat_messages") && sql.includes("for update")) {
          return { rows: tables.chat_messages.filter((row) =>
            row.id === values[0] && row.chat_id === values[1]) };
        }
        if (sql.includes("insert into public.assistant_input_responses")) {
          if (tables.assistant_input_responses.some((row) => row.request_id === values[0])) {
            throw new Error("duplicate response");
          }
          tables.assistant_input_responses.push({
            request_id: values[0],
            submitted_by_user_id: values[1],
            response: JSON.parse(String(values[2])),
          });
          return { rows: [{ request_id: values[0] }] };
        }
        if (sql.includes("update public.chat_messages")) {
          if (nextFailure === "append") {
            nextFailure = null;
            throw new Error("simulated message update failure");
          }
          const row = tables.chat_messages.find((message) => message.id === values[1]);
          if (!row) return { rows: [] };
          row.content = JSON.parse(String(values[0]));
          return { rows: [{ id: row.id }] };
        }
        if (sql.includes("update public.assistant_input_requests")) {
          if (nextFailure === "status") {
            nextFailure = null;
            throw new Error("simulated status update failure");
          }
          const row = tables.assistant_input_requests.find((request) =>
            request.id === values[1] && request.status === "pending");
          if (!row) return { rows: [] };
          row.status = "resolved";
          row.resolved_at = values[0];
          return { rows: [{ id: row.id }] };
        }
        throw new Error(`Unexpected Ask Inputs SQL: ${sql}`);
      },
    };
    try {
      return await operation(client);
    } catch (error) {
      for (const [table, rows] of Object.entries(snapshot)) tables[table] = rows;
      throw error;
    } finally {
      release();
    }
  };
}

test("Ask Inputs persistence binds an Entra user response to the original assistant event", async () => {
  const { db, tables } = createAssistantContractsDb();
  const saved = await persistAskInputsRequest(db, {
    chatId: "chat-1",
    assistantMessageId: "assistant-message-1",
    createdByUserId: "entra-user-1",
    event: inputRequest,
  });
  assert.equal(saved.ok, true);
  assert.equal(tables.assistant_input_requests.length, 1);

  const parsed = parseAskInputsResponsePayload({
    request_id: "input-request-1",
    responses: [
      { id: "jurisdiction", kind: "choice", answer: "Illinois" },
      { id: "source-documents", kind: "documents", filenames: ["Source.pdf"] },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.response) return;

  const preview = await previewAskInputsResponse(db, {
    chatId: "chat-1",
    submittedByUserId: "entra-user-2",
    response: parsed.response,
  });
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.match(preview.content, /Illinois/);
  assert.equal(tables.assistant_input_requests[0].status, "pending");
  assert.equal(tables.assistant_input_responses.length, 0);
  // A failed prompt, placeholder, or run insert can now retry this same form.
  assert.equal((await previewAskInputsResponse(db, {
    chatId: "chat-1",
    submittedByUserId: "entra-user-2",
    response: parsed.response,
  })).ok, true);

  const consumed = await consumeAskInputsResponse(db, {
    chatId: "chat-1",
    submittedByUserId: "entra-user-2",
    response: parsed.response,
  });
  assert.equal(consumed.ok, true);
  assert.equal(tables.assistant_input_responses.length, 1);
  assert.equal(tables.assistant_input_requests[0].status, "resolved");
  const events = tables.chat_messages[0].content as { type: string }[];
  assert.equal(events.at(-1)?.type, "ask_inputs_response");
  const duplicate = await consumeAskInputsResponse(db, {
    chatId: "chat-1",
    submittedByUserId: "entra-user-2",
    response: parsed.response,
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.status, 409);
});

for (const failedWrite of ["append", "status"] as const) {
  test(`Ask Inputs rolls back a failed ${failedWrite} write and permits one retry`, async () => {
    const { db, tables } = createAssistantContractsDb();
    const saved = await persistAskInputsRequest(db, {
      chatId: "chat-1",
      assistantMessageId: "assistant-message-1",
      createdByUserId: "entra-user-1",
      event: inputRequest,
    });
    assert.equal(saved.ok, true);
    const parsed = parseAskInputsResponsePayload({
      request_id: "input-request-1",
      responses: [
        { id: "jurisdiction", kind: "choice", answer: "Illinois" },
        { id: "source-documents", kind: "documents", filenames: ["Source.pdf"] },
      ],
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok || !parsed.response) return;
    const params = {
      chatId: "chat-1",
      submittedByUserId: "entra-user-2",
      response: parsed.response,
    };
    const transact = createAskInputsTransaction(tables, failedWrite);

    const failed = await consumeAskInputsResponse(db, params, transact);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.status, 500);
    assert.equal(tables.assistant_input_responses.length, 0);
    assert.equal(tables.assistant_input_requests[0].status, "pending");
    assert.equal((tables.chat_messages[0].content as unknown[]).length, 1);
    assert.equal((await previewAskInputsResponse(db, params)).ok, true);

    const retried = await consumeAskInputsResponse(db, params, transact);
    assert.equal(retried.ok, true);
    assert.equal(tables.assistant_input_responses.length, 1);
    assert.equal(tables.assistant_input_requests[0].status, "resolved");
    const events = tables.chat_messages[0].content as { type: string }[];
    assert.equal(events.filter((event) => event.type === "ask_inputs_response").length, 1);
    const replay = await consumeAskInputsResponse(db, params, transact);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.status, 409);
  });
}

test("concurrent Ask Inputs submits commit one answer and one provider continuation", async () => {
  const { db, tables } = createAssistantContractsDb();
  await persistAskInputsRequest(db, {
    chatId: "chat-1",
    assistantMessageId: "assistant-message-1",
    createdByUserId: "entra-user-1",
    event: inputRequest,
  });
  const parsed = parseAskInputsResponsePayload({
    request_id: "input-request-1",
    responses: [
      { id: "jurisdiction", kind: "choice", answer: "Illinois" },
      { id: "source-documents", kind: "documents", filenames: ["Source.pdf"] },
    ],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || !parsed.response) return;
  const params = {
    chatId: "chat-1",
    submittedByUserId: "entra-user-2",
    response: parsed.response,
  };
  const transact = createAskInputsTransaction(tables);
  const results = await Promise.all([
    consumeAskInputsResponse(db, params, transact),
    consumeAskInputsResponse(db, params, transact),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.status === 409).length, 1);
  assert.equal(tables.assistant_input_responses.length, 1);
  const events = tables.chat_messages[0].content as { type: string }[];
  assert.equal(events.filter((event) => event.type === "ask_inputs_response").length, 1);
});

test("PostgreSQL adapter serializes the new JSON contract columns", () => {
  const adapter = readFileSync(resolve(backendRoot, "src/lib/supabase.ts"), "utf8");
  assert.match(adapter, /chat_messages: new Set\(\[[^\]]*"citations"/s);
  assert.match(adapter, /assistant_input_requests: new Set\(\["request"\]\)/);
  assert.match(adapter, /assistant_input_responses: new Set\(\["response"\]\)/);
});

test("citation SSE bridge preserves partial snapshots and replaces legacy final output", () => {
  const lines: string[] = [];
  const bridge = createCitationSseBridge((line) => lines.push(line));
  bridge.write(`data: ${JSON.stringify({ type: "citations", status: "partial", citations: [] })}\n\n`);
  bridge.write(`data: ${JSON.stringify({ type: "citations", citations: [{ ref: 1 }] })}\n\n`);
  bridge.write("data: [DONE]\n\n");
  bridge.finish([
    {
      type: "citation_data",
      kind: "case",
      ref: 1,
      cluster_id: 12,
      case_name: "Example",
      citation: null,
      url: null,
      pdfUrl: null,
      dateFiled: null,
      quotes: [{ opinionId: null, type: null, author: null, quote: "Holding" }],
    },
  ]);

  assert.equal(lines.length, 3);
  assert.match(lines[0], /"status":"partial"/);
  assert.match(lines[1], /"status":"final"/);
  assert.equal(lines[2], "data: [DONE]\n\n");
});

test("citation SSE bridge emits terminal JSON immediately before DONE", () => {
  const lines: string[] = [];
  const bridge = createCitationSseBridge((line) => lines.push(line));
  bridge.finish([], {
    type: "stream_terminal",
    status: "completed",
    runId: "019f7170-9f04-72c1-8364-45f504ca2153",
  });

  assert.equal(lines.length, 3);
  assert.match(lines[0], /"type":"citations"/);
  assert.match(lines[1], /"type":"stream_terminal"/);
  assert.equal(lines[2], "data: [DONE]\n\n");
});

test("general and project chat routes validate/resume inputs and persist rich citations", () => {
  for (const relativePath of ["src/routes/chat.ts", "src/routes/projectChat.ts"]) {
    const route = readFileSync(resolve(backendRoot, relativePath), "utf8");
    assert.match(route, /parseAskInputsResponsePayload/);
    assert.match(route, /consumeAskInputsResponse/);
    assert.match(route, /createCitationSseBridge/);
    assert.match(route, /extractRichCitations/);
    assert.match(route, /citations:/);
  }
});

test("both chat routes keep Ask Inputs pending through startup and report saved-message state", () => {
  for (const relativePath of ["src/routes/chat.ts", "src/routes/projectChat.ts"]) {
    const route = readFileSync(resolve(backendRoot, relativePath), "utf8");
    const stream = route.slice(route.indexOf("// POST /chat — streaming") >= 0
      ? route.indexOf("// POST /chat — streaming")
      : route.indexOf("// POST /projects/:projectId/chat — streaming"));
    const positions = [
      stream.indexOf("await previewAskInputsResponse("),
      stream.indexOf('runAssistantStartupStep(startDiagnostic, "prompt_persist"'),
      stream.indexOf('runAssistantStartupStep(startDiagnostic, "placeholder_create"'),
      stream.indexOf("await createAssistantBackgroundRun(db, {"),
      stream.indexOf("await consumeAskInputsResponse("),
      stream.indexOf("await runLLMStream("),
    ];
    assert.ok(positions.every((position) => position >= 0), `${relativePath}: missing staged step`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b),
      `${relativePath}: provider work must follow durable startup and form consumption`);
    assert.match(stream, /assistantStartupFailureResponse\(\s*startDiagnostic, chatId, false/s);
    assert.match(stream, /assistantStartupFailureResponse\(\s*startDiagnostic, chatId, Boolean\(lastUser\)/s);
    assert.match(stream, /assistantStartupFailureResponse\(\s*streamLifecycle, chatId, Boolean\(lastUser\)/s);
  }
});

test("Docket client exposes authenticated Ask Inputs and rich citation states", () => {
  const frontendRoot = resolve(backendRoot, "../frontend/src/app");
  const types = readFileSync(resolve(frontendRoot, "components/shared/types.ts"), "utf8");
  assert.match(types, /type:\s*"ask_inputs"/);
  assert.match(types, /request_id:\s*string/);
  assert.match(types, /kind:\s*"case"/);
  assert.match(types, /sheet\?:\s*string/);
  assert.match(types, /cell\?:\s*string/);
  assert.match(types, /citationStatus/);

  const popupPath = resolve(frontendRoot, "components/assistant/AskInputsPopup.tsx");
  assert.equal(existsSync(popupPath), true, "expected Docket Ask Inputs popup");
  const popup = readFileSync(popupPath, "utf8");
  assert.match(popup, /uploadStandaloneDocument/);
  assert.match(popup, /uploadProjectDocument/);

  const hook = readFileSync(resolve(frontendRoot, "hooks/useAssistantChat.ts"), "utf8");
  assert.match(hook, /ask_inputs_response/);
  assert.match(hook, /data\.type === "ask_inputs"/);
  assert.match(hook, /citationStatus/);
});
