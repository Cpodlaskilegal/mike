import type { PoolClient } from "pg";
import { Resend } from "resend";
import { safeErrorMessage } from "./safeError";
import { pool } from "./supabase";

export const NANOS_PER_USD = 1_000_000_000n;
export const SPEND_REPORT_INTERVAL_NANOS = 100n * NANOS_PER_USD;
export const DOCKET_ACCOUNT_KEY = "docket";

export type SpendProvider = "openai" | "claude";
export type BillingSource = "account" | "user_api_key";
export type PricingStatus = "priced" | "unpriced";

type PricePerMillion = {
  input: bigint;
  cachedInput: bigint;
  output: bigint;
};

const MILLION = 1_000_000n;

function usdPerMillion(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  const paddedFraction = `${fraction}000000000`.slice(0, 9);
  return BigInt(whole) * NANOS_PER_USD + BigInt(paddedFraction);
}

const PRICE_PER_MILLION: Record<string, PricePerMillion> = {
  "gpt-5.6-sol": {
    input: usdPerMillion("5"),
    cachedInput: usdPerMillion("0.5"),
    output: usdPerMillion("30"),
  },
  "gpt-5.6-terra": {
    input: usdPerMillion("2.5"),
    cachedInput: usdPerMillion("0.25"),
    output: usdPerMillion("15"),
  },
  "gpt-5.6-luna": {
    input: usdPerMillion("1"),
    cachedInput: usdPerMillion("0.1"),
    output: usdPerMillion("6"),
  },
  "gpt-5.5": {
    input: usdPerMillion("5"),
    cachedInput: usdPerMillion("0.5"),
    output: usdPerMillion("30"),
  },
  "gpt-5.5-pro": {
    input: usdPerMillion("30"),
    cachedInput: 0n,
    output: usdPerMillion("180"),
  },
  "gpt-5.4": {
    input: usdPerMillion("2.5"),
    cachedInput: usdPerMillion("0.25"),
    output: usdPerMillion("15"),
  },
  "gpt-5.4-mini": {
    input: usdPerMillion("0.75"),
    cachedInput: usdPerMillion("0.075"),
    output: usdPerMillion("4.5"),
  },
  "gpt-5.4-nano": {
    input: usdPerMillion("0.2"),
    cachedInput: usdPerMillion("0.02"),
    output: usdPerMillion("1.25"),
  },
  "claude-fable-5": {
    input: usdPerMillion("10"),
    cachedInput: usdPerMillion("1"),
    output: usdPerMillion("50"),
  },
  "claude-mythos-5": {
    input: usdPerMillion("10"),
    cachedInput: usdPerMillion("1"),
    output: usdPerMillion("50"),
  },
  "claude-opus-4-8": {
    input: usdPerMillion("5"),
    cachedInput: usdPerMillion("0.5"),
    output: usdPerMillion("25"),
  },
  "claude-opus-4-7": {
    input: usdPerMillion("5"),
    cachedInput: usdPerMillion("0.5"),
    output: usdPerMillion("25"),
  },
  "claude-sonnet-4-6": {
    input: usdPerMillion("3"),
    cachedInput: usdPerMillion("0.3"),
    output: usdPerMillion("15"),
  },
  "claude-sonnet-4-5": {
    input: usdPerMillion("3"),
    cachedInput: usdPerMillion("0.3"),
    output: usdPerMillion("15"),
  },
  "claude-haiku-4-5": {
    input: usdPerMillion("1"),
    cachedInput: usdPerMillion("0.1"),
    output: usdPerMillion("5"),
  },
};

export type LlmCostInput = {
  provider: SpendProvider;
  model: string;
  inputTokens: number;
  cachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  outputTokens: number;
};

export type LlmCost = {
  pricingStatus: PricingStatus;
  inputCostNanos: bigint;
  cachedInputCostNanos: bigint;
  outputCostNanos: bigint;
  totalCostNanos: bigint;
};

