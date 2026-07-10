import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  SYSTEM_ASSISTANT_WORKFLOWS,
  SYSTEM_WORKFLOWS,
} from "../src/lib/systemWorkflows";
import {
  buildWorkflowContributionSnapshot,
  parseWorkflowContributionRequest,
  validateWorkflowForContribution,
  WORKFLOW_CONTRIBUTION_CONFIRMATION,
} from "../src/lib/workflowContributions";

const backendRoot = resolve(new URL("..", import.meta.url).pathname);
const frontendRoot = resolve(backendRoot, "../frontend");

test("Docket's complete current system catalog is backend-owned and stable", () => {
  const expectedIds = [
    "builtin-cp-checklist",
    "builtin-coc-dd",
    "builtin-credit-summary",
    "builtin-commercial-agreement",
    "builtin-credit-agreement",
    "builtin-ediscovery",
    "builtin-supply-agreement",
    "builtin-spa",
    "builtin-nda",
    "builtin-commercial-lease",
    "builtin-lpa",
    "builtin-sha-summary",
    "builtin-shareholder-agreement",
    "builtin-employment-agreement",
  ];
  assert.deepEqual(
    SYSTEM_WORKFLOWS.map((workflow) => workflow.id),
    expectedIds,
  );
  assert.equal(new Set(expectedIds).size, SYSTEM_WORKFLOWS.length);
  assert.equal(SYSTEM_ASSISTANT_WORKFLOWS.length, 3);
  for (const workflow of SYSTEM_WORKFLOWS) {
    assert.equal(workflow.user_id, null);
    assert.equal(workflow.is_system, true);
    if (workflow.type === "assistant") {
      assert.ok(workflow.prompt_md?.trim(), `${workflow.id} needs instructions`);
    } else {
      assert.ok(workflow.columns_config?.length, `${workflow.id} needs columns`);
    }
  }
  assert.equal(
    existsSync(
      resolve(
        frontendRoot,
        "src/app/components/workflows/builtinWorkflows.ts",
      ),
    ),
    false,
    "the frontend must not maintain a second built-in workflow catalog",
  );
});

test("workflow contribution requests require explicit authenticated-review intent", () => {
  assert.deepEqual(parseWorkflowContributionRequest({}), {
    ok: false,
    detail: `confirmation must equal ${WORKFLOW_CONTRIBUTION_CONFIRMATION}`,
  });
  assert.deepEqual(
    parseWorkflowContributionRequest({
      confirmation: WORKFLOW_CONTRIBUTION_CONFIRMATION,
      attribution: "named",
    }),
    {
      ok: false,
      detail: "A public_name is required when named attribution is selected.",
    },
  );

  const parsed = parseWorkflowContributionRequest({
    confirmation: WORKFLOW_CONTRIBUTION_CONFIRMATION,
    attribution: "docket-community",
    public_name: "Do not publish this alias",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.publicName, null);

  const workflow = {
    id: "workflow-1",
    title: "Matter checklist",
    type: "assistant" as const,
    prompt_md: "Review the uploaded matter file.",
    columns_config: null,
    language: "English",
    practice: "Litigation",
    jurisdictions: ["Indiana"],
  };
  assert.equal(validateWorkflowForContribution(workflow), null);
  const snapshot = buildWorkflowContributionSnapshot(workflow, parsed.request);
  assert.equal(snapshot.format, "docket-workflow-contribution/v1");
  assert.deepEqual(snapshot.metadata.attribution, {
    mode: "docket-community",
    name: null,
  });
  assert.equal("id" in snapshot, false);
  assert.equal(JSON.stringify(snapshot).includes("submitted_by_email"), false);
  assert.match(snapshot.skill_md ?? "", /uploaded matter/i);
});

test("selected tabular templates are resolved by the server and preserve workflow provenance", async () => {
  const [tabular, workflowRoute, modal, addModal] = await Promise.all([
    readFile(resolve(backendRoot, "src/routes/tabular.ts"), "utf8"),
    readFile(resolve(backendRoot, "src/routes/workflows.ts"), "utf8"),
    readFile(
      resolve(frontendRoot, "src/app/components/workflows/DisplayWorkflowModal.tsx"),
      "utf8",
    ),
    readFile(
      resolve(frontendRoot, "src/app/components/tabular/AddNewTRModal.tsx"),
      "utf8",
    ),
  ]);

  assert.match(tabular, /SYSTEM_WORKFLOWS\.find/);
  assert.match(tabular, /system_workflow_id:\s*systemWorkflowId/);
  assert.match(tabular, /workflow_id:\s*customWorkflowId/);
  assert.match(tabular, /systemWorkflow\.columns_config/);
  assert.match(workflowRoute, /SYSTEM_WORKFLOWS/);
  assert.match(workflowRoute, /open-source-submissions/);
  assert.match(modal, /workflow_id:\s*wf\.id/);
  assert.match(addModal, /selectedWorkflow\?\.id/);
});

test("contribution migration stays compatible with Azure/Postgres and Entra text identities", async () => {
  const migration = await readFile(
    resolve(
      backendRoot,
      "migrations/20260709_03_workflow_catalog_contributions_azure.sql",
    ),
    "utf8",
  );
  assert.match(migration, /system_workflow_id text/i);
  assert.match(
    migration,
    /submitted_by_user_id text not null references public\.app_users\(id\)/i,
  );
  assert.doesNotMatch(migration, /submitted_by_user_id uuid/i);
  assert.match(migration, /pending_review.*accepted.*declined.*withdrawn/is);
  assert.match(migration, /does not create anonymous writes/i);
});
