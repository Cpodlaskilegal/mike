"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  DocketApiError,
  decideMcpApproval,
  getMcpApproval,
  type McpApprovalSummary,
} from "@/app/lib/docketApi";

export function McpApprovalCard({
  approvalId,
  connectorName,
  toolName,
}: {
  approvalId: string;
  connectorName: string;
  toolName: string;
}) {
  const [approval, setApproval] = useState<McpApprovalSummary | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const next = await getMcpApproval(approvalId);
        if (cancelled) return;
        setApproval(next);
        setError(null);
        if (next.status === "executing" || next.status === "pending") {
          const delay =
            next.status === "executing"
              ? 1500
              : Math.max(
                  1000,
                  Math.min(
                    new Date(next.expiresAt).getTime() - Date.now() + 100,
                    30000,
                  ),
                );
          poll = setTimeout(load, delay);
        }
      } catch (loadError) {
        if (!cancelled) {
          setApproval(null);
          const unavailableToViewer =
            loadError instanceof DocketApiError &&
            (loadError.status === 403 || loadError.status === 404);
          setError(
            unavailableToViewer
              ? "Only the Docket user who initiated this action can review or decide it."
              : loadError instanceof Error
              ? loadError.message
              : "Docket could not load this approval.",
          );
          if (!unavailableToViewer) poll = setTimeout(load, 3000);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (poll) clearTimeout(poll);
    };
  }, [approvalId]);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    setError(null);
    try {
      const result = await decideMcpApproval(approvalId, decision);
      setApproval(result.approval);
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : "Docket could not update this approval.",
      );
      try {
        setApproval(await getMcpApproval(approvalId));
      } catch {
        // A stale local "pending" state must never leave Approve enabled.
        setApproval(null);
      }
    } finally {
      setBusy(null);
    }
  };

  const status = approval?.status;
  const displayConnector = approval?.connectorName ?? connectorName;
  const displayTool = approval?.toolName ?? toolName;
  const preview = approval?.argumentsPreview ?? {};

  return (
    <div className="my-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-gray-800">
      <div className="font-semibold text-amber-900">
        {!status
          ? "Loading PracticePanther approval"
          : status === "pending"
          ? "PracticePanther change needs your approval"
          : status === "executing"
            ? "Executing approved PracticePanther change"
            : status === "succeeded"
              ? "PracticePanther change completed"
              : status === "indeterminate"
                ? "PracticePanther outcome needs verification"
              : status === "rejected"
                ? "PracticePanther change denied"
                : status === "expired"
                  ? "PracticePanther approval expired"
                  : "PracticePanther change failed"}
      </div>
      <p className="mt-1 text-gray-600">
        {!status
          ? "Docket is loading the exact action from its protected approval record."
          : status === "pending"
          ? "Nothing has been sent to PracticePanther. Review this exact action before approving it once."
          : status === "indeterminate"
            ? "Docket did not receive a definitive response. Verify the action in PracticePanther before attempting it again."
            : `${displayConnector}: ${displayTool}`}
      </p>
      {approval?.expiresAt && status === "pending" && (
        <p className="mt-1 text-xs text-gray-500">
          Approval expires{" "}
          {new Date(approval.expiresAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          .
        </p>
      )}
      {approval?.actorEmail && (
        <p className="mt-1 text-xs text-gray-500">
          Docket will attribute this action to {approval.actorEmail} in its
          PracticePanther audit note and actor tag.
        </p>
      )}
      <div className="mt-2 rounded border border-amber-100 bg-white px-3 py-2">
        <div className="font-mono text-xs text-gray-700">{displayTool}</div>
        {approval && (
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-600">
            {JSON.stringify(preview, null, 2)}
          </pre>
        )}
      </div>
      {approval?.resultContent && (
        <div className="mt-2 rounded border border-gray-200 bg-white px-3 py-2">
          <p className="text-xs font-medium text-gray-700">Result</p>
          <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-600">
            {approval.resultContent}
          </pre>
        </div>
      )}
      {approval?.errorMessage && (
        <p className="mt-2 text-sm text-red-700">{approval.errorMessage}</p>
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {status === "pending" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void decide("approve")}
            className="inline-flex min-h-10 items-center rounded-md bg-amber-700 px-4 py-2 font-medium text-white transition-colors hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "approve" && (
              <Loader2 size={14} className="mr-2 animate-spin" />
            )}
            Approve once
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void decide("reject")}
            className="min-h-10 rounded-md border border-gray-300 bg-white px-4 py-2 font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "reject" ? "Denying…" : "Deny"}
          </button>
        </div>
      )}
    </div>
  );
}