function tokenCost(tokens: number, pricePerMillion: bigint): bigint {
  if (!Number.isFinite(tokens) || tokens <= 0 || pricePerMillion <= 0n) {
    return 0n;
  }
  return (BigInt(Math.trunc(tokens)) * pricePerMillion) / MILLION;
}

function positiveInteger(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.trunc(value ?? 0)
    : 0;
}

export function providerCategory(provider: SpendProvider): "gpt" | "claude" {
  return provider === "openai" ? "gpt" : "claude";
}

export function calculateLlmCostNanos(input: LlmCostInput): LlmCost {
  const pricing = PRICE_PER_MILLION[input.model];
  if (!pricing) {
    return {
      pricingStatus: "unpriced",
      inputCostNanos: 0n,
      cachedInputCostNanos: 0n,
      outputCostNanos: 0n,
      totalCostNanos: 0n,
    };
  }

  const inputTokens = positiveInteger(input.inputTokens);
  const outputTokens = positiveInteger(input.outputTokens);
  const cachedInputTokens = positiveInteger(input.cachedInputTokens);
  const cacheReadTokens = positiveInteger(input.cacheReadTokens);
  const cacheCreation5mTokens = positiveInteger(input.cacheCreation5mTokens);
  const cacheCreation1hTokens = positiveInteger(input.cacheCreation1hTokens);

  const regularInputTokens =
    input.provider === "openai"
      ? Math.max(
          inputTokens -
            cachedInputTokens -
            cacheCreation5mTokens -
            cacheCreation1hTokens,
          0,
        )
      : inputTokens;
  const inputCostNanos = tokenCost(regularInputTokens, pricing.input);
  const cachedInputCostNanos =
    tokenCost(cachedInputTokens + cacheReadTokens, pricing.cachedInput) +
    tokenCost(cacheCreation5mTokens, (pricing.input * 125n) / 100n) +
    tokenCost(cacheCreation1hTokens, pricing.input * 2n);
  const outputCostNanos = tokenCost(outputTokens, pricing.output);

  return {
    pricingStatus: "priced",
    inputCostNanos,
    cachedInputCostNanos,
    outputCostNanos,
    totalCostNanos:
      inputCostNanos + cachedInputCostNanos + outputCostNanos,
  };
}

export function nextSpendMilestones(
  previousTotalNanos: bigint,
  nextTotalNanos: bigint,
): number[] {
  if (nextTotalNanos <= previousTotalNanos) return [];
  const previousMilestone = previousTotalNanos / SPEND_REPORT_INTERVAL_NANOS;
  const nextMilestone = nextTotalNanos / SPEND_REPORT_INTERVAL_NANOS;
  const milestones: number[] = [];
  for (
    let milestone = previousMilestone + 1n;
    milestone <= nextMilestone;
    milestone += 1n
  ) {
    milestones.push(Number(milestone));
  }
  return milestones;
}

export function spendUsd(nanos: bigint): number {
  return Number(nanos) / Number(NANOS_PER_USD);
}

export function formatSpendUsd(nanos: bigint): string {
  return spendUsd(nanos).toFixed(2);
}

export type LlmUsageContext = {
  userId?: string;
  route?: string;
  chatId?: string | null;
  projectId?: string | null;
};

export type RecordLlmUsageInput = LlmCostInput & {
  providerResponseId: string;
  billingSource: BillingSource;
  context?: LlmUsageContext;
};

export type SpendReport = {
  id: string;
  accountKey: string;
  milestoneNumber: number;
  thresholdNanos: bigint;
  totalNanos: bigint;
  gptNanos: bigint;
  claudeNanos: bigint;
  deliveryStatus: "pending" | "sent" | "not_configured" | "failed";
  createdAt: string;
};

export type AdminSpendDashboard = {
  accountKey: string;
  totalNanos: bigint;
  gptNanos: bigint;
  claudeNanos: bigint;
  totalUsd: number;
  gptUsd: number;
  claudeUsd: number;
  nextMilestoneNumber: number;
  nextThresholdNanos: bigint;
  nextThresholdUsd: number;
  reports: SpendReport[];
};

