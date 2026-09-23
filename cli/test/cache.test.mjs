import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearCache, createCachePlugin, readCache, writeCache } from "../src/cache.mjs";

test("token cache persists atomically with private directory and file modes", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "docket-cli-test-"));
  const cachePath = path.join(temporary, "docket", "msal-cache.json");
  try {
    await writeCache(cachePath, '{"token":"first"}');
    assert.equal((await fs.stat(path.dirname(cachePath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(cachePath)).mode & 0o777, 0o600);
    assert.equal(await readCache(cachePath), '{"token":"first"}');
    await writeCache(cachePath, '{"token":"second"}');
    assert.equal(await readCache(cachePath), '{"token":"second"}');
    await clearCache(cachePath);
    assert.equal(await readCache(cachePath), null);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("token cache rejects broad permissions and symlinks", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "docket-cli-test-"));
  const cachePath = path.join(temporary, "cache.json");
  const linkPath = path.join(temporary, "cache-link.json");
  try {
    await fs.writeFile(cachePath, "{}", { mode: 0o644 });
    await assert.rejects(readCache(cachePath), /permissions are too broad/);
    await fs.chmod(cachePath, 0o600);
    await fs.symlink(cachePath, linkPath);
    await assert.rejects(readCache(linkPath), /regular file/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("MSAL cache plugin round trips serialized state", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "docket-cli-test-"));
  const cachePath = path.join(temporary, "docket", "msal-cache.json");
  try {
    const plugin = createCachePlugin(cachePath);
    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => "serialized-state" },
    });
    let restored;
    await plugin.beforeCacheAccess({ tokenCache: { deserialize: (value) => { restored = value; } } });
    assert.equal(restored, "serialized-state");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
