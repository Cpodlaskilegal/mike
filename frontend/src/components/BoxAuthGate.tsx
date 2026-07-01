"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Box, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import {
  type BoxAuthStatus,
  getBoxAuthStatus,
  refreshMcpConnectorTools,
  startMcpConnectorOAuth,
} from "@/app/lib/docketApi";

const oauthMessageOrigin = new URL(
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001",
).origin;

const OPEN_PATHS = new Set(["/login", "/signup", "/support"]);

function isOpenPath(pathname: string | null) {
  if (!pathname) return false;
  return OPEN_PATHS.has(pathname) || pathname.startsWith("/account/connectors");
}

async function waitForOAuthPopup(
  popup: Window | null,
  connectorId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("OAuth authorization timed out."));
    }, 5 * 60 * 1000);
    const poll = window.setInterval(() => {
      if (popup?.closed) {
        cleanup();
        reject(new Error("OAuth window was closed."));
      }
    }, 700);
    const onMessage = (
      event: MessageEvent<{
        type?: string;
        success?: boolean;
        connectorId?: string;
        detail?: string;
      }>,
    ) => {
      if (event.origin !== oauthMessageOrigin) return;
      if (event.data?.type !== "mcp_oauth_result") return;
      if (event.data.connectorId && event.data.connectorId !== connectorId) {
        return;
      }
      cleanup();
      if (event.data.success) resolve();
      else reject(new Error(event.data.detail || "OAuth failed."));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(poll);
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
  });
}

export function BoxAuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isAuthenticated, authLoading } = useAuth();
  const [status, setStatus] = useState<BoxAuthStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shouldCheck = useMemo(
    () => isAuthenticated && !authLoading && !isOpenPath(pathname),
    [authLoading, isAuthenticated, pathname],
  );

  const loadStatus = useCallback(async () => {
    if (!shouldCheck) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await getBoxAuthStatus());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to check Box connection.",
      );
    } finally {
      setLoading(false);
    }
  }, [shouldCheck]);

  useEffect(() => {
    if (!shouldCheck) {
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    void loadStatus();
  }, [loadStatus, shouldCheck]);

  useEffect(() => {
    if (!shouldCheck) return;
    const onRequired = () => {
      void (async () => {
        try {
          const next = await getBoxAuthStatus();
          setStatus({ ...next, required: true, connected: false });
        } catch {
          setStatus((prev) =>
            prev
              ? { ...prev, required: true, connected: false }
              : {
                  required: true,
                  configured: true,
                  connected: false,
                  connectorId: null,
                },
          );
        }
      })();
    };
    window.addEventListener("docket:box-auth-required", onRequired);
    return () =>
      window.removeEventListener("docket:box-auth-required", onRequired);
  }, [loadStatus, shouldCheck]);

  const connectBox = async () => {
    if (!status?.connectorId) {
      await loadStatus();
      return;
    }
    setConnecting(true);
    setError(null);
    const popup = window.open(
      "about:blank",
      "docket_box_oauth",
      "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
    );
    try {
      const result = await startMcpConnectorOAuth(status.connectorId);
      if (result.alreadyAuthorized) {
        popup?.close();
      } else if (!result.authorizationUrl) {
        popup?.close();
        throw new Error("Box authorization URL was not returned.");
      } else if (!popup) {
        window.location.assign(result.authorizationUrl);
        return;
      } else {
        popup.location.href = result.authorizationUrl;
        await waitForOAuthPopup(popup, status.connectorId);
        popup.close();
      }
      await refreshMcpConnectorTools(status.connectorId);
      setStatus(await getBoxAuthStatus());
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : "Failed to connect Box.");
    } finally {
      setConnecting(false);
    }
  };

  if (!shouldCheck) return <>{children}</>;

  if (loading && !status) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center text-sm text-gray-600">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Checking Box connection
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-md bg-red-50 text-red-700 flex items-center justify-center">
              <Box className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-gray-950">
                Box connection required
              </h1>
              <p className="text-sm text-gray-600">
                Docket could not verify your Box connection.
              </p>
            </div>
          </div>
          <div className="mt-5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
          <Button
            type="button"
            onClick={() => void loadStatus()}
            disabled={loading}
            className="mt-6 w-full"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Recheck Box
          </Button>
        </div>
      </div>
    );
  }

  if (status?.required && !status.connected) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-md bg-blue-50 text-blue-700 flex items-center justify-center">
              <Box className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-gray-950">
                Connect Box
              </h1>
              <p className="text-sm text-gray-600">
                Docket requires your Box account before you continue.
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-3 text-sm text-gray-700">
            <p>
              Sign in to Box with the account whose files Docket should be able
              to access. Your Box permissions determine what Docket can see.
            </p>
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700">
                {error}
              </div>
            )}
          </div>

          <div className="mt-6 flex gap-3">
            <Button
              type="button"
              onClick={() => void connectBox()}
              disabled={connecting || loading || !status.connectorId}
              className="flex-1"
            >
              {connecting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Box className="h-4 w-4 mr-2" />
              )}
              Connect Box
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadStatus()}
              disabled={connecting || loading}
              title="Recheck Box connection"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