export type SerializedAdminSpendDashboard = {
  totalUsd: number;
  gptUsd: number;
  claudeUsd: number;
  nextThresholdUsd: number;
  reports: Array<{
    id: string;
    milestoneNumber: number;
    thresholdUsd: number;
    totalUsd: number;
    gptUsd: number;
    claudeUsd: number;
    deliveryStatus: SpendReport["deliveryStatus"];
    createdAt: string;
  }>;
};

export type SpendReportDeliveryStatus =
  | "pending"
  | "sent"
  | "not_configured"
  | "failed";

export type SpendReportDelivery = {
  adminUserId: string | null;
  recipientEmail: string;
  status: SpendReportDeliveryStatus;
  resendEmailId: string | null;
  deliveryError: string | null;
};

export type SpendReportDeliveryResult = {
  report: SpendReport | null;
  status: SpendReportDeliveryStatus | "not_found";
  deliveries: SpendReportDelivery[];
  error: string | null;
};

type SpendReportDatabase = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type SpendReportEmailMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
};

export type SpendReportEmailSender = (
  message: SpendReportEmailMessage,
) => Promise<{ id?: string; error?: { message?: string } | null }>;

type SpendReportDeliveryOptions = {
  database?: SpendReportDatabase;
  env?: Record<string, string | undefined>;
  sendEmail?: SpendReportEmailSender;
};

type AccountStateRow = {
  account_key: string;
  total_cost_nanos: string | number | bigint;
  gpt_cost_nanos: string | number | bigint;
  claude_cost_nanos: string | number | bigint;
};

type SpendReportRow = {
  id: string;
  account_key: string;
  milestone_number: number;
  threshold_nanos: string | number | bigint;
  reported_total_nanos: string | number | bigint;
  gpt_cost_nanos: string | number | bigint;
  claude_cost_nanos: string | number | bigint;
  delivery_status: SpendReport["deliveryStatus"];
  created_at: string | Date;
};

type AdminRecipientRow = {
  id: string;
  email: string;
};

type SpendReportDeliveryRow = {
  admin_user_id: string | null;
  recipient_email: string;
  status: SpendReportDeliveryStatus;
  resend_email_id: string | null;
  delivery_error: string | null;
};

type SpendReportDeliveryConfig = {
  apiKey: string;
  from: string;
};

function asBigInt(value: string | number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

function timestampToIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function spendReportFromRow(row: SpendReportRow): SpendReport {
  return {
    id: row.id,
    accountKey: row.account_key,
    milestoneNumber: Number(row.milestone_number),
    thresholdNanos: asBigInt(row.threshold_nanos),
    totalNanos: asBigInt(row.reported_total_nanos),
    gptNanos: asBigInt(row.gpt_cost_nanos),
    claudeNanos: asBigInt(row.claude_cost_nanos),
    deliveryStatus: row.delivery_status,
    createdAt: timestampToIso(row.created_at),
  };
}

function defaultSpendReportDatabase(): SpendReportDatabase {
  return {
    query(text, values) {
      return pool.query(text, values);
    },
  };
}

function reportLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 25;
  return Math.min(Math.max(Math.trunc(value ?? 25), 1), 100);
}

function emptyAccountState(): AccountStateRow {
  return {
    account_key: DOCKET_ACCOUNT_KEY,
    total_cost_nanos: 0n,
    gpt_cost_nanos: 0n,
    claude_cost_nanos: 0n,
  };
}

