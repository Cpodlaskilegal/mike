import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const backendRoot = new URL("..", import.meta.url).pathname;
const spendModulePath = join(backendRoot, "src/lib/llmSpend.ts");

process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

async function loadSpend() {
  assert.ok(
    existsSync(spendModulePath),
    "expected the LLM spend module to exist",
  );
  return import("../src/lib/llmSpend");
}

test("calculates GPT-5.5 input, cached-input, and output cost in nano-USD", async () => {
  const spend = await loadSpend();
  const result = spend.calculateLlmCostNanos({
    provider: "openai",
    model: "gpt-5.5",
    inputTokens: 1_000_000,
    cachedInputTokens: 200_000,
    outputTokens: 1_000_000,
  });

  assert.equal(result.pricingStatus, "priced");
  assert.equal(result.inputCostNanos, 4_000_000_000n);
  assert.equal(result.cachedInputCostNanos, 100_000_000n);
  assert.equal(result.outputCostNanos, 30_000_000_000n);
  assert.equal(result.totalCostNanos, 34_100_000_000n);
});

test("calculates Claude cache reads separately from standard input", async () => {
  const spend = await loadSpend();
  const result = spend.calculateLlmCostNanos({
    provider: "claude",
    model: "claude-sonnet-4-6",
    inputTokens: 1_000_000,
    cacheReadTokens: 500_000,
    outputTokens: 1_000_000,
  });

  assert.equal(result.pricingStatus, "priced");
  assert.equal(result.inputCostNanos, 3_000_000_000n);
  assert.equal(result.cachedInputCostNanos, 150_000_000n);
  assert.equal(result.outputCostNanos, 15_000_000_000n);
  assert.equal(result.totalCostNanos, 18_150_000_000n);
});

test("does not turn an unpriced provider response into account spend", async () => {
  const spend = await loadSpend();
  const result = spend.calculateLlmCostNanos({
    provider: "openai",
    model: "unknown-future-model",
    inputTokens: 10,
    outputTokens: 20,
  });

  assert.equal(result.pricingStatus, "unpriced");
  assert.equal(result.totalCostNanos, 0n);
});

test("creates every newly crossed $100 milestone exactly once", async () => {
  const spend = await loadSpend();
  assert.deepEqual(
    spend.nextSpendMilestones(99_000_000_000n, 251_000_000_000n),
    [1, 2],
  );
  assert.deepEqual(
    spend.nextSpendMilestones(200_000_000_000n, 200_500_000_000n),
    [],
  );
});

test("uses a locked account-state row and a unique milestone constraint", () => {
  const migrationPath = join(
    backendRoot,
    "migrations/20260709_04_admin_spend_reports.sql",
  );
  assert.ok(existsSync(migrationPath), "expected the spend migration to exist");
  const migration = readFileSync(migrationPath, "utf8");
  assert.match(migration, /unique\s*\(account_key,\s*milestone_number\)/i);

  const source = readFileSync(spendModulePath, "utf8");
  assert.match(source, /for update/i);
});

test("reads the account dashboard with a GPT/Claude breakdown and next $100 threshold", async () => {
  const spend = await loadSpend();
  const database = {
    async query(sql: string) {
      if (sql.includes("llm_spend_account_state")) {
        return {
          rows: [
            {
              account_key: "docket",
              total_cost_nanos: "251000000000",
              gpt_cost_nanos: "151000000000",
              claude_cost_nanos: "100000000000",
            },
          ],
        };
      }
      if (sql.includes("llm_spend_reports")) {
        return {
          rows: [
            {
              id: "report-2",
              account_key: "docket",
              milestone_number: 2,
              threshold_nanos: "200000000000",
              reported_total_nanos: "251000000000",
              gpt_cost_nanos: "151000000000",
              claude_cost_nanos: "100000000000",
              delivery_status: "sent",
              created_at: "2026-07-09T12:00:00.000Z",
            },
          ],
        };
      }
      throw new Error(`Unexpected dashboard query: ${sql}`);
    },
  };

  const dashboard = await spend.getAdminSpendDashboard({
    database,
    limit: 10,
  });

  assert.equal(dashboard.totalNanos, 251_000_000_000n);
  assert.equal(dashboard.gptNanos, 151_000_000_000n);
  assert.equal(dashboard.claudeNanos, 100_000_000_000n);
  assert.equal(dashboard.nextMilestoneNumber, 3);
  assert.equal(dashboard.nextThresholdNanos, 300_000_000_000n);
  assert.equal(dashboard.reports[0]?.deliveryStatus, "sent");
});

