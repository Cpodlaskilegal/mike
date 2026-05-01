import {
    AccountInfo,
    AuthenticationResult,
    EventType,
    InteractionRequiredAuthError,
    PublicClientApplication,
} from "@azure/msal-browser";

const tenantId = process.env.NEXT_PUBLIC_AZURE_TENANT_ID ?? "";
const clientId = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID ?? "";
const apiScope = process.env.NEXT_PUBLIC_AZURE_API_SCOPE ?? "";

const msal =
    typeof window === "undefined"
        ? null
        : new PublicClientApplication({
              auth: {
                  clientId,
                  authority: `https://login.microsoftonline.com/${tenantId}`,
                  redirectUri: window.location.origin,
              },
              cache: {
                  cacheLocation: "localStorage",
              },
          });

let initPromise: Promise<void> | null = null;

async function ensureMsal() {
    if (!msal) throw new Error("Authentication is only available in the browser");
    initPromise ??= msal.initialize().then(() => {
        const redirectPromise = msal.handleRedirectPromise();
        return redirectPromise.then((result) => {
            if (result?.account) msal.setActiveAccount(result.account);
        });
    });
    await initPromise;
    const active = msal.getActiveAccount();
    if (!active) {
        const accounts = msal.getAllAccounts();
        if (accounts[0]) msal.setActiveAccount(accounts[0]);
    }
    return msal;
}

function accountToUser(account: AccountInfo) {
    return {
        id: account.localAccountId,
        email: account.username,
    };
}

async function acquireToken(): Promise<AuthenticationResult | null> {
    const app = await ensureMsal();
    const account = app.getActiveAccount() ?? app.getAllAccounts()[0];
    if (!account || !apiScope) return null;
    try {
        return await app.acquireTokenSilent({ account, scopes: [apiScope] });
    } catch (error) {
        if (error instanceof InteractionRequiredAuthError) return null;
        throw error;
    }
}

export const supabase = {
    auth: {
        async getSession() {
            const app = await ensureMsal();
            const account = app.getActiveAccount() ?? app.getAllAccounts()[0];
            if (!account) return { data: { session: null }, error: null };
            const token = await acquireToken();
            return {
                data: {
                    session: token
                        ? {
                              access_token: token.accessToken,
                              user: accountToUser(account),
                          }
                        : null,
                },
                error: null,
            };
        },
        async signInWithPassword(_credentials?: unknown) {
            const app = await ensureMsal();
            await app.loginRedirect({
                scopes: apiScope ? [apiScope] : [],
                prompt: "select_account",
            });
            return { data: { session: null }, error: null };
        },
        async signUp(_credentials?: unknown) {
            return this.signInWithPassword();
        },
        async signOut() {
            const app = await ensureMsal();
            const account = app.getActiveAccount();
            if (account) await app.logoutRedirect({ account });
        },
        onAuthStateChange(callback: (_event: string, session: any) => void) {
            let callbackId: string | null = null;
            ensureMsal().then((app) => {
                callbackId = app.addEventCallback((event) => {
                    if (
                        event.eventType === EventType.LOGIN_SUCCESS ||
                        event.eventType === EventType.ACQUIRE_TOKEN_SUCCESS
                    ) {
                        this.getSession().then(({ data }) =>
                            callback(event.eventType, data.session),
                        );
                    }
                    if (event.eventType === EventType.LOGOUT_SUCCESS) {
                        callback(event.eventType, null);
                    }
                });
            });
            return {
                data: {
                    subscription: {
                        unsubscribe() {
                            if (callbackId && msal) msal.removeEventCallback(callbackId);
                        },
                    },
                },
            };
        },
    },
};