export async function getAdminSpendDashboard(options: {
  database?: SpendReportDatabase;
  limit?: number;
} = {}): Promise<AdminSpendDashboard> {
  const database = options.database ?? defaultSpendReportDatabase();
  const limit = reportLimit(options.limit);
  const stateResult = await database.query(
    `select account_key, total_cost_nanos, gpt_cost_nanos, claude_cost_nanos
       from llm_spend_account_state
      where account_key = $1`,
    [DOCKET_ACCOUNT_KEY],
  );
  const state =
    (stateResult.rows[0] as AccountStateRow | undefined) ?? emptyAccountState();
  const reportsResult = await database.query(
    `select id, account_key, milestone_number, threshold_nanos,
            reported_total_nanos, gpt_cost_nanos, claude_cost_nanos,
            delivery_status, created_at
       from llm_spend_reports
      where account_key = $1
      order by milestone_number desc
      limit $2`,
    [DOCKET_ACCOUNT_KEY, limit],
  );
  const totalNanos = asBigInt(state.total_cost_nanos);
  const gptNanos = asBigInt(state.gpt_cost_nanos);
  const claudeNanos = asBigInt(state.claude_cost_nanos);
  const nextMilestoneNumber = Number(totalNanos / SPEND_REPORT_INTERVAL_NANOS) + 1;
  const nextThresholdNanos =
    BigInt(nextMilestoneNumber) * SPEND_REPORT_INTERVAL_NANOS;

  return {
    accountKey: state.account_key,
    totalNanos,
    gptNanos,
    claudeNanos,
    totalUsd: spendUsd(totalNanos),
    gptUsd: spendUsd(gptNanos),
    claudeUsd: spendUsd(claudeNanos),
    nextMilestoneNumber,
    nextThresholdNanos,
    nextThresholdUsd: spendUsd(nextThresholdNanos),
    reports: reportsResult.rows.map((row) =>
      spendReportFromRow(row as SpendReportRow),
    ),
  };
}

export function serializeAdminSpendDashboard(
  dashboard: AdminSpendDashboard,
): SerializedAdminSpendDashboard {
  return {
    totalUsd: dashboard.totalUsd,
    gptUsd: dashboard.gptUsd,
    claudeUsd: dashboard.claudeUsd,
    nextThresholdUsd: dashboard.nextThresholdUsd,
    reports: dashboard.reports.map((report) => ({
      id: report.id,
      milestoneNumber: report.milestoneNumber,
      thresholdUsd: spendUsd(report.thresholdNanos),
      totalUsd: spendUsd(report.totalNanos),
      gptUsd: spendUsd(report.gptNanos),
      claudeUsd: spendUsd(report.claudeNanos),
      deliveryStatus: report.deliveryStatus,
      createdAt: report.createdAt,
    })),
  };
}

export async function getSpendReport(
  reportId: string,
  options: { database?: SpendReportDatabase } = {},
): Promise<SpendReport | null> {
  if (!reportId.trim()) return null;
  const database = options.database ?? defaultSpendReportDatabase();
  const result = await database.query(
    `select id, account_key, milestone_number, threshold_nanos,
            reported_total_nanos, gpt_cost_nanos, claude_cost_nanos,
            delivery_status, created_at
       from llm_spend_reports
      where id = $1 and account_key = $2`,
    [reportId, DOCKET_ACCOUNT_KEY],
  );
  const row = result.rows[0] as SpendReportRow | undefined;
  return row ? spendReportFromRow(row) : null;
}

export function getSpendReportDeliveryConfig(
  env: Record<string, string | undefined> = process.env,
): SpendReportDeliveryConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.SPEND_REPORT_FROM?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

export function spendReportDeliveryIdempotencyKey(
  reportId: string,
  adminUserId: string,
): string {
  return `docket-spend-report/${reportId}/${adminUserId}`;
}

export function spendReportEmailText(report: SpendReport): string {
  return [
    "Docket account LLM spend report",
    "",
    `Milestone reached: $${formatSpendUsd(report.thresholdNanos)}`,
    `Recorded account spend: $${formatSpendUsd(report.totalNanos)}`,
    `GPT models: $${formatSpendUsd(report.gptNanos)}`,
    `Claude models: $${formatSpendUsd(report.claudeNanos)}`,
    "",
    "This report covers Docket-managed GPT and Claude model usage at published pricing. User-supplied provider usage is excluded.",
  ].join("\n");
}

