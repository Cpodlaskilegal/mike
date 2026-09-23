import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Docket cache directory must be a regular directory");
  }
  await fs.chmod(directory, 0o700);
}

export async function readCache(cachePath) {
  let stat;
  try {
    stat = await fs.lstat(cachePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Docket token cache must be a regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Docket token cache permissions are too broad; run chmod 600 ${cachePath}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Docket token cache belongs to another user");
  }
  return fs.readFile(cachePath, "utf8");
}

export async function writeCache(cachePath, contents) {
  const directory = path.dirname(cachePath);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.msal-cache-${process.pid}-${randomBytes(6).toString("hex")}`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, cachePath);
    await fs.chmod(cachePath, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function clearCache(cachePath) {
  try {
    await fs.unlink(cachePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function createCachePlugin(cachePath) {
  return {
    async beforeCacheAccess(context) {
      const contents = await readCache(cachePath);
      if (contents) context.tokenCache.deserialize(contents);
    },
    async afterCacheAccess(context) {
      if (context.cacheHasChanged) {
        await writeCache(cachePath, context.tokenCache.serialize());
      }
    },
  };
}
