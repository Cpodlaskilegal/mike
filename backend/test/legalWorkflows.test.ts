import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { LEGAL_WORKFLOWS, LEGAL_WORKFLOW_VERSION } from "../src/lib/legalWorkflows";
import { SYSTEM_ASSISTANT_WORKFLOWS, SYSTEM_WORKFLOW_IDS } from "../src/lib/systemWorkflows";
import { buildWorkflowZip } from "../src/lib/workflowExport";

test("legal workflows are available through the existing catalog and portable export", async () => {
    for (const workflow of LEGAL_WORKFLOWS) {
        assert.ok(SYSTEM_WORKFLOW_IDS.has(workflow.id));
        assert.equal(
            SYSTEM_ASSISTANT_WORKFLOWS.find((item) => item.id === workflow.id)?.prompt_md,
            workflow.prompt_md,
        );
        assert.equal(workflow.version, LEGAL_WORKFLOW_VERSION);
        assert.ok(workflow.description);
        const zip = await JSZip.loadAsync(await buildWorkflowZip(workflow));
        const prompt = await zip.file("SKILL.md")!.async("string");
        assert.equal(prompt.trim(), workflow.prompt_md);
        // Export must carry the usable procedure, never a reference to a private runtime.
        assert.doesNotMatch(prompt, /\/Users\/|\/mnt\/|\/workspace\/|agent_0|skill_0|memstore_|vlt_|@podlaskilegal\.com|app\.box\.com\/s\//);
        assert.match(prompt, /Selecting a workflow grants no additional access or authority/);
        assert.match(prompt, /Do not require a connector to work from uploads/);
        assert.match(prompt, /known error "unverified" does not cure it/);
    }
});