function createResendSender(config: SpendReportDeliveryConfig): SpendReportEmailSender {
  const resend = new Resend(config.apiKey);
  return async (message) => {
    const result = await resend.emails.send(
      {
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      },
      { idempotencyKey: message.idempotencyKey },
    );
    if (result.error) {
      return { error: { message: result.error.message } };
    }
    return { id: result.data?.id };
  };
}

function deliveryFromRow(row: SpendReportDeliveryRow): SpendReportDelivery {
  return {
    adminUserId: row.admin_user_id,
    recipientEmail: row.recipient_email,
    status: row.status,
    resendEmailId: row.resend_email_id,
    deliveryError: row.delivery_error,
  };
}

async function activeAdminRecipients(
  database: SpendReportDatabase,
): Promise<AdminRecipientRow[]> {
  const result = await database.query(
    `select id, email
       from app_users
      where role = 'admin'
        and docket_data_status = 'active'
        and nullif(trim(email), '') is not null
      order by created_at asc`,
  );
  return result.rows as AdminRecipientRow[];
}

async function upsertSpendReportDelivery(
  database: SpendReportDatabase,
  report: SpendReport,
  recipient: AdminRecipientRow,
  status: SpendReportDeliveryStatus,
): Promise<SpendReportDelivery> {
  const result = await database.query(
    `insert into llm_spend_report_deliveries (
       report_id, admin_user_id, recipient_email, status
     ) values ($1, $2, $3, $4)
     on conflict (report_id, recipient_email) do update
       set admin_user_id = excluded.admin_user_id,
           status = case
             when llm_spend_report_deliveries.status = 'sent' then 'sent'
             else excluded.status
           end,
           delivery_error = case
             when llm_spend_report_deliveries.status = 'sent'
               then llm_spend_report_deliveries.delivery_error
             else null
           end,
           updated_at = now()
     returning admin_user_id, recipient_email, status, resend_email_id,
               delivery_error`,
    [report.id, recipient.id, recipient.email, status],
  );
  const row = result.rows[0] as SpendReportDeliveryRow | undefined;
  return row
    ? deliveryFromRow(row)
    : {
        adminUserId: recipient.id,
        recipientEmail: recipient.email,
        status,
        resendEmailId: null,
        deliveryError: null,
      };
}

async function recordDeliveryAttempt(
  database: SpendReportDatabase,
  reportId: string,
  recipientEmail: string,
): Promise<void> {
  await database.query(
    `update llm_spend_report_deliveries
        set status = 'pending',
            attempt_count = attempt_count + 1,
            delivery_error = null,
            updated_at = now()
      where report_id = $1 and recipient_email = $2`,
    [reportId, recipientEmail],
  );
}

async function recordDeliveryOutcome(
  database: SpendReportDatabase,
  reportId: string,
  recipientEmail: string,
  status: Extract<SpendReportDeliveryStatus, "sent" | "failed">,
  resendEmailId: string | null,
  deliveryError: string | null,
): Promise<void> {
  await database.query(
    `update llm_spend_report_deliveries
        set status = $3,
            resend_email_id = $4,
            delivery_error = $5,
            delivered_at = case when $3 = 'sent' then now() else null end,
            updated_at = now()
      where report_id = $1 and recipient_email = $2`,
    [reportId, recipientEmail, status, resendEmailId, deliveryError],
  );
}

async function recordReportDeliveryStatus(
  database: SpendReportDatabase,
  reportId: string,
  status: SpendReportDeliveryStatus,
  deliveryError: string | null,
): Promise<void> {
  await database.query(
    `update llm_spend_reports
        set delivery_status = $2,
            delivery_error = $3,
            delivered_at = case when $2 = 'sent' then coalesce(delivered_at, now()) else delivered_at end
      where id = $1`,
    [reportId, status, deliveryError],
  );
}

function safeDeliveryError(error: unknown): string {
  return safeErrorMessage(error, "Spend report delivery failed").slice(0, 1000);
}

