import assert from "node:assert/strict";
import test from "node:test";

// userDataLifecycle imports the Azure/Postgres adapter, which validates that a
// database URL exists when the module is loaded. These tests exercise only its
// pure policy functions and never open a database connection.
process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
process.env.NODE_ENV = "test";
process.env.PGSSLMODE = "disable";

function loadLifecycle() {
  return import("../src/lib/userDataLifecycle");
}

test("data export scopes and filenames are bounded", async () => {
  const lifecycle = await loadLifecycle();
  assert.equal(lifecycle.parseDataExportScope("account"), "account");
  assert.equal(lifecycle.parseDataExportScope("chats"), "chats");
  assert.equal(lifecycle.parseDataExportScope("everything"), null);
  assert.equal(lifecycle.parseDataExportScope(["account"]), null);

  const filename = lifecycle.dataExportFilename("account", "entra/subject:123");
  assert.match(filename, /^docket-account-export-entrasubject-\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(filename, /[/:]/);
});

test("data deletion requires explicit Docket-only confirmation", async () => {
  const lifecycle = await loadLifecycle();
  assert.deepEqual(lifecycle.validateDeletionRequestBody({}), {
    ok: false,
    detail: "confirmation must equal DELETE DOCKET DATA",
  });
  assert.deepEqual(
    lifecycle.validateDeletionRequestBody({
      confirmation: lifecycle.DATA_DELETION_CONFIRMATION,
      reason: "  Close Docket workspace  ",
    }),
    { ok: true, reason: "Close Docket workspace" },
  );
});

test("data export redaction removes nested credential material", async () => {
  const lifecycle = await loadLifecycle();
  assert.deepEqual(
    lifecycle.redactSensitiveExportData({
      title: "Matter",
      api_key: "sk-secret",
      nested: {
        refresh_token: "token",
        safe: ["visible", { encrypted_auth_config: "ciphertext" }],
      },
    }),
    {
      title: "Matter",
      api_key: "[redacted]",
      nested: {
        refresh_token: "[redacted]",
        safe: ["visible", { encrypted_auth_config: "[redacted]" }],
      },
    },
  );
});

test("legal hold review requires a retention date", async () => {
  const lifecycle = await loadLifecycle();
  assert.deepEqual(
    lifecycle.validateDeletionReviewBody({
      status: "approved",
      legalHold: true,
    }),
    { ok: false, detail: "retentionUntil is required when legalHold is true" },
  );
  assert.deepEqual(
    lifecycle.validateDeletionReviewBody({
      status: "approved",
      legalHold: true,
      retentionUntil: "2030-01-01T00:00:00.000Z",
      decisionNote: "Matter hold expires at review date.",
      workflowSubmissionDisposition: "anonymize",
    }),
    {
      ok: true,
      status: "approved",
      legalHold: true,
      retentionUntil: "2030-01-01T00:00:00.000Z",
      decisionNote: "Matter hold expires at review date.",
      workflowSubmissionDisposition: "anonymize",
    },
  );
});

test("workflow submission retention needs an explicit safe disposition", async () => {
  const lifecycle = await loadLifecycle();
  assert.deepEqual(
    lifecycle.validateDeletionReviewBody({
      status: "rejected",
      legalHold: false,
    }),
    {
      ok: true,
      status: "rejected",
      legalHold: false,
      retentionUntil: null,
      decisionNote: null,
      workflowSubmissionDisposition: "retain",
    },
  );
  assert.deepEqual(
    lifecycle.validateDeletionReviewBody({
      status: "approved",
      legalHold: false,
      workflowSubmissionDisposition: "forget",
    }),
    {
      ok: false,
      detail:
        "workflowSubmissionDisposition must be retain, anonymize, or delete when supplied",
    },
  );
});
