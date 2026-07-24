import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assistantBackgroundProgressUpdate,
  claimAssistantBackgroundRunFinalization,
  createAssistantBackgroundRun,
  getAssistantBackgroundRunById,
  updateAssistantBackgroundRun,
  updateAssistantBackgroundRunAsFinalizer,
  type AssistantBackgroundRunsDb,
} from "../src/lib/assistantBackgroundRuns";

const STREAM_REQUEST_ID = "019f7170-9f04-72c1-8364-45f504ca2153";
const CREATED_AT = "2026-07-17T15:00:00.000Z";

function createFakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    from(table: string) {
      assert.equal(table, "assistant_background_runs");
      let operation: "select" | "insert" | "update" = "select";
      let values: Record<string, unknown> = {};
      let streamRequestId: string | null = null;
      let allowedStatuses: string[] | null = null;
      let expectedFinalizationOwner: unknown = undefined;
      let expectedStatus: unknown = undefined;
      let expectedUpdatedAt: unknown = undefined;

      const execute = () => {
        if (operation === "insert") {
          const id = String(values.stream_request_id);
          const row = {
            project_id: null,
            provider_response_id: null,
            provider_request_id: null,
            provider_status: null,
            reasoning_mode: null,
            reasoning_effort: null,
            error_code: null,
            safe_error_message: null,
            finalization_owner: null,
            request_started_at: CREATED_AT,
            created_at: CREATED_AT,
            updated_at: CREATED_AT,
            completed_at: null,
            ...values,
          };
          rows.set(id, row);
          return row;
        }
        if (!streamRequestId) return null;
        const current = rows.get(streamRequestId) ?? null;
        if (
          current &&
          expectedFinalizationOwner !== undefined &&
          current.finalization_owner !== expectedFinalizationOwner
        ) {
          return null;
        }
        if (
          current &&
          expectedStatus !== undefined &&
          current.status !== expectedStatus
        ) {
          return null;
        }
        if (
          current &&
          expectedUpdatedAt !== undefined &&
          current.updated_at !== expectedUpdatedAt
        ) {
          return null;
        }
        if (
          current &&
          allowedStatuses &&
          !allowedStatuses.includes(String(current.status))
        ) {
          return null;
        }
        if (operation === "update" && current) {
          const updated = { ...current, ...values };
          rows.set(streamRequestId, updated);
          return updated;
        }
        return current;
      };

      const builder: any = {
        insert(row: Record<string, unknown>) {
          operation = "insert";
          values = row;
          return builder;
        },
        update(row: Record<string, unknown>) {
          operation = "update";
          values = row;
          return builder;
        },
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          if (column === "finalization_owner") {
            expectedFinalizationOwner = value;
            return builder;
          }
          if (column === "status") {
            expectedStatus = value;
            return builder;
          }
          if (column === "updated_at") {
            expectedUpdatedAt = value;
            return builder;
          }
          assert.equal(column, "stream_request_id");
          streamRequestId = String(value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          assert.equal(column, "status");
          allowedStatuses = values.map(String);
          return builder;
        },
        async single() {
          const data = execute();
          return {
            data,
            error: data ? null : { message: "No rows found" },
          };
        },
        async maybeSingle() {
          return { data: execute(), error: null };
        },
      };
      return builder;
    },
  } as AssistantBackgroundRunsDb;
  return { db, rows };
}

async function createRun(db: AssistantBackgroundRunsDb) {
  return createAssistantBackgroundRun(db, {
    streamRequestId: STREAM_REQUEST_ID,
    assistantMessageId: "019f7170-9f04-72c1-8364-45f504ca2154",
    chatId: "019f7170-9f04-72c1-8364-45f504ca2155",
    userId: "entra-user-1",
    projectId: "019f7170-9f04-72c1-8364-45f504ca2156",
    providerResponseId: "resp_123",
    providerRequestId: "req_123",
    status: "background_pending",
    providerStatus: "queued",
    model: "gpt-5.6-sol",
    reasoningMode: "pro",
    reasoningEffort: "max",
    traceId: "trace-123",
    revision: "mike-api--0000042",
    requestStartedAt: new Date(CREATED_AT),
  });
}

test("creates a typed durable background run using the stream request UUID", async () => {
  const { db, rows } = createFakeDb();
  const run = await createRun(db);

  assert.equal(run.streamRequestId, STREAM_REQUEST_ID);
  assert.equal(run.assistantMessageId.endsWith("2154"), true);
  assert.equal(run.status, "background_pending");
  assert.equal(run.providerStatus, "queued");
  assert.equal(run.providerResponseId, "resp_123");
  assert.equal(run.providerRequestId, "req_123");
  assert.equal(run.iteration, 1);
  assert.equal(run.requestStartedAt, CREATED_AT);
  assert.equal(
    rows.get(STREAM_REQUEST_ID)?.assistant_message_id,
    run.assistantMessageId,
  );
});