export async function deliverSpendReport(
  reportId: string,
  options: SpendReportDeliveryOptions = {},
): Promise<SpendReportDeliveryResult> {
  const database = options.database ?? defaultSpendReportDatabase();
  let report: SpendReport | null = null;
  try {
    report = await getSpendReport(reportId, { database });
    if (!report) {
      return {
        report: null,
        status: "not_found",
        deliveries: [],
        error: null,
      };
    }

    const recipients = await activeAdminRecipients(database);
    if (!recipients.length) {
      const error = "No active Docket administrators are available for this report.";
      await recordReportDeliveryStatus(database, report.id, "failed", error);
      return { report, status: "failed", deliveries: [], error };
    }

    const config = getSpendReportDeliveryConfig(options.env);
    if (!config) {
      const deliveries = await Promise.all(
        recipients.map((recipient) =>
          upsertSpendReportDelivery(database, report!, recipient, "not_configured"),
        ),
      );
      const error = "Spend report email delivery is not configured.";
      await recordReportDeliveryStatus(
        database,
        report.id,
        "not_configured",
        error,
      );
      return { report, status: "not_configured", deliveries, error };
    }

    const sendEmail = options.sendEmail ?? createResendSender(config);
    const deliveries: SpendReportDelivery[] = [];
    for (const recipient of recipients) {
      const delivery = await upsertSpendReportDelivery(
        database,
        report,
        recipient,
        "pending",
      );
      if (delivery.status === "sent") {
        deliveries.push(delivery);
        continue;
      }

      await recordDeliveryAttempt(database, report.id, recipient.email);
      try {
        const result = await sendEmail({
          from: config.from,
          to: recipient.email,
          subject: `Docket account spend report: $${formatSpendUsd(report.thresholdNanos)} milestone`,
          text: spendReportEmailText(report),
          idempotencyKey: spendReportDeliveryIdempotencyKey(report.id, recipient.id),
        });
        if (result.error) {
          const error = safeDeliveryError(result.error.message);
          await recordDeliveryOutcome(
            database,
            report.id,
            recipient.email,
            "failed",
            null,
            error,
          );
          deliveries.push({
            ...delivery,
            status: "failed",
            deliveryError: error,
          });
          continue;
        }

        await recordDeliveryOutcome(
          database,
          report.id,
          recipient.email,
          "sent",
          result.id ?? null,
          null,
        );
        deliveries.push({
          ...delivery,
          status: "sent",
          resendEmailId: result.id ?? null,
          deliveryError: null,
        });
      } catch (error) {
        const message = safeDeliveryError(error);
        await recordDeliveryOutcome(
          database,
          report.id,
          recipient.email,
          "failed",
          null,
          message,
        );
        deliveries.push({
          ...delivery,
          status: "failed",
          deliveryError: message,
        });
      }
    }

    const status = deliveries.every((delivery) => delivery.status === "sent")
      ? "sent"
      : "failed";
    const error = status === "sent" ? null : "One or more administrator deliveries failed.";
    await recordReportDeliveryStatus(database, report.id, status, error);
    return { report, status, deliveries, error };
  } catch (error) {
    const message = safeDeliveryError(error);
    if (report) {
      await recordReportDeliveryStatus(database, report.id, "failed", message).catch(
        () => undefined,
      );
    }
    return { report, status: "failed", deliveries: [], error: message };
  }
}

async function lockAccountState(client: PoolClient): Promise<AccountStateRow> {
  await client.query(
    `insert into llm_spend_account_state (account_key)
     values ($1)
     on conflict (account_key) do nothing`,
    [DOCKET_ACCOUNT_KEY],
  );
  const state = await client.query<AccountStateRow>(
    `select account_key, total_cost_nanos, gpt_cost_nanos, claude_cost_nanos
       from llm_spend_account_state
      where account_key = $1
      for update`,
    [DOCKET_ACCOUNT_KEY],
  );
  const row = state.rows[0];
  if (!row) throw new Error("Unable to lock the Docket account spend state");
  return row;
}