test("serializes the admin dashboard into the frontend spend-report contract", async () => {
  const spend = await loadSpend();
  const serialized = spend.serializeAdminSpendDashboard({
    accountKey: "docket",
    totalNanos: 251_000_000_000n,
    gptNanos: 151_000_000_000n,
    claudeNanos: 100_000_000_000n,
    totalUsd: 251,
    gptUsd: 151,
    claudeUsd: 100,
    nextMilestoneNumber: 3,
    nextThresholdNanos: 300_000_000_000n,
    nextThresholdUsd: 300,
    reports: [
      {
        id: "report-2",
        accountKey: "docket",
        milestoneNumber: 2,
        thresholdNanos: 200_000_000_000n,
        totalNanos: 251_000_000_000n,
        gptNanos: 151_000_000_000n,
        claudeNanos: 100_000_000_000n,
        deliveryStatus: "sent",
        createdAt: "2026-07-09T12:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(serialized, {
    totalUsd: 251,
    gptUsd: 151,
    claudeUsd: 100,
    nextThresholdUsd: 300,
    reports: [
      {
        id: "report-2",
        milestoneNumber: 2,
        thresholdUsd: 200,
        totalUsd: 251,
        gptUsd: 151,
        claudeUsd: 100,
        deliveryStatus: "sent",
        createdAt: "2026-07-09T12:00:00.000Z",
      },
    ],
  });
  assert.doesNotThrow(() => JSON.stringify(serialized));
});

test("normalizes database report timestamps to ISO strings", async () => {
  const spend = await loadSpend();
  const database = {
    async query(sql: string) {
      if (sql.includes("llm_spend_account_state")) {
        return {
          rows: [
            {
              account_key: "docket",
              total_cost_nanos: "100000000000",
              gpt_cost_nanos: "100000000000",
              claude_cost_nanos: "0",
            },
          ],
        };
      }
      return {
        rows: [
          {
            id: "report-1",
            account_key: "docket",
            milestone_number: 1,
            threshold_nanos: "100000000000",
            reported_total_nanos: "100000000000",
            gpt_cost_nanos: "100000000000",
            claude_cost_nanos: "0",
            delivery_status: "sent",
            created_at: new Date("2026-07-09T12:00:00.000Z"),
          },
        ],
      };
    },
  };

  const dashboard = await spend.getAdminSpendDashboard({ database });
  assert.equal(dashboard.reports[0]?.createdAt, "2026-07-09T12:00:00.000Z");
});

test("records unconfigured report delivery without invoking a mailer", async () => {
  const spend = await loadSpend();
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const database = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("from llm_spend_reports")) {
        return {
          rows: [
            {
              id: "report-1",
              account_key: "docket",
              milestone_number: 1,
              threshold_nanos: "100000000000",
              reported_total_nanos: "103000000000",
              gpt_cost_nanos: "73000000000",
              claude_cost_nanos: "30000000000",
              delivery_status: "pending",
              created_at: "2026-07-09T12:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("from app_users")) {
        return { rows: [{ id: "admin-1", email: "admin@example.test" }] };
      }
      return { rows: [] };
    },
  };
  let sent = 0;

  const result = await spend.deliverSpendReport("report-1", {
    database,
    env: {},
    sendEmail: async () => {
      sent += 1;
      return { id: "should-not-send" };
    },
  });

  assert.equal(sent, 0);
  assert.equal(result.status, "not_configured");
  assert.equal(result.deliveries[0]?.status, "not_configured");
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes("llm_spend_report_deliveries") &&
        query.values?.includes("not_configured"),
    ),
  );
});

test("sends each pending admin delivery with a stable idempotency key", async () => {
  const spend = await loadSpend();
  const database = {
    async query(sql: string) {
      if (sql.includes("from llm_spend_reports")) {
        return {
          rows: [
            {
              id: "report-1",
              account_key: "docket",
              milestone_number: 1,
              threshold_nanos: "100000000000",
              reported_total_nanos: "103000000000",
              gpt_cost_nanos: "73000000000",
              claude_cost_nanos: "30000000000",
              delivery_status: "pending",
              created_at: "2026-07-09T12:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("from app_users")) {
        return { rows: [{ id: "admin-1", email: "admin@example.test" }] };
      }
      if (sql.includes("returning status")) {
        return { rows: [{ status: "pending" }] };
      }
      return { rows: [] };
    },
  };
  const sent: Array<{
    from: string;
    to: string;
    subject: string;
    text: string;
    idempotencyKey: string;
  }> = [];

  const result = await spend.deliverSpendReport("report-1", {
    database,
    env: {
      RESEND_API_KEY: "test-only-key",
      SPEND_REPORT_FROM: "Docket <reports@example.test>",
    },
    sendEmail: async (message: (typeof sent)[number]) => {
      sent.push(message);
      return { id: "resend-1" };
    },
  });

  assert.equal(result.status, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, "admin@example.test");
  assert.match(sent[0]?.idempotencyKey ?? "", /report-1/);
  assert.match(sent[0]?.text ?? "", /GPT models: \$73\.00/);
  assert.match(sent[0]?.text ?? "", /Claude models: \$30\.00/);
  assert.doesNotMatch(sent[0]?.text ?? "", /prompt|api key/i);
});

test("records both GPT and Claude usage before mirroring exact costs to PostHog", () => {
  const openAiSource = readFileSync(
    join(backendRoot, "src/lib/llm/openai.ts"),
    "utf8",
  );
  const claudeSource = readFileSync(
    join(backendRoot, "src/lib/llm/claude.ts"),
    "utf8",
  );
  const posthogSource = readFileSync(
    join(backendRoot, "src/lib/posthog.ts"),
    "utf8",
  );
  const keysSource = readFileSync(
    join(backendRoot, "src/lib/userApiKeys.ts"),
    "utf8",
  );

  assert.match(openAiSource, /recordLlmUsage\(/);
  assert.match(claudeSource, /recordLlmUsage\(/);
  assert.match(openAiSource, /deliverSpendReport\(/);
  assert.match(claudeSource, /deliverSpendReport\(/);
  assert.match(posthogSource, /\$ai_input_cost_usd/);
  assert.match(posthogSource, /\$ai_output_cost_usd/);
  assert.match(posthogSource, /\$ai_total_cost_usd/);
  assert.match(keysSource, /sources:/);
  assert.doesNotMatch(
    readFileSync(spendModulePath, "utf8"),
    /encrypted_key|apiKeys|\$ai_input\s*:/i,
  );
});