test("updates lifecycle/provider fields without replacing immutable ownership", async () => {
  const { db } = createFakeDb();
  const created = await createRun(db);
  const completedAt = "2026-07-17T15:04:00.000Z";

  await updateAssistantBackgroundRun(db, STREAM_REQUEST_ID, {
    status: "finalizing",
    providerStatus: "completed",
  });
  const updated = await updateAssistantBackgroundRun(db, STREAM_REQUEST_ID, {
    iteration: 2,
    status: "completed",
    providerStatus: "completed",
    providerResponseId: "resp_456",
    providerRequestId: "req_456",
    completedAt,
    updatedAt: completedAt,
  });

  assert.ok(updated);
  assert.equal(updated.chatId, created.chatId);
  assert.equal(updated.userId, created.userId);
  assert.equal(updated.iteration, 2);
  assert.equal(updated.status, "completed");
  assert.equal(updated.providerResponseId, "resp_456");
  assert.equal(updated.completedAt, completedAt);
});

test("keeps cancel_requested sticky against late provider progress", async () => {
  const { db } = createFakeDb();
  await createRun(db);
  await updateAssistantBackgroundRun(db, STREAM_REQUEST_ID, {
    status: "cancel_requested",
    errorCode: "explicit_user_cancel",
  });

  assert.equal(
    await updateAssistantBackgroundRun(db, STREAM_REQUEST_ID, {
      status: "completed",
      providerStatus: "completed",
    }),
    null,
  );
  assert.equal(
    (await getAssistantBackgroundRunById(db, STREAM_REQUEST_ID))?.status,
    "cancel_requested",
  );
  assert.equal(
    (
      await updateAssistantBackgroundRun(db, STREAM_REQUEST_ID, {
        status: "cancelled",
        providerStatus: "cancelled",
      })
    )?.status,
    "cancelled",
  );
});

test("keeps terminal states monotonic against a late cancellation request", async () => {
  const { db } = createFakeDb();
  await createRun(db);
  await updateAssistantBackgroundRun(db, STREAM_REQUEST_ID, {
    status: "finalizing",
    providerStatus: "completed",
  });
  await updateAssistantBackgroundRun(db, STREAM_REQUEST_ID, {
    status: "completed",
    providerStatus: "completed",
    completedAt: CREATED_AT,
  });

  assert.equal(
    await updateAssistantBackgroundRun(db, STREAM_REQUEST_ID, {
      status: "cancel_requested",
      errorCode: "explicit_user_cancel",
    }),
    null,
  );
  assert.equal(
    (await getAssistantBackgroundRunById(db, STREAM_REQUEST_ID))?.status,
    "completed",
  );
});

test("finalization claim cannot steal a run already owned by recovery", async () => {
  const { db } = createFakeDb();
  await createRun(db);

  const claimed = await claimAssistantBackgroundRunFinalization(
    db,
    STREAM_REQUEST_ID,
    "019f7170-9f04-72c1-8364-45f504ca2200",
    { providerStatus: "completed" },
  );
  assert.equal(claimed?.status, "finalizing");
  assert.equal(claimed?.finalizationOwner?.endsWith("2200"), true);
  assert.equal(
    await updateAssistantBackgroundRunAsFinalizer(
      db,
      STREAM_REQUEST_ID,
      "019f7170-9f04-72c1-8364-45f504ca2201",
      { status: "completed" },
    ),
    null,
  );
  assert.equal(
    await claimAssistantBackgroundRunFinalization(
      db,
      STREAM_REQUEST_ID,
      "019f7170-9f04-72c1-8364-45f504ca2201",
      { providerStatus: "failed" },
    ),
    null,
  );
  assert.equal(
    (await getAssistantBackgroundRunById(db, STREAM_REQUEST_ID))
      ?.providerStatus,
    "completed",
  );
});

test("loads a run by ID and returns null for an unknown ID", async () => {
  const { db } = createFakeDb();
  await createRun(db);

  assert.equal(
    (
      await getAssistantBackgroundRunById(db, STREAM_REQUEST_ID)
    )?.assistantMessageId.endsWith("2154"),
    true,
  );
  assert.equal(
    await getAssistantBackgroundRunById(
      db,
      "019f7170-9f04-72c1-8364-45f504ca2199",
    ),
    null,
  );
});

