"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
  cancelDataDeletionRequest,
  downloadUserDataExport,
  getAdminSpendDashboard,
  listDataDeletionRequests,
  requestDocketDataDeletion,
  retryAdminSpendReportDelivery,
  type AdminSpendDashboard,
  type DataExportScope,
  type DocketDataDeletionRequest,
} from "@/app/lib/docketApi";

const CONFIRMATION = "DELETE DOCKET DATA";

const EXPORTS: { scope: DataExportScope; title: string; description: string }[] = [
  {
    scope: "account",
    title: "Export Docket account data",
    description:
      "Download Docket profile, projects, document metadata, workflows and contribution submissions, chat history, reviews, and connector metadata as JSON.",
  },
  {
    scope: "chats",
    title: "Export chat history",
    description: "Download assistant and tabular-review conversations as JSON.",
  },
  {
    scope: "tabular-reviews",
    title: "Export tabular reviews",
    description: "Download review definitions, cells, citations, and review chats as JSON.",
  },
];

function statusLabel(status: DocketDataDeletionRequest["status"]) {
  return status.replaceAll("_", " ");
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUsd(value: number) {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

function reportStatusLabel(status?: string) {
  if (!status) return "Pending";
  return status.replaceAll("_", " ");
}

export default function PrivacyDataPage() {
  const router = useRouter();
  const { profile, loading: profileLoading } = useUserProfile();
  const isAdmin = profile?.role === "admin";
  const [requests, setRequests] = useState<DocketDataDeletionRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [exporting, setExporting] = useState<DataExportScope | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [spendDashboard, setSpendDashboard] =
    useState<AdminSpendDashboard | null>(null);
  const [loadingSpendDashboard, setLoadingSpendDashboard] = useState(false);
  const [spendDashboardError, setSpendDashboardError] = useState<string | null>(
    null,
  );
  const [retryingReportId, setRetryingReportId] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    setLoadingRequests(true);
    try {
      setRequests(await listDataDeletionRequests());
    } catch (value) {
      setError(value instanceof Error ? value.message : "Unable to load deletion requests.");
    } finally {
      setLoadingRequests(false);
    }
  }, []);

  const loadSpendDashboard = useCallback(async () => {
    setLoadingSpendDashboard(true);
    setSpendDashboardError(null);
    try {
      setSpendDashboard(await getAdminSpendDashboard());
    } catch (value) {
      setSpendDashboardError(
        value instanceof Error
          ? value.message
          : "Unable to load account spend reports.",
      );
    } finally {
      setLoadingSpendDashboard(false);
    }
  }, []);

  useEffect(() => {
    if (!profileLoading && !isAdmin) {
      router.replace("/account");
    }
  }, [isAdmin, profileLoading, router]);

  useEffect(() => {
    if (!isAdmin) return;
    void Promise.all([loadRequests(), loadSpendDashboard()]);
  }, [isAdmin, loadRequests, loadSpendDashboard]);

  const handleExport = async (scope: DataExportScope) => {
    setError(null);
    setNotice(null);
    setExporting(scope);
    try {
      const { blob, filename } = await downloadUserDataExport(scope);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice("Your Docket data export has downloaded.");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Unable to export Docket data.");
    } finally {
      setExporting(null);
    }
  };

  const handleRequestDeletion = async () => {
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const request = await requestDocketDataDeletion({
        confirmation,
        reason: reason.trim() || undefined,
      });
      setConfirmation("");
      setReason("");
      setNotice(
        request.note ??
          "Your Docket data deletion request is pending legal-retention review.",
      );
      await loadRequests();
    } catch (value) {
      setError(
        value instanceof Error
          ? value.message
          : "Unable to request Docket data deletion.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (requestId: string) => {
    setError(null);
    setNotice(null);
    setCancelling(requestId);
    try {
      await cancelDataDeletionRequest(requestId);
      setNotice("The pending Docket data deletion request was cancelled.");
      await loadRequests();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Unable to cancel deletion request.");
    } finally {
      setCancelling(null);
    }
  };

  const handleRetrySpendReportDelivery = async (reportId: string) => {
    setSpendDashboardError(null);
    setRetryingReportId(reportId);
    try {
      const result = await retryAdminSpendReportDelivery(reportId);
      if (result.status === "sent") {
        setNotice("The spend report was delivered to the current administrators.");
      } else {
        setSpendDashboardError(
          result.error ?? "The spend report could not be delivered yet.",
        );
      }
      await loadSpendDashboard();
    } catch (value) {
      setSpendDashboardError(
        value instanceof Error
          ? value.message
          : "Unable to retry spend report delivery.",
      );
    } finally {
      setRetryingReportId(null);
    }
  };

  if (profileLoading) {
    return (
      <div className="flex min-h-48 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
      </div>
    );
  }

  if (!isAdmin) return null;

  return (
    <div className="space-y-9">
      <section className="space-y-3">
        <div>
          <h2 className="text-2xl font-medium font-serif text-gray-900">
            Privacy & data
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            These administrator controls apply to Docket application data. Microsoft
            Entra identities are managed by your organization and are never deleted
            here.
          </p>
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {notice}
          </p>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="spend-reports-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3
              id="spend-reports-heading"
              className="text-lg font-medium text-gray-900"
            >
              Account spend reports
            </h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">
              Docket-account GPT and Claude usage. A report is sent to admins for
              every additional {formatUsd(100)} in tracked spend. Usage billed to
              a user-provided API key is excluded.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadSpendDashboard()}
            disabled={loadingSpendDashboard}
          >
            {loadingSpendDashboard ? "Loading…" : "Refresh"}
          </Button>
        </div>

        {spendDashboardError && (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {spendDashboardError}
          </p>
        )}

        {loadingSpendDashboard && !spendDashboard ? (
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading account spend…
          </div>
        ) : spendDashboard ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <p className="text-sm text-gray-600">Tracked total</p>
                <p className="mt-1 text-2xl font-medium text-gray-900">
                  {formatUsd(spendDashboard.totalUsd)}
                </p>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <p className="text-sm text-gray-600">GPT models</p>
                <p className="mt-1 text-2xl font-medium text-gray-900">
                  {formatUsd(spendDashboard.gptUsd)}
                </p>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <p className="text-sm text-gray-600">Claude models</p>
                <p className="mt-1 text-2xl font-medium text-gray-900">
                  {formatUsd(spendDashboard.claudeUsd)}
                </p>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <p className="text-sm text-gray-600">Next report at</p>
                <p className="mt-1 text-2xl font-medium text-gray-900">
                  {formatUsd(spendDashboard.nextThresholdUsd)}
                </p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Threshold</th>
                    <th className="px-4 py-3 font-medium">Total</th>
                    <th className="px-4 py-3 font-medium">GPT</th>
                    <th className="px-4 py-3 font-medium">Claude</th>
                    <th className="px-4 py-3 font-medium">Delivery</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium"><span className="sr-only">Delivery action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {spendDashboard.reports.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-gray-600">
                        No {formatUsd(100)} spend-report milestones have been reached.
                      </td>
                    </tr>
                  ) : (
                    spendDashboard.reports.map((report) => (
                      <tr
                        key={report.id}
                        className="border-b border-gray-100 last:border-b-0"
                      >
                        <td className="px-4 py-3 text-gray-900">
                          {formatUsd(report.thresholdUsd)}
                        </td>
                        <td className="px-4 py-3 text-gray-900">
                          {formatUsd(report.totalUsd)}
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          {formatUsd(report.gptUsd)}
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          {formatUsd(report.claudeUsd)}
                        </td>
                        <td className="px-4 py-3 capitalize text-gray-700">
                          {reportStatusLabel(report.deliveryStatus)}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {new Date(report.createdAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {report.deliveryStatus !== "sent" && (
                            <Button
                              type="button"
                              variant="outline"
                              className="h-8 px-2 text-xs"
                              disabled={retryingReportId === report.id}
                              onClick={() =>
                                void handleRetrySpendReportDelivery(report.id)
                              }
                            >
                              {retryingReportId === report.id
                                ? "Retrying…"
                                : "Retry delivery"}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-medium text-gray-900">Export data</h3>
          <p className="text-sm text-gray-600">
            Exports exclude API keys, OAuth tokens, encrypted connector configuration,
            and Azure Blob file bytes.
          </p>
        </div>
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          {EXPORTS.map((item, index) => (
            <div
              key={item.scope}
              className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between ${
                index ? "border-t border-gray-200" : ""
              }`}
            >
              <div className="min-w-0">
                <p className="font-medium text-gray-900">{item.title}</p>
                <p className="mt-1 text-sm text-gray-600">{item.description}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={exporting !== null}
                onClick={() => void handleExport(item.scope)}
                className="shrink-0 gap-2"
              >
                {exporting === item.scope ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {exporting === item.scope ? "Preparing…" : "Export"}
              </Button>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex gap-2">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div>
            <h3 className="text-lg font-medium text-gray-900">
              Request Docket data deletion
            </h3>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">
              A request is reviewed for legal retention and holds before Docket
              data can be removed. Approval is not automatic, and it does not
              affect your Microsoft Entra account.
            </p>
          </div>
        </div>
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
          <label className="block text-sm font-medium text-gray-900" htmlFor="deletion-reason">
            Optional request note
          </label>
          <textarea
            id="deletion-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
            rows={3}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none ring-offset-2 focus:border-gray-500 focus:ring-2 focus:ring-gray-300"
            placeholder="Explain the request, if helpful."
          />
          <label className="block text-sm font-medium text-gray-900" htmlFor="deletion-confirmation">
            Type <code className="rounded bg-white px-1.5 py-0.5 text-xs">{CONFIRMATION}</code> to submit
          </label>
          <Input
            id="deletion-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
          />
          <Button
            type="button"
            variant="outline"
            disabled={submitting || confirmation !== CONFIRMATION}
            onClick={() => void handleRequestDeletion()}
            className="gap-2 border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            {submitting ? "Submitting…" : "Request Docket data deletion"}
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-medium text-gray-900">Your requests</h3>
            <p className="text-sm text-gray-600">Deletion request status and retention-review outcome.</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void loadRequests()} disabled={loadingRequests}>
            {loadingRequests ? "Loading…" : "Refresh"}
          </Button>
        </div>
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          {loadingRequests ? (
            <div className="flex items-center gap-2 p-4 text-sm text-gray-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading requests…
            </div>
          ) : requests.length === 0 ? (
            <p className="p-4 text-sm text-gray-600">No Docket data deletion requests.</p>
          ) : (
            requests.map((request, index) => (
              <div
                key={request.id}
                className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between ${
                  index ? "border-t border-gray-200" : ""
                }`}
              >
                <div>
                  <p className="font-medium capitalize text-gray-900">{statusLabel(request.status)}</p>
                  {request.requested_at && (
                    <p className="mt-1 text-sm text-gray-600">
                      Requested {new Date(request.requested_at).toLocaleString()}
                    </p>
                  )}
                  {request.legal_hold && (
                    <p className="mt-1 text-sm text-amber-800">Subject to a legal hold.</p>
                  )}
                  {request.retention_until && (
                    <p className="mt-1 text-sm text-gray-600">
                      Retention review date: {new Date(request.retention_until).toLocaleDateString()}
                    </p>
                  )}
                  {request.decision_note && (
                    <p className="mt-1 text-sm text-gray-600">{request.decision_note}</p>
                  )}
                  {request.workflow_submission_disposition &&
                    request.status !== "pending_legal_review" && (
                      <p className="mt-1 text-sm text-gray-600">
                        Workflow contribution submissions: {request.workflow_submission_disposition}.
                      </p>
                    )}
                </div>
                {request.status === "pending_legal_review" && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={cancelling !== null}
                    onClick={() => void handleCancel(request.id)}
                  >
                    {cancelling === request.id ? "Cancelling…" : "Cancel request"}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
