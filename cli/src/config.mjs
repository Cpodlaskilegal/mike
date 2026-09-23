import os from "node:os";
import path from "node:path";

const DEFAULTS = Object.freeze({
  tenantId: "93fa5a2e-4598-4c6e-86f9-6092f6b8c0c4",
  clientId: "009d6299-45e1-42d5-ad79-47a575081a8a",
  apiScope: "api://f1642f2c-5548-48b7-8010-7c15a424e105/access_as_user",
  apiBaseUrl: "https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io",
});

export function loadConfig(env = process.env) {
  const apiBaseUrl = (env.DOCKET_API_BASE_URL || DEFAULTS.apiBaseUrl).replace(/\/+$/, "");
  const url = new URL(apiBaseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("DOCKET_API_BASE_URL must be HTTPS (or HTTP localhost), without credentials, query, or fragment");
  }

  const configRoot = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return {
    tenantId: env.DOCKET_TENANT_ID || DEFAULTS.tenantId,
    clientId: env.DOCKET_CLIENT_ID || DEFAULTS.clientId,
    apiScope: env.DOCKET_API_SCOPE || DEFAULTS.apiScope,
    apiBaseUrl,
    cachePath: env.DOCKET_CACHE_PATH || path.join(configRoot, "docket", "msal-cache.json"),
  };
}

export { DEFAULTS };
