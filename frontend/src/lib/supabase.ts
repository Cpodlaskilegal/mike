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
                  redirectUri: `${window.location.origin}/login`,
              },
              cache: {
                  cacheLocation: "localStorage",
              },
          });

let initPromise: Promise<void> | null = null;
let redirectResult: AuthenticationResult | null = null;

async function ensureMsal() {
    if (!msal) throw new Error("Authentication is only available in the browser");
    initPromise ??= msal.initialize().then(() => {
        const redirectPromise = msal.handleRedirectPromise({
            navigateToLoginRequestUrl: false,
        });
        return redirectPromise.then((result) => {
            if (result?.account) {
                redirectResult = result;
                msal.setActiveAccount(result.account);
                window.sessionStorage.removeItem("mikeApiTokenRedirectStarted");
            }
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

type MikeSession = {
    access_token: string;
    user: ReturnType<typeof accountToUser>;
};

function isFreshToken(result: AuthenticationResult | null): result is AuthenticationResult {
    const expiresAt = result?.expiresOn?.getTime();
    if (!result?.accessToken || !expiresAt) return false;
    return expiresAt - Date.now() > 60_000;
}

async function acquireToken(options?: {
    interactive?: boolean;
    forceRefresh?: boolean;
}): Promise<AuthenticationResult | null> {
    const app = await ensureMsal();
    const account = app.getActiveAccount() ?? app.getAllAccounts()[0];
    if (!account || !apiScope) return null;
    if (
        !options?.forceRefresh &&
        redirectResult?.account?.homeAccountId === account.homeAccountId &&
        isFreshToken(redirectResult)
    ) {
        return redirectResult;
    }
    if (redirectResult && !isFreshToken(redirectResult)) redirectResult = null;
    try {
        const result = await app.acquireTokenSilent({
            account,
            scopes: [apiScope],
            forceRefresh: options?.forceRefresh,
        });
        window.sessionStorage.removeItem("mikeApiTokenRedirectStarted");
        return result;
    } catch (error) {
        if (error instanceof InteractionRequiredAuthError) {
            if (
                options?.interactive &&
                !window.sessionStorage.getItem("mikeApiTokenRedirectStarted")
            ) {
                window.sessionStorage.setItem("mikeApiTokenRedirectStarted", "1");
                await app.acquireTokenRedirect({
                    account,
                    scopes: [apiScope],
                });
            }
            return null;
        }
        throw error;
    }
}

export const supabase = {
    auth: {
        async getCurrentUser() {
            const app = await ensureMsal();
            const account = app.getActiveAccount() ?? app.getAllAccounts()[0];
            return {
                data: {
                    user: account ? accountToUser(account) : null,
                },
                error: null,
            };
        },
        async getSession(options?: {
            interactive?: boolean;
            forceRefresh?: boolean;
        }) {
            const app = await ensureMsal();
            const account = app.getActiveAccount() ?? app.getAllAccounts()[0];
            if (!account) return { data: { session: null }, error: null };
            const token = await acquireToken(options);
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
            window.sessionStorage.removeItem("mikeApiTokenRedirectStarted");
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
        onAuthStateChange(
            callback: (_event: string, session: MikeSession | null) => void,
        ) {
            // Only react to login/logout. Listening for ACQUIRE_TOKEN_SUCCESS
            // here is unsafe: the handler calls getSession(), which calls
            // acquireTokenSilent, which itself emits ACQUIRE_TOKEN_SUCCESS —
            // an infinite refresh loop that hammers the API and pegs Safari.
            let callbackId: string | null = null;
            ensureMsal()
                .then((app) => {
                    callbackId = app.addEventCallback((event) => {
                        if (event.eventType === EventType.LOGIN_SUCCESS) {
                            this.getSession().then(({ data }) =>
                                callback(event.eventType, data.session),
                            );
                        }
                        if (event.eventType === EventType.LOGOUT_SUCCESS) {
                            callback(event.eventType, null);
                        }
                    });
                })
                .catch(() => {
                    callback("AUTH_INIT_FAILED", null);
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
