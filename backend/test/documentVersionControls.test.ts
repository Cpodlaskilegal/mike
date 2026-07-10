import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

async function frontendSource(relativePath: string): Promise<string> {
  return readFile(
    new URL(`../../frontend/${relativePath}`, import.meta.url),
    "utf8",
  );
}

test("version-control migration keeps Docket's Entra text identities and soft-delete history", async () => {
  const migration = await source(
    "migrations/20260709_02_document_version_controls_azure.sql",
  );

  assert.match(migration, /alter column storage_path drop not null/i);
  assert.match(migration, /deleted_by text references public\.app_users\(id\)/i);
  assert.doesNotMatch(migration, /deleted_by uuid/i);
  assert.match(migration, /document_versions_active_document_id_idx/i);
});

test("document API exposes owner-gated replace/delete and non-destructive version copy", async () => {
  const route = await source("src/routes/documents.ts");

  assert.match(
    route,
    /\/:documentId\/versions\/:versionId\/copy/,
    "copy endpoint must be present",
  );
  assert.match(
    route,
    /\/:documentId\/versions\/:versionId\/file/,
    "replace endpoint must be present",
  );
  assert.match(
    route,
    /documentsRouter\.delete\(\s*"\/:documentId\/versions\/:versionId"/s,
    "delete endpoint must be present",
  );
  assert.match(route, /Replace a version's bytes in place while retaining its identity/i);
  assert.match(route, /This is owner-only because it rewrites historical evidence/i);
  assert.match(route, /if \(!access\.ok \|\| !access\.isOwner\)/);
  assert.match(route, /Cannot delete the only document version/i);
  assert.match(route, /deleted_at: deletedAt/);
  assert.match(route, /deleted_by: userId/);
  assert.match(route, /Copy of \$\{sourceFilename\}/);
});

test("active-version lookup excludes tombstoned files while history retains them", async () => {
  const versions = await source("src/lib/documentVersions.ts");
  const route = await source("src/routes/documents.ts");

  assert.match(versions, /v\.deleted_at/);
  assert.match(versions, /\.is\("deleted_at", null\)/);
  assert.match(route, /select\(VERSION_ROW_SELECT\)/);
  assert.match(route, /\.is\("deleted_at", null\)/);
});

test("Docket client exposes the version controls and court-opinion panel", async () => {
  const [api, projectPage, panel, message] = await Promise.all([
    frontendSource("src/app/lib/docketApi.ts"),
    frontendSource("src/app/components/projects/ProjectPage.tsx"),
    frontendSource("src/app/components/assistant/CaseLawPanel.tsx"),
    frontendSource("src/app/components/assistant/AssistantMessage.tsx"),
  ]);

  assert.match(api, /copyDocumentVersion/);
  assert.match(api, /replaceDocumentVersionFile/);
  assert.match(api, /deleteDocumentVersion/);
  assert.match(projectPage, /Copy as a new current version/);
  assert.match(projectPage, /Replace this version file/);
  assert.match(panel, /getCourtlistenerOpinions/);
  assert.match(panel, /dangerouslySetInnerHTML/);
  assert.match(message, /onCaseCitationClick/);
});
