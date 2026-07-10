import assert from "node:assert/strict";
import test from "node:test";
import { chatStreamErrorLine } from "../src/lib/chatErrors";
import {
  redactSensitiveText,
  safeErrorLog,
  safeErrorMessage,
} from "../src/lib/safeError";

test("redacts credentials from error messages and stacks before they are logged", () => {

  const secretMessage = [
    "Incorrect API key provided: sk-proj-1234567890abcdefghijklmnop.",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "AZURE_STORAGE_KEY=0123456789abcdef0123456789abcdef",
    "postgres://app:super-secret-password@example.test:5432/docket",
  ].join(" ");
  const error = new Error(secretMessage);
  error.stack = `Error: ${secretMessage}`;

  const redacted = redactSensitiveText(secretMessage);
  const log = safeErrorLog(error);

  for (const secret of [
    "sk-proj-1234567890abcdefghijklmnop",
    "eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "0123456789abcdef0123456789abcdef",
    "super-secret-password",
  ]) {
    assert.doesNotMatch(redacted, new RegExp(secret, "i"));
    assert.doesNotMatch(log.message, new RegExp(secret, "i"));
    assert.doesNotMatch(log.stack ?? "", new RegExp(secret, "i"));
  }
  assert.match(redacted, /\[redacted\]/i);
});

test("uses a generic fallback when an unknown error has no safe message", () => {
  assert.equal(
    safeErrorMessage({ token: "do-not-log-me" }, "Assistant request failed"),
    "Assistant request failed",
  );
});

test("redacts Azure storage connection-string credentials", () => {
  const accountKey = "0123456789abcdefghijklmnopqrstuv";
  const redacted = redactSensitiveText(
    `AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=docket;AccountKey=${accountKey};EndpointSuffix=core.windows.net`,
  );

  assert.doesNotMatch(redacted, new RegExp(accountKey, "i"));
  assert.match(redacted, /\[redacted\]/i);
});

test("SSE assistant errors never echo provider credentials", () => {
  const credential = "sk-proj-1234567890abcdefghijklmnop";
  const line = chatStreamErrorLine(
    new Error(`Incorrect API key provided: ${credential}.`),
  );

  assert.doesNotMatch(line, new RegExp(credential, "i"));
  assert.match(line, /selected model provider/i);
});