test("maps provider progress without downgrading a detached background run", () => {
  assert.deepEqual(
    assistantBackgroundProgressUpdate(
      {
        provider: "openai",
        iteration: 2,
        phase: "polling",
        background: true,
        providerResponseId: "resp_456",
        providerRequestId: "req_456",
        providerStatus: "in_progress",
      },
      true,
    ),
    {
      iteration: 2,
      status: "background_pending",
      providerStatus: "in_progress",
      providerResponseId: "resp_456",
      providerRequestId: "req_456",
    },
  );
  assert.equal(
    assistantBackgroundProgressUpdate(
      {
        provider: "openai",
        iteration: 2,
        phase: "completed",
        background: true,
        providerStatus: "completed",
      },
      false,
    ).status,
    "running_tools",
  );
  assert.equal(
    assistantBackgroundProgressUpdate(
      {
        provider: "openai",
        iteration: 2,
        phase: "failed",
        background: true,
        providerStatus: "failed",
      },
      false,
    ).status,
    "finalizing",
  );
});

function tableDefinition(sql: string): string {
  const match = sql.match(
    /create table if not exists public\.assistant_background_runs \(([\s\S]*?)\n\);/i,
  );
  assert.ok(match, "assistant_background_runs table must exist");
  return match[1].replace(/\s+/g, " ").trim();
}

test("incremental and fresh schemas keep the same constrained table contract", () => {
  const migration = readFileSync(
    new URL(
      "../migrations/20260717_assistant_background_runs.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const freshSchema = readFileSync(
    new URL("../migrations/azure_postgres_schema.sql", import.meta.url),
    "utf8",
  );

  assert.equal(tableDefinition(freshSchema), tableDefinition(migration));
  assert.match(migration, /stream_request_id uuid primary key/i);
  assert.match(migration, /assistant_message_id uuid not null unique/i);
  assert.match(migration, /chat_messages\(id\) on delete cascade/i);
  assert.match(migration, /projects\(id\) on delete set null/i);
  assert.match(migration, /check \(status in/i);
  assert.match(migration, /provider_status is null/i);
  assert.match(migration, /assistant_background_runs_chat_status_idx/i);
  assert.match(migration, /assistant_background_runs_user_status_idx/i);
  assert.match(migration, /assistant_background_runs_provider_response_idx/i);

  const messageIndex = freshSchema.indexOf("idx_chat_messages_chat");
  const runTable = freshSchema.indexOf(
    "create table if not exists public.assistant_background_runs",
  );
  const inputTable = freshSchema.indexOf(
    "create table if not exists public.assistant_input_requests",
  );
  assert.ok(messageIndex < runTable && runTable < inputTable);
});

test("both assistant routes persist every run and track provider progress", () => {
  const chatRoute = readFileSync(
    new URL("../src/routes/chat.ts", import.meta.url),
    "utf8",
  );
  const projectRoute = readFileSync(
    new URL("../src/routes/projectChat.ts", import.meta.url),
    "utf8",
  );

  for (const route of [chatRoute, projectRoute]) {
    assert.match(route, /createAssistantBackgroundRun/);
    assert.match(route, /assistantBackgroundProgressUpdate/);
    assert.match(route, /const runPersistenceEnabled = true/);
    assert.match(route, /assistantRunId: runPersistenceEnabled/);
    assert.match(route, /onProviderRunProgress: persistProviderProgress/);
    assert.match(route, /status: "background_pending"/);
    assert.match(route, /status: "completed"/);
    assert.match(route, /completedAt: new Date\(\)/);
  }

  assert.ok(
    chatRoute.indexOf('chatRouter.get("/runs/:streamRequestId"') <
      chatRoute.indexOf('chatRouter.get("/:chatId"'),
    "run status endpoint must be registered before the generic chat route",
  );
});

test("chat hydration exposes only the current user's run for a matching placeholder", () => {
  const chatRoute = readFileSync(
    new URL("../src/routes/chat.ts", import.meta.url),
    "utf8",
  );
  const hydrationStart = chatRoute.indexOf(
    "// A page reload loses the browser's in-memory stream ID.",
  );
  const hydrationEnd = chatRoute.indexOf(
    "// Stored message annotations/events",
    hydrationStart,
  );
  const hydration = chatRoute.slice(hydrationStart, hydrationEnd);

  assert.ok(hydrationStart >= 0 && hydrationEnd > hydrationStart);
  assert.match(hydration, /\.eq\("chat_id", chatId\)/);
  assert.match(hydration, /\.eq\("user_id", userId\)/);
  assert.match(hydration, /HYDRATABLE_ASSISTANT_RUN_STATUSES/);
  assert.match(hydration, /message\.id === activeAssistantMessageId/);
  assert.match(hydration, /message\.content == null/);
  assert.match(
    hydration,
    /active_run: hasMatchingPlaceholder \? activeRun : null/,
  );
});
