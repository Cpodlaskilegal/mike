import { createCachePlugin } from "./cache.mjs";

export async function createAuth(config, { stderr = process.stderr, msalModule } = {}) {
  const msal = msalModule ?? await import("@azure/msal-node");
  const app = new msal.PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
    },
    cache: {
      cachePlugin: createCachePlugin(config.cachePath),
    },
  });
  const scopes = [config.apiScope];

  return {
    async login() {
      const result = await app.acquireTokenByDeviceCode({
        scopes,
        deviceCodeCallback(response) {
          stderr.write(`${response.message}\n`);
        },
      });
      if (!result?.account) throw new Error("Microsoft sign-in did not return an account");
      // The CLI deliberately maintains one signed-in identity at a time.
      for (const account of await app.getTokenCache().getAllAccounts()) {
        if (account.homeAccountId !== result.account.homeAccountId) {
          await app.getTokenCache().removeAccount(account);
        }
      }
      return accountSummary(result.account);
    },
    async token({ forceRefresh = false } = {}) {
      const accounts = await app.getTokenCache().getAllAccounts();
      if (accounts.length === 0) throw new Error("Not signed in. Run docket login.");
      if (accounts.length > 1) throw new Error("Multiple cached accounts found. Run docket logout, then docket login.");
      try {
        const result = await app.acquireTokenSilent({
          account: accounts[0],
          scopes,
          forceRefresh,
        });
        if (!result?.accessToken) throw new Error("No access token returned");
        return result.accessToken;
      } catch (error) {
        if (
          error instanceof msal.InteractionRequiredAuthError ||
          error?.name === "InteractionRequiredAuthError"
        ) {
          throw new Error("Sign-in needs interaction. Run docket login.");
        }
        throw error;
      }
    },
    async account() {
      const accounts = await app.getTokenCache().getAllAccounts();
      if (accounts.length !== 1) throw new Error("Not signed in to one account. Run docket login.");
      return accountSummary(accounts[0]);
    },
  };
}

function accountSummary(account) {
  return {
    username: account.username,
    name: account.name || null,
    tenantId: account.tenantId,
    localAccountId: account.localAccountId,
  };
}
