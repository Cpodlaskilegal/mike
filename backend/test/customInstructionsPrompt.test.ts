import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFirmInstructions,
  formatPersonalInstructions,
} from "../src/lib/customInstructionsPrompt";

test("custom instructions keep firm rules at system priority and personal rules at user priority", () => {
  const firm = formatFirmInstructions(" Use the firm's preferred citation style. ");
  const personal = formatPersonalInstructions(" Keep answers concise. ");
  assert.match(firm, /Docket's mandatory citation, tool, authorization, and safety rules remain in force/);
  assert.match(firm, /Firm-wide instructions take priority over personal instructions/);
  assert.match(firm, /cannot grant access to data or tools/);
  assert.match(firm, /Use the firm's preferred citation style/);
  assert.match(personal, /STANDING PERSONAL INSTRUCTIONS/);
  assert.match(personal, /Keep answers concise/);
  assert.doesNotMatch(firm, /Keep answers concise/);
});

test("ordinary and project message assembly include both instruction scopes", async () => {
  const { buildMessages } = await import("../src/lib/chatTools");
  const instructions = {
    firmInstructions: "Use the firm's preferred citation style.",
    personalInstructions: "Keep answers concise.",
  };
  for (const projectContext of [undefined, "PROJECT CONTEXT: matter files are available."]) {
    const built = buildMessages(
      [{ role: "user", content: "Summarize this." }],
      [],
      projectContext,
      undefined,
      false,
      instructions,
    ) as { role: string; content: string }[];
    assert.equal(built[0].role, "system");
    assert.match(built[0].content, /FIRM-WIDE CUSTOM INSTRUCTIONS:/);
    assert.match(built[0].content, /Use the firm's preferred citation style/);
    assert.doesNotMatch(built[0].content, /Keep answers concise/);
    assert.equal(built[1].role, "user");
    assert.match(built[1].content, /Keep answers concise/);
    assert.equal(built[2].content, "Summarize this.");
    if (projectContext) assert.match(built[0].content, /PROJECT CONTEXT: matter files/);
  }
});

test("empty custom instructions leave the existing system prompt intact", async () => {
  const { buildMessages } = await import("../src/lib/chatTools");
  const original = buildMessages([], []) as { content: string }[];
  const empty = buildMessages([], [], undefined, undefined, false, {
    firmInstructions: " ",
    personalInstructions: "",
  }) as { content: string }[];
  assert.equal(empty[0].content, original[0].content);
  assert.equal(empty.length, original.length);
});

test("tabular chat uses firm system rules and separate personal preferences", async () => {
  const { buildTabularMessages } = await import("../src/routes/tabular");
  const built = buildTabularMessages(
    [{ role: "user", content: "Summarize the table." }],
    { columns: [], documents: [], cells: new Map() },
    "Matter Review",
    {
      firmInstructions: "Use firm terminology.",
      personalInstructions: "Keep the summary short.",
    },
  ) as { role: string; content: string }[];
  assert.equal(built[0].role, "system");
  assert.match(built[0].content, /Use firm terminology/);
  assert.doesNotMatch(built[0].content, /Keep the summary short/);
  assert.equal(built[1].role, "user");
  assert.match(built[1].content, /Keep the summary short/);
  assert.equal(built[2].content, "Summarize the table.");
});
