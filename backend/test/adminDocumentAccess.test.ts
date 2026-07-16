import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ensureDocAccess } from "../src/lib/access";
import type { createServerSupabase } from "../src/lib/supabase";

type Db = ReturnType<typeof createServerSupabase>;

function adminAccessDb(): Db {
  return {
    from(table: string) {
      const filters = new Map<string, unknown>();
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          filters.set(column, value);
          return query;
        },
        async single() {
          if (table === "projects" && filters.get("id") === "project-1") {
            return {
              data: {
                id: "project-1",
                user_id: "owner-1",
                shared_with: [],
              },
              error: null,
            };
          }
          return { data: null, error: { message: "not found" } };
        },
        async maybeSingle() {
          if (table === "app_users" && filters.get("id") === "admin-1") {
            return { data: { role: "admin" }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return query;
    },
  } as unknown as Db;
}

test("admin read access grants another user's project document", async () => {
  const access = await ensureDocAccess(
    { user_id: "owner-1", project_id: "project-1" },
    "admin-1",
    "admin@example.com",
    adminAccessDb(),
    { allowAdmin: true },
  );

  assert.deepEqual(access, { ok: true, isOwner: false });
});

test("admin read access grants another user's standalone chat document", async () => {
  const access = await ensureDocAccess(
    { user_id: "owner-1", project_id: null },
    "admin-1",
    "admin@example.com",
    adminAccessDb(),
    { allowAdmin: true },
  );

  assert.deepEqual(access, { ok: true, isOwner: false });
});

test("admin document access remains opt-in for mutation callers", async () => {
  const access = await ensureDocAccess(
    { user_id: "owner-1", project_id: "project-1" },
    "admin-1",
    "admin@example.com",
    adminAccessDb(),
  );

  assert.deepEqual(access, { ok: false });
});

test("admin read mode does not grant ordinary users another user's document", async () => {
  const access = await ensureDocAccess(
    { user_id: "owner-1", project_id: "project-1" },
    "member-1",
    "member@example.com",
    adminAccessDb(),
    { allowAdmin: true },
  );

  assert.deepEqual(access, { ok: false });
});

function routeSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing route marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing route marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("every document-byte read route opts into admin access", async () => {
  const [documentsRoute, downloadsRoute] = await Promise.all([
    readFile(new URL("../src/routes/documents.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/downloads.ts", import.meta.url), "utf8"),
  ]);
  const adminOption =
    /ensureDocAccess\([\s\S]*?\{\s*allowAdmin:\s*true\s*,?\s*\}\s*,?\s*\)/;
  const readSections = [
    [
      "// GET /single-documents/:documentId/display",
      "// POST /single-documents/download-zip",
    ],
    [
      "// POST /single-documents/download-zip",
      "// GET /single-documents/:documentId/url",
    ],
    [
      "// GET /single-documents/:documentId/url",
      "// GET /single-documents/:documentId/docx",
    ],
    [
      "// GET /single-documents/:documentId/docx",
      "// Compose a download-friendly filename",
    ],
    [
      "// GET /single-documents/:documentId/versions",
      "// POST /single-documents/:documentId/versions",
    ],
    [
      "// GET /single-documents/:documentId/tracked-change-ids",
      "// POST /single-documents/:documentId/edits/:editId/accept",
    ],
  ] as const;

  for (const [start, end] of readSections) {
    assert.match(
      routeSection(documentsRoute, start, end),
      adminOption,
      `${start} must allow admin reads`,
    );
  }
  assert.equal(
    documentsRoute.match(/allowAdmin:\s*true/g)?.length,
    6,
    "only the six document read routes may opt into admin access",
  );
  assert.match(
    downloadsRoute,
    adminOption,
    "token downloads must allow admin reads",
  );
  assert.equal(
    downloadsRoute.match(/allowAdmin:\s*true/g)?.length,
    1,
    "only the token download read route may opt into admin access",
  );
});
