import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  projectWorkspaceHref,
  projectWorkspaceTabFromLegacyQuery,
} from "../../frontend/src/app/components/projects/projectWorkspace";

test("project workspace uses stable canonical routes while accepting legacy tab links", () => {
  assert.equal(projectWorkspaceHref("project/1", "documents"), "/projects/project%2F1");
  assert.equal(projectWorkspaceHref("project-1", "assistant"), "/projects/project-1/assistant");
  assert.equal(
    projectWorkspaceHref("project-1", "reviews"),
    "/projects/project-1/tabular-reviews",
  );
  assert.equal(
    projectWorkspaceTabFromLegacyQuery("assistant", "documents"),
    "assistant",
  );
  assert.equal(
    projectWorkspaceTabFromLegacyQuery("untrusted", "reviews"),
    "reviews",
  );
});

test("project workspace component delegates tab navigation to the shared route helper", async () => {
  const source = await readFile(
    resolve(
      new URL("..", import.meta.url).pathname,
      "../frontend/src/app/components/projects/ProjectPage.tsx",
    ),
    "utf8",
  );
  assert.match(source, /projectWorkspaceHref\(projectId, newTab\)/);
  assert.match(source, /projectWorkspaceTabFromLegacyQuery\(tabParam, initialTab\)/);
  assert.match(source, /tabs=\{PROJECT_WORKSPACE_TABS\}/);
});
