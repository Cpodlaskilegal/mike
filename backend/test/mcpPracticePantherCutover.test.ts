import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureDefaultMcpConnectors,
  isPrimaryPracticePantherConnector,
  isRetiredPracticePantherConnector,
  managedMcpAuthType,
  practicePantherMcpServerUrl,
} from "../src/lib/mcp/defaults";
import type { Db } from "../src/lib/mcp/types";

const legacyUrl = "https://wild-spark-qn7iy.run.mcp-use.com/mcp";
const userUrl = "https://per-user.example.com/mcp";

function withEnvironment(values: Record<string, string | undefined>, run: () => void) {
  const before = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("per-user PracticePanther endpoint becomes the managed OAuth primary", () => {
  withEnvironment(
    { PRACTICEPANTHER_USER_MCP_SERVER_URL: userUrl },
    () => {
      assert.equal(practicePantherMcpServerUrl(), userUrl);
      assert.equal(managedMcpAuthType("practicepanther"), "oauth");
      assert.equal(
        isPrimaryPracticePantherConnector({
          server_url: userUrl,
          auth_type: "oauth",
          tool_policy: { managedConnector: "practicepanther" },
        }),
        true,
      );
      assert.equal(
        isRetiredPracticePantherConnector({
          server_url: legacyUrl,
          auth_type: "none",
          tool_policy: { managedConnector: "practicepanther" },
        }),
        true,
      );
      assert.equal(
        isRetiredPracticePantherConnector({
          server_url: `${legacyUrl}/`,
          auth_type: "none",
          tool_policy: {},
        }),
        true,
      );
    },
  );
});

test("an invalid or legacy per-user URL never falls back to shared identity", () => {
  for (const configured of [legacyUrl, `${legacyUrl}/`, "http://per-user.example.com/mcp"]) {
    withEnvironment(
      { PRACTICEPANTHER_USER_MCP_SERVER_URL: configured },
      () => {
        assert.equal(practicePantherMcpServerUrl(), null);
        assert.equal(managedMcpAuthType("practicepanther"), "oauth");
        assert.equal(
          isRetiredPracticePantherConnector({
            server_url: legacyUrl,
            auth_type: "none",
            tool_policy: { managedConnector: "practicepanther" },
          }),
          true,
        );
      },
    );
  }
});

test("legacy mode remains available until the per-user endpoint is configured", () => {
  withEnvironment(
    {
      PRACTICEPANTHER_USER_MCP_SERVER_URL: undefined,
      PRACTICEPANTHER_MCP_SERVER_URL: legacyUrl,
    },
    () => {
      assert.equal(practicePantherMcpServerUrl(), legacyUrl);
      assert.equal(managedMcpAuthType("practicepanther"), "none");
      assert.equal(
        isRetiredPracticePantherConnector({
          server_url: legacyUrl,
          auth_type: "none",
          tool_policy: { managedConnector: "practicepanther" },
        }),
        false,
      );
    },
  );
});

test("cutover disables the shared connector and upgrades an existing per-user row", async () => {
  const previousUserUrl = process.env.PRACTICEPANTHER_USER_MCP_SERVER_URL;
  const previousBoxEnabled = process.env.BOX_MCP_ENABLED;
  process.env.PRACTICEPANTHER_USER_MCP_SERVER_URL = userUrl;
  process.env.BOX_MCP_ENABLED = "false";
  const rows: Record<string, unknown>[] = [
    {
      id: "old",
      user_id: "user-1",
      server_url: legacyUrl,
      name: "PracticePanther MCP",
      auth_type: "none",
      enabled: true,
      tool_policy: { managedConnector: "practicepanther" },
      encrypted_auth_config: null,
    },
    {
      id: "new",
      user_id: "user-1",
      server_url: userUrl,
      name: "Custom PracticePanther",
      auth_type: "bearer",
      enabled: false,
      tool_policy: {},
      encrypted_auth_config: "stale-bearer",
      auth_config_iv: "iv",
      auth_config_tag: "tag",
    },
  ];
  const tools = [{ id: "tool-1", connector_id: "new" }];

  function query(
    table: string,
    operation: "select" | "update" = "select",
    patch: Record<string, unknown> = {},
  ) {
    const filters: Array<[string, unknown]> = [];
    let head = false;
    const matching = () => {
      const source = table === "user_mcp_connectors" ? rows : tools;
      return source.filter((row) =>
        filters.every(([column, value]) => row[column] === value),
      );
    };
    const run = () => {
      const data = matching();
      if (operation === "update") data.forEach((row) => Object.assign(row, patch));
      return { data: head ? null : data, count: head ? data.length : null, error: null };
    };
    const builder = {
      select(_columns: string, options?: { head?: boolean }) {
        head = options?.head ?? false;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      update(values: Record<string, unknown>) {
        return query(table, "update", values);
      },
      async maybeSingle() {
        const result = run();
        return { ...result, data: matching()[0] ?? null };
      },
      then(resolve: (value: ReturnType<typeof run>) => unknown) {
        return Promise.resolve(run()).then(resolve);
      },
    };
    return builder;
  }
  const db = { from: (table: string) => query(table) } as unknown as Db;

  try {
    await ensureDefaultMcpConnectors("user-1", db);
    assert.equal(rows[0].enabled, false);
    assert.equal(rows[1].enabled, true);
    assert.equal(rows[1].auth_type, "oauth");
    assert.equal(rows[1].encrypted_auth_config, null);
    assert.equal(rows[1].auth_config_iv, null);
    assert.equal(rows[1].auth_config_tag, null);
    assert.deepEqual(rows[1].tool_policy, {
      managedBy: "backend",
      managedConnector: "practicepanther",
    });
  } finally {
    if (previousUserUrl === undefined) delete process.env.PRACTICEPANTHER_USER_MCP_SERVER_URL;
    else process.env.PRACTICEPANTHER_USER_MCP_SERVER_URL = previousUserUrl;
    if (previousBoxEnabled === undefined) delete process.env.BOX_MCP_ENABLED;
    else process.env.BOX_MCP_ENABLED = previousBoxEnabled;
  }
});

test("PracticePanther status ignores legacy and other users' OAuth tokens", async () => {
  process.env.DATABASE_URL ??= "postgres://docket:unused@127.0.0.1:5432/docket";
  const { getUserPracticePantherAuthStatus } = await import("../src/lib/mcp/servers");
  const previousUserUrl = process.env.PRACTICEPANTHER_USER_MCP_SERVER_URL;
  const previousBoxEnabled = process.env.BOX_MCP_ENABLED;
  process.env.PRACTICEPANTHER_USER_MCP_SERVER_URL = userUrl;
  process.env.BOX_MCP_ENABLED = "false";
  const rows: Record<string, unknown>[] = [
    {
      id: "legacy-1",
      user_id: "user-1",
      server_url: legacyUrl,
      name: "PracticePanther MCP",
      auth_type: "none",
      enabled: true,
      tool_policy: { managedConnector: "practicepanther" },
    },
    {
      id: "primary-1",
      user_id: "user-1",
      server_url: userUrl,
      name: "PracticePanther MCP",
      auth_type: "oauth",
      enabled: true,
      tool_policy: { managedBy: "backend", managedConnector: "practicepanther" },
    },
  ];
  const tokens: Record<string, unknown>[] = [
    { connector_id: "legacy-1", encrypted_access_token: "old-token" },
    { connector_id: "primary-2", encrypted_access_token: "other-user-token" },
  ];
  const tools: Record<string, unknown>[] = [{ connector_id: "primary-1" }];
  const db = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let patch: Record<string, unknown> | null = null;
      let head = false;
      const source =
        table === "user_mcp_connectors"
          ? rows
          : table === "user_mcp_oauth_tokens"
            ? tokens
            : tools;
      const matching = () =>
        source.filter((row) =>
          filters.every(([column, value]) => row[column] === value),
        );
      const result = () => {
        const data = matching();
        if (patch) data.forEach((row) => Object.assign(row, patch));
        return { data: head ? null : data, count: head ? data.length : null, error: null };
      };
      const builder = {
        select(_columns: string, options?: { head?: boolean }) {
          head = options?.head ?? false;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        limit(_count: number) {
          return builder;
        },
        update(values: Record<string, unknown>) {
          patch = values;
          return builder;
        },
        async maybeSingle() {
          return { ...result(), data: matching()[0] ?? null };
        },
        then(resolve: (value: ReturnType<typeof result>) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as Db;

  try {
    assert.deepEqual(await getUserPracticePantherAuthStatus("user-1", db), {
      required: true,
      configured: true,
      connected: false,
      connectorId: "primary-1",
    });
    tokens.push({ connector_id: "primary-1", encrypted_access_token: "new-token" });
    assert.deepEqual(await getUserPracticePantherAuthStatus("user-1", db), {
      required: true,
      configured: true,
      connected: true,
      connectorId: "primary-1",
    });
    assert.equal(rows[0].enabled, false);
  } finally {
    if (previousUserUrl === undefined) delete process.env.PRACTICEPANTHER_USER_MCP_SERVER_URL;
    else process.env.PRACTICEPANTHER_USER_MCP_SERVER_URL = previousUserUrl;
    if (previousBoxEnabled === undefined) delete process.env.BOX_MCP_ENABLED;
    else process.env.BOX_MCP_ENABLED = previousBoxEnabled;
  }
});
