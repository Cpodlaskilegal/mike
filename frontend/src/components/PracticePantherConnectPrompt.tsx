"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  getPracticePantherAuthStatus,
  type PracticePantherAuthStatus,
} from "@/app/lib/docketApi";

const CONNECTORS_PATH = "/account/connectors";
const CONNECTORS_HREF = `${CONNECTORS_PATH}#practicepanther-connection`;

function dismissalKey(userId: string) {
  return `docket.practicepanther-connect-prompt.dismissed.${userId}`;
}

export function PracticePantherConnectBanner({
  onDismiss,
}: {
  onDismiss: () => void;
}) {
  return (
    <aside
      aria-label="PracticePanther connection"
      className="flex shrink-0 items-start gap-3 border-b border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950 md:items-center md:px-6"
    >
      <div className="min-w-0 flex-1 md:flex md:items-center md:gap-3">
        <p>Connect your PracticePanther account to use its tools in Docket.</p>
        <Link
          href={CONNECTORS_HREF}
          className="mt-1 inline-block shrink-0 font-semibold text-blue-800 underline underline-offset-2 hover:text-blue-950 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 md:mt-0"
        >
          Connect PracticePanther
        </Link>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss PracticePanther reminder for this session"
        className="shrink-0 rounded p-1 text-blue-700 hover:bg-blue-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </aside>
  );
}

export function PracticePantherConnectPrompt() {
  const pathname = usePathname();
  const { user, authLoading } = useAuth();
  const userId = user?.id ?? null;
  const [status, setStatus] = useState<{
    userId: string;
    value: PracticePantherAuthStatus;
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const previousPath = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) {
      setDismissed(false);
      setStatus(null);
      return;
    }
    try {
      setDismissed(sessionStorage.getItem(dismissalKey(userId)) === "1");
    } catch {
      setDismissed(false);
    }
  }, [userId]);

  useEffect(() => {
    const onConnectorsPage = pathname?.startsWith(CONNECTORS_PATH) ?? false;
    const leavingConnectors =
      previousPath.current?.startsWith(CONNECTORS_PATH) && !onConnectorsPage;
    previousPath.current = pathname;

    if (!userId || authLoading) {
      setStatus(null);
      return;
    }
    if (onConnectorsPage) return;

    // A completed OAuth popup updates the connector page first. Recheck before
    // showing this reminder again when the user leaves that page.
    if (leavingConnectors) setStatus(null);

    let active = true;
    void getPracticePantherAuthStatus()
      .then((value) => {
        if (active) setStatus({ userId, value });
      })
      .catch(() => {
        // A failed status check must never block the rest of Docket.
        if (active) setStatus(null);
      });
    return () => {
      active = false;
    };
  }, [authLoading, pathname, userId]);

  const onConnectorsPage = pathname?.startsWith(CONNECTORS_PATH) ?? false;
  if (
    !userId ||
    onConnectorsPage ||
    dismissed ||
    status?.userId !== userId ||
    !status.value.configured ||
    status.value.connected
  ) {
    return null;
  }

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(dismissalKey(userId), "1");
    } catch {
      // Dismissal still works in this tab if storage is unavailable.
    }
  };

  return <PracticePantherConnectBanner onDismiss={dismiss} />;
}
