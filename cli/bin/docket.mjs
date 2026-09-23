#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  const json = process.argv.includes("--json");
  const message = error instanceof Error ? error.message : "Unknown error";
  if (json) {
    process.stderr.write(`${JSON.stringify({
      error: message,
      ...(error.status ? { status: error.status } : {}),
      ...(error.code ? { code: error.code } : {}),
      ...(error.chatId ? { chatId: error.chatId } : {}),
      ...(error.runId ? { runId: error.runId } : {}),
    })}\n`);
  } else {
    process.stderr.write(`docket: ${message}\n`);
    if (error.chatId) process.stderr.write(`Chat ID: ${error.chatId}\n`);
  }
  process.exitCode = 1;
}
