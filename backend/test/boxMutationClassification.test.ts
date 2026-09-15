import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://docket:unused@127.0.0.1:5432/docket";
process.env.PGSSLMODE = "disable";
process.env.NODE_ENV = "test";

test("Box metadata writes cannot become reads through contradictory annotations", async () => {
  const { boxToolRequiresApproval } = await import("../src/lib/mcp/boxAccessPolicy");
  for (const name of ["set_file_metadata", "set_folder_metadata"]) {
    assert.equal(boxToolRequiresApproval({
      tool_name: name,
      annotations: { readOnlyHint: true },
      requires_confirmation: false,
    }), true);
  }
});
