import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import express from "express";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Pool } from "pg";
import { resolveTrackedChange } from "../src/lib/docxTrackedChanges";
import { EditResolutionError, resolveDocumentEdit } from "../src/lib/documentEditResolution";

async function fixture() {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:del w:id="1"><w:r><w:delText>old term</w:delText></w:r></w:del><w:ins w:id="2"><w:r><w:t>new term</w:t></w:r></w:ins></w:p></w:body></w:document>`);
  const original = await zip.generateAsync({ type: "nodebuffer" });
  const bytes = new Map<string, Buffer>([["original.docx", original]]);
  let state = {
    current_version_id: "original-version", filename: "synthetic.docx", user_id: "owner",
    file_type: "docx", edit_status: "pending", del_w_id: "1", ins_w_id: "2", storage_path: "original.docx",
    versions: [{ id: "original-version", path: "original.docx" }],
  };
  let before: typeof state | null = null;
  const reports: Array<{ event: string; metadata: Record<string, unknown> }> = [];
  const queries: string[] = [];
  const options = { fail: "", zero: "", commitLost: false, rollbackLost: false, uploadFails: false, race: false };
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push(sql);
    if (options.fail && sql.startsWith(options.fail)) throw new Error("Synthetic database failure");
    if (sql === "BEGIN") { before = structuredClone(state); return { rows: [], rowCount: 0 }; }
    if (sql === "ROLLBACK") {
      if (options.rollbackLost) throw new Error("Synthetic lost rollback response");
      if (before) state = before;
      before = null;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      before = null;
      if (options.commitLost) throw new Error("Synthetic lost commit response");
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT d.current_version_id")) return { rows: [{ ...state }], rowCount: 1 };
    if (sql.startsWith("SELECT count")) return { rows: [{ count: state.edit_status === "pending" ? "1" : "0" }], rowCount: 1 };
    if (sql.includes("FOR UPDATE")) return { rows: [{ id: "locked" }], rowCount: 1 };
    if (options.zero && sql.startsWith(options.zero)) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO document_versions")) {
      state.versions.push({ id: values[0] as string, path: values[2] as string });
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE documents")) {
      state.current_version_id = values[0] as string;
      state.storage_path = state.versions.find(v => v.id === values[0])!.path;
      return { rows: [{ id: "doc" }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE document_edits")) {
      state.edit_status = values[0] as string;
      return { rows: [{ id: "edit" }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  let released: boolean | undefined;
  const deps: Parameters<typeof resolveDocumentEdit>[1] = {
    database: { query, connect: async () => ({ query, release: (discard: boolean) => { released = discard; } }) } as unknown as Pool,
    download: async path => {
      const buffer = bytes.get(path);
      return buffer ? Uint8Array.from(buffer).buffer : null;
    },
    upload: async (path, content) => {
      bytes.set(path, Buffer.from(content));
      if (options.race) { state.current_version_id = "concurrent-version"; state.storage_path = "concurrent.docx"; }
      if (options.uploadFails) throw new Error("Synthetic partial upload failure");
    },
    remove: async path => { bytes.delete(path); },
    resolve: resolveTrackedChange,
    report: (event, metadata) => { reports.push({ event, metadata }); },
  };
  return { deps, options, bytes, original, reports, queries, state: () => state, released: () => released };
}

const input = { documentId: "doc", editId: "edit", mode: "accept" as const };

for (const mode of ["accept", "reject"] as const) {
  test(`${mode} preserves original DOCX and durably activates a resolved version and decision`, async () => {
    const f = await fixture();
    const result = await resolveDocumentEdit({ ...input, mode }, f.deps);
    assert.notEqual(result.version_id, "original-version");
    assert.equal(result.status, mode === "accept" ? "accepted" : "rejected");
    assert.equal(result.remaining_pending, 0);
    assert.deepEqual(f.bytes.get("original.docx"), f.original);
    assert.equal(f.state().current_version_id, result.version_id);
    assert.equal(f.state().edit_status, result.status);
    const resolvedZip = await JSZip.loadAsync(f.bytes.get(result.storage_path)!);
    const xml = await resolvedZip.file("word/document.xml")!.async("string");
    assert.match(xml, mode === "accept" ? /new term/ : /old term/);
    assert.doesNotMatch(xml, /<w:(ins|del)\b/);
    assert.equal(f.queries.filter(sql => sql === "COMMIT").length, 1);
  });
}

for (const operation of ["INSERT INTO document_versions", "UPDATE documents", "UPDATE document_edits", "SELECT count"]) {
  test(`${operation} failure rolls back decision and activation without damaging original bytes`, async () => {
    const f = await fixture(); f.options.fail = operation;
    await assert.rejects(resolveDocumentEdit(input, f.deps), (e: unknown) => e instanceof EditResolutionError && e.status === 503);
    assert.equal(f.state().current_version_id, "original-version");
    assert.equal(f.state().edit_status, "pending");
    assert.equal(f.state().versions.length, 1);
    assert.deepEqual([...f.bytes.keys()], ["original.docx"]);
    assert.deepEqual(f.bytes.get("original.docx"), f.original);
  });
}

for (const operation of ["INSERT INTO document_versions", "UPDATE documents", "UPDATE document_edits"]) {
  test(`${operation} affecting zero rows cannot report success`, async () => {
    const f = await fixture(); f.options.zero = operation;
    await assert.rejects(resolveDocumentEdit(input, f.deps), EditResolutionError);
    assert.equal(f.state().edit_status, "pending");
    assert.equal(f.state().current_version_id, "original-version");
    assert.equal(f.bytes.size, 1);
  });
}

test("partial upload failure preserves prior file and pending edit and cleans staged bytes", async () => {
  const f = await fixture(); f.options.uploadFails = true;
  await assert.rejects(resolveDocumentEdit(input, f.deps), (e: unknown) => e instanceof EditResolutionError && e.code === "DOCUMENT_WRITE_FAILED");
  assert.equal(f.state().edit_status, "pending");
  assert.equal(f.bytes.size, 1);
  assert.equal(f.queries.includes("BEGIN"), false);
});

test("unavailable source leaves decision pending with a retryable error", async () => {
  const f = await fixture(); f.deps.download = async () => null;
  await assert.rejects(resolveDocumentEdit(input, f.deps), (e: unknown) => e instanceof EditResolutionError && e.status === 503);
  assert.equal(f.state().edit_status, "pending");
  assert.equal(f.bytes.size, 1);
});

test("absent tracked markers cannot be accepted through a status-only shortcut", async () => {
  const f = await fixture(); f.state().ins_w_id = "not-present"; f.state().del_w_id = null;
  await assert.rejects(resolveDocumentEdit(input, f.deps), (e: unknown) => e instanceof EditResolutionError && e.code === "TRACKED_CHANGE_MISSING");
  assert.equal(f.state().edit_status, "pending");
  assert.equal(f.queries.includes("BEGIN"), false);
});

test("a concurrent version change is not overwritten by staged resolution", async () => {
  const f = await fixture(); f.options.race = true;
  await assert.rejects(resolveDocumentEdit(input, f.deps), (e: unknown) => e instanceof EditResolutionError && e.code === "DOCUMENT_VERSION_CHANGED");
  assert.equal(f.state().current_version_id, "concurrent-version");
  assert.equal(f.state().edit_status, "pending");
  assert.equal(f.bytes.size, 1);
});

test("retrying an identical decision is idempotent, while opposite decision conflicts", async () => {
  const f = await fixture();
  const first = await resolveDocumentEdit(input, f.deps);
  const retry = await resolveDocumentEdit(input, f.deps);
  assert.equal(retry.already_resolved, true);
  assert.equal(retry.version_id, first.version_id);
  assert.equal(f.bytes.size, 2);
  await assert.rejects(resolveDocumentEdit({ ...input, mode: "reject" }, f.deps), (e: unknown) => e instanceof EditResolutionError && e.status === 409);
});

test("lost COMMIT reply never deletes possibly active bytes and retry discovers durable result", async () => {
  const f = await fixture(); f.options.commitLost = true;
  await assert.rejects(resolveDocumentEdit(input, f.deps), (e: unknown) => e instanceof EditResolutionError && e.code === "EDIT_SAVE_UNCONFIRMED");
  assert.equal(f.state().edit_status, "accepted");
  assert.ok(f.bytes.has(f.state().storage_path));
  assert.deepEqual(f.bytes.get("original.docx"), f.original);
  assert.equal(f.released(), true);
  const recovered = await resolveDocumentEdit(input, f.deps);
  assert.equal(recovered.already_resolved, true);
  assert.equal(f.bytes.size, 2);
  assert.equal(f.reports[0].metadata.commitUncertain, true);
});

test("unconfirmed rollback retains staged bytes and emits reconciliation metadata", async () => {
  const f = await fixture(); f.options.fail = "UPDATE document_edits"; f.options.rollbackLost = true;
  await assert.rejects(resolveDocumentEdit(input, f.deps), EditResolutionError);
  assert.equal(f.bytes.size, 2);
  assert.equal(f.reports[0].metadata.rollbackConfirmed, false);
  assert.equal(f.released(), true);
});

async function withResolutionApi(run: (baseUrl: string, f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  const path = fileURLToPath(new URL("../src/routes/documents.ts", import.meta.url));
  const requireModule = createRequire(path);
  const db = {
    from() {
      const query = {
        select() { return query; }, eq() { return query; },
        maybeSingle: async () => ({ data: { id: "doc", user_id: "owner", project_id: null }, error: null }),
      };
      return query;
    },
  };
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} as { documentsRouter: express.Router } };
  const load = (id: string) => {
    if (id === "../middleware/auth") return { requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => { res.locals.userId = req.headers["x-test-user"] ?? "owner"; next(); } };
    if (id === "../lib/supabase") return { createServerSupabase: () => db, pool: f.deps.database };
    if (id === "../lib/storage") return { downloadFile: f.deps.download, uploadFile: f.deps.upload, deleteFile: f.deps.remove };
    if (id === "../lib/downloadTokens") return { buildDownloadUrl: (key: string) => `https://synthetic.test/${key}` };
    return requireModule(id);
  };
  new Function("require", "module", "exports", compiled)(load, module, module.exports);
  const app = express(); app.use("/single-documents", module.exports.documentsRouter);
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}/single-documents/doc/edits/edit`, f); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("real accept API returns the durable version, and a failed decision returns actionable 503 without false success", async () => {
  await withResolutionApi(async (url, f) => {
    f.options.fail = "UPDATE document_edits";
    const failure = await fetch(`${url}/accept`, { method: "POST" });
    assert.equal(failure.status, 503);
    const error = await failure.json() as { code: string; retryable: boolean };
    assert.equal(error.code, "EDIT_SAVE_UNCONFIRMED"); assert.equal(error.retryable, true);
    assert.equal(f.state().edit_status, "pending"); assert.equal(f.bytes.size, 1);
    f.options.fail = "";
    const success = await fetch(`${url}/accept`, { method: "POST" });
    assert.equal(success.status, 200);
    const result = await success.json() as { ok: boolean; version_id: string; status: string; remaining_pending: number };
    assert.equal(result.ok, true); assert.equal(result.status, "accepted");
    assert.equal(result.version_id, f.state().current_version_id); assert.equal(result.remaining_pending, 0);
  });
});

test("real edit API authorizes mutation before reading or staging bytes", async () => {
  await withResolutionApi(async (url, f) => {
    const response = await fetch(`${url}/reject`, { method: "POST", headers: { "x-test-user": "outsider" } });
    assert.equal(response.status, 404);
    assert.equal(f.queries.length, 0); assert.equal(f.bytes.size, 1); assert.equal(f.state().edit_status, "pending");
  });
});
