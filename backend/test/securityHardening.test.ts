import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const backendRoot = new URL("..", import.meta.url).pathname;

function pickPort(): number {
  return 39000 + Math.floor(Math.random() * 1000);
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("Backend health check did not become ready");
}

async function withBackend(
  env: NodeJS.ProcessEnv,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const port = pickPort();
  const child: ChildProcessWithoutNullStreams = spawn(
    "./node_modules/.bin/tsx",
    ["src/index.ts"],
    {
      cwd: backendRoot,
      env: {
        ...process.env,
        DATABASE_URL: "postgres://docket:unused@127.0.0.1:5432/docket",
        NODE_ENV: "test",
        PGSSLMODE: "disable",
        ...env,
        PORT: String(port),
      },
      stdio: "pipe",
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    await waitForHealth(port);
    await run(`http://127.0.0.1:${port}`);
  } catch (error) {
    throw new Error(`${String(error)}\nBackend output:\n${output}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }
}

test("API health responses carry a restrictive default CSP", async () => {
  await withBackend({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(response.headers.get("content-security-policy") ?? "", /base-uri 'none'/);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  });
});

test("account deletion has a dedicated rate limit before authentication", async () => {
  await withBackend(
    {
      RATE_LIMIT_GENERAL_MAX: "1000",
      RATE_LIMIT_DATA_DELETE_MAX: "1",
      RATE_LIMIT_DATA_DELETE_WINDOW_HOURS: "1",
    },
    async (baseUrl) => {
      const first = await fetch(`${baseUrl}/user/account`, {
        method: "DELETE",
      });
      const second = await fetch(`${baseUrl}/user/account`, {
        method: "DELETE",
      });

      assert.equal(first.status, 401);
      assert.equal(second.status, 429);
      const body = (await second.json()) as { detail?: unknown };
      assert.equal(body.detail, "Too many data deletion requests. Please try again later.");
    },
  );
});
