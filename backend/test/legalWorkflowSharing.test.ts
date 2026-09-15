import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import express, { type RequestHandler } from "express";
import ts from "typescript";

const legalIds = [
  "builtin-legal-drafting",
  "builtin-surgical-redline",
  "builtin-legal-research",
  "builtin-citation-audit",
  "builtin-legal-draft-review",
  "builtin-matter-brief",
];

const identities = {
  existing: { id: "ordinary-existing", email: "existing@example.test" },
  newcomer: { id: "ordinary-new", email: "new@example.test" },
};

type Row = Record<string, unknown>;

function databaseFixture() {
  const queries: Array<{ table: string; filters: Map<string, unknown> }> = [];
  const rows: Record<string, Row[]> = {
    workflows: [
      {
        id: "existing-private",
        user_id: identities.existing.id,
        is_system: false,
        type: "assistant",
        title: "Existing user's private workflow",
        prompt_md: "Private instructions",
      },
      {
        id: "outsider-private",
        user_id: "ordinary-outsider",
        is_system: false,
        type: "assistant",
        title: "An unrelated user's private workflow",
        prompt_md: "Other private instructions",
      },
    ],
    // Neither user has any share grants, including for the six legal workflows.
    workflow_shares: [],
    hidden_workflows: [
      { user_id: identities.existing.id, workflow_id: legalIds[0] },
    ],
    workflow_open_source_submissions: [],
  };
  return {
    queries,
    db: {
      from(table: string) {
        assert.ok(table in rows, `Unexpected table access: ${table}`);
        const filters = new Map<string, unknown>();
        const included = new Map<string, unknown[]>();
        function execute(single = false) {
          queries.push({ table, filters: new Map(filters) });
          const matches = rows[table].filter(
            (row) => [...filters].every(([column, value]) => row[column] === value)
              && [...included].every(([column, values]) => values.includes(row[column])),
          );
          return { data: single ? matches[0] ?? null : matches, error: null };
        }
        const query = {
          select() { return query; },
          eq(column: string, value: unknown) { filters.set(column, value); return query; },
          in(column: string, values: unknown[]) { included.set(column, values); return query; },
          order() { return query; },
          limit() { return query; },
          single: async () => execute(true),
          maybeSingle: async () => execute(true),
          then(resolve: (value: ReturnType<typeof execute>) => unknown) {
            return Promise.resolve(execute()).then(resolve);
          },
        };
        // No write methods or administrative user-list methods are provided.
        return query;
      },
    },
  };
}