export async function recordLlmUsage(input: RecordLlmUsageInput): Promise<{
  inserted: boolean;
  cost: LlmCost;
  newReports: SpendReport[];
}> {
  const cost = calculateLlmCostNanos(input);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{ id: string }>(
      `insert into llm_usage_events (
        account_key, provider, model, provider_response_id, billing_source,
        cost_status, input_tokens, cached_input_tokens, cache_read_tokens,
        cache_creation_5m_tokens, cache_creation_1h_tokens, output_tokens,
        input_cost_nanos, cached_input_cost_nanos, output_cost_nanos,
        total_cost_nanos, user_id, route, chat_id, project_id
      ) values (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15,
        $16, $17, $18, $19, $20
      ) on conflict (provider, provider_response_id) do nothing
      returning id`,
      [
        DOCKET_ACCOUNT_KEY,
        input.provider,
        input.model,
        input.providerResponseId,
        input.billingSource,
        cost.pricingStatus,
        positiveInteger(input.inputTokens),
        positiveInteger(input.cachedInputTokens),
        positiveInteger(input.cacheReadTokens),
        positiveInteger(input.cacheCreation5mTokens),
        positiveInteger(input.cacheCreation1hTokens),
        positiveInteger(input.outputTokens),
        cost.inputCostNanos.toString(),
        cost.cachedInputCostNanos.toString(),
        cost.outputCostNanos.toString(),
        cost.totalCostNanos.toString(),
        input.context?.userId ?? null,
        input.context?.route ?? null,
        input.context?.chatId ?? null,
        input.context?.projectId ?? null,
      ],
    );
    if (!inserted.rowCount) {
      await client.query("commit");
      return { inserted: false, cost, newReports: [] };
    }

    if (input.billingSource !== "account" || cost.pricingStatus !== "priced") {
      await client.query("commit");
      return { inserted: true, cost, newReports: [] };
    }

    const state = await lockAccountState(client);
    const previousTotalNanos = asBigInt(state.total_cost_nanos);
    const previousGptNanos = asBigInt(state.gpt_cost_nanos);
    const previousClaudeNanos = asBigInt(state.claude_cost_nanos);
    const category = providerCategory(input.provider);
    const nextTotalNanos = previousTotalNanos + cost.totalCostNanos;
    const nextGptNanos =
      previousGptNanos + (category === "gpt" ? cost.totalCostNanos : 0n);
    const nextClaudeNanos =
      previousClaudeNanos +
      (category === "claude" ? cost.totalCostNanos : 0n);

    await client.query(
      `update llm_spend_account_state
          set total_cost_nanos = $2,
              gpt_cost_nanos = $3,
              claude_cost_nanos = $4,
              updated_at = now()
        where account_key = $1`,
      [
        DOCKET_ACCOUNT_KEY,
        nextTotalNanos.toString(),
        nextGptNanos.toString(),
        nextClaudeNanos.toString(),
      ],
    );

    const newReports: SpendReport[] = [];
    for (const milestoneNumber of nextSpendMilestones(
      previousTotalNanos,
      nextTotalNanos,
    )) {
      const report = await client.query<SpendReportRow>(
        `insert into llm_spend_reports (
          account_key, milestone_number, threshold_nanos, reported_total_nanos,
          gpt_cost_nanos, claude_cost_nanos
        ) values ($1, $2, $3, $4, $5, $6)
        on conflict (account_key, milestone_number) do nothing
        returning id, account_key, milestone_number, threshold_nanos,
                  reported_total_nanos, gpt_cost_nanos, claude_cost_nanos,
                  delivery_status, created_at`,
        [
          DOCKET_ACCOUNT_KEY,
          milestoneNumber,
          (BigInt(milestoneNumber) * SPEND_REPORT_INTERVAL_NANOS).toString(),
          nextTotalNanos.toString(),
          nextGptNanos.toString(),
          nextClaudeNanos.toString(),
        ],
      );
      if (report.rows[0]) newReports.push(spendReportFromRow(report.rows[0]));
    }

    await client.query("commit");
    return { inserted: true, cost, newReports };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
