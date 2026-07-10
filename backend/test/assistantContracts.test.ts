import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  extractRichCitations,
  consumeAskInputsResponse,
  createCitationSseBridge,
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

  return { db: { from }, tables };
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