async function withWorkflowApi(
  run: (baseUrl: string, fixture: ReturnType<typeof databaseFixture>) => Promise<void>,
) {
  const fixture = databaseFixture();
  const sourcePath = fileURLToPath(new URL("../src/routes/workflows.ts", import.meta.url));
  const moduleRequire = createRequire(sourcePath);
  // Load the actual route module in isolation, following workflowRuntime.test.
  // Only the Entra boundary and database are replaced; this does not test JWT
  // verification or create real accounts. Both identities have ordinary access.
  const requireAuth: RequestHandler = (req, res, next) => {
    const key = req.headers["x-test-identity"];
    const identity = typeof key === "string" && key in identities
      ? identities[key as keyof typeof identities]
      : null;
    if (!identity) return void res.status(401).json({ detail: "Authentication required" });
    res.locals.userId = identity.id;
    res.locals.userEmail = identity.email;
    next();
  };
  const isolatedRequire = Object.assign((id: string) => {
    if (id === "../middleware/auth") return { requireAuth };
    if (id === "../lib/supabase") return { createServerSupabase: () => fixture.db };
    return moduleRequire(id);
  }, { resolve: moduleRequire.resolve });
  const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const isolatedModule = { exports: {} };
  new Function("require", "module", "exports", "__dirname", "__filename", compiled.outputText)(
    isolatedRequire, isolatedModule, isolatedModule.exports, dirname(sourcePath), sourcePath,
  );
  const { workflowsRouter } = isolatedModule.exports as typeof import("../src/routes/workflows");
  const app = express();
  app.use("/workflows", workflowsRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`, fixture);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function assertSharedAssistant(workflow: Row) {
  assert.equal(workflow.type, "assistant");
  assert.equal(workflow.is_system, true);
  assert.equal(workflow.user_id, null);
  assert.equal(workflow.allow_edit, false);
  assert.equal(workflow.is_owner, false);
  assert.equal(workflow.shared_by_name, null);
  assert.ok(typeof workflow.prompt_md === "string" && workflow.prompt_md.trim());
}

test("the real workflow list gives all six legal Assistants to existing and new ordinary users without share grants", async () => {
  await withWorkflowApi(async (baseUrl, fixture) => {
    for (const identity of ["existing", "newcomer"] as const) {
      for (const suffix of ["", "?type=assistant"]) {
        const response = await fetch(`${baseUrl}/workflows${suffix}`, {
          headers: { "x-test-identity": identity },
        });
        assert.equal(response.status, 200);
        const workflows = await response.json() as Row[];
        const legal = workflows.filter((workflow) => legalIds.includes(String(workflow.id)));
        assert.deepEqual(legal.map((workflow) => workflow.id), legalIds);
        legal.forEach(assertSharedAssistant);
        assert.equal(workflows.some((workflow) => workflow.id === "outsider-private"), false);
        assert.equal(
          workflows.some((workflow) => workflow.id === "existing-private"),
          identity === "existing",
        );
        if (identity === "newcomer") assert.ok(workflows.every((workflow) => workflow.is_system));
      }
    }
    assert.equal(fixture.queries.filter((query) => query.table === "workflow_shares").length, 4);
    assert.ok(fixture.queries.every((query) => ["workflows", "workflow_shares"].includes(query.table)));
  });
});

test("both ordinary users can read every legal Assistant detail without a user or share database lookup", async () => {
  await withWorkflowApi(async (baseUrl, fixture) => {
    for (const identity of ["existing", "newcomer"]) {
      for (const workflowId of legalIds) {
        const response = await fetch(`${baseUrl}/workflows/${workflowId}`, {
          headers: { "x-test-identity": identity },
        });
        assert.equal(response.status, 200);
        const workflow = await response.json() as Row;
        assert.equal(workflow.id, workflowId);
        assertSharedAssistant(workflow);
      }
    }
    assert.deepEqual(fixture.queries, []);
  });
});

test("global legal Assistant availability preserves authentication and private workflow isolation", async () => {
  await withWorkflowApi(async (baseUrl) => {
    for (const path of ["/workflows", `/workflows/${legalIds[0]}`]) {
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 401);
    }
    for (const identity of ["existing", "newcomer"]) {
      const privateResponse = await fetch(`${baseUrl}/workflows/outsider-private`, {
        headers: { "x-test-identity": identity },
      });
      assert.equal(privateResponse.status, 404);
    }
    const otherUserPrivate = await fetch(`${baseUrl}/workflows/existing-private`, {
      headers: { "x-test-identity": "newcomer" },
    });
    assert.equal(otherUserPrivate.status, 404);
  });
});

test("legal workflows stay in Assistant results and personal hiding does not revoke catalog access", async () => {
  await withWorkflowApi(async (baseUrl) => {
    const headers = { "x-test-identity": "existing" };
    const tabularResponse = await fetch(`${baseUrl}/workflows?type=tabular`, { headers });
    assert.equal(tabularResponse.status, 200);
    const tabular = await tabularResponse.json() as Row[];
    assert.ok(tabular.every((workflow) => workflow.type === "tabular"));
    assert.equal(tabular.some((workflow) => legalIds.includes(String(workflow.id))), false);
    const hiddenResponse = await fetch(`${baseUrl}/workflows/hidden`, { headers });
    assert.equal(hiddenResponse.status, 200);
    assert.deepEqual(await hiddenResponse.json(), [legalIds[0]]);
    const detailResponse = await fetch(`${baseUrl}/workflows/${legalIds[0]}`, { headers });
    assert.equal(detailResponse.status, 200);
    assertSharedAssistant(await detailResponse.json() as Row);
  });
});
