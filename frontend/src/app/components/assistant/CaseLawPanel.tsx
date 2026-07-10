"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import {
  getCourtlistenerOpinions,
  type CaseLawOpinion,
} from "@/app/lib/docketApi";

export type CaseTab = {
  kind: "case";
  id: `case:${number}`;
  clusterId: number;
  caseName: string | null;
  citation: string | null;
  url: string | null;
  dateFiled: string | null;
  pdfUrl: string | null;
  warning?: string | null;
  initialScrollTop?: number | null;
};

const opinionCache = new Map<number, CaseLawOpinion[]>();
const inFlightOpinionRequests = new Map<number, Promise<CaseLawOpinion[]>>();

function safeCourtlistenerUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "www.courtlistener.com" ||
        url.hostname === "storage.courtlistener.com")
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/429|rate limit|throttled/i.test(message)) {
    return "CourtListener is rate limiting requests. Please try again shortly.";
  }
  if (/401|403|token|credential|auth/i.test(message)) {
    return "CourtListener authentication is not configured correctly.";
  }
  return "Could not load this case from CourtListener. Please try again shortly.";
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function opinionTitle(opinion: CaseLawOpinion, index: number): string {
  if (opinion.per_curiam) return "Per curiam";
  const parts = [opinion.type, opinion.author].filter(Boolean);
  return parts.length ? parts.join(" · ") : `Opinion ${index + 1}`;
}

/**
 * A Docket-native CourtListener reader. It requests only the selected case
 * through the authenticated backend; browser code never receives an API key.
 * The `html` field is allowlisted by backend/src/lib/courtlistener.ts.
 */
export function CaseLawPanel({ tab }: { tab: CaseTab }) {
  const cached = opinionCache.get(tab.clusterId) ?? [];
  const [opinions, setOpinions] = useState<CaseLawOpinion[]>(cached);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(!cached.length);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = opinionCache.get(tab.clusterId);
    if (saved?.length) {
      setOpinions(saved);
      setActiveIndex(0);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setOpinions([]);
    setActiveIndex(0);
    setLoading(true);
    setError(null);
    let request = inFlightOpinionRequests.get(tab.clusterId);
    if (!request) {
      request = getCourtlistenerOpinions(tab.clusterId).finally(() => {
        inFlightOpinionRequests.delete(tab.clusterId);
      });
      inFlightOpinionRequests.set(tab.clusterId, request);
    }
    request
      .then((next) => {
        if (cancelled) return;
        opinionCache.set(tab.clusterId, next);
        setOpinions(next);
      })
      .catch((nextError) => {
        if (!cancelled) setError(friendlyError(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tab.clusterId]);

  const activeOpinion = opinions[activeIndex] ?? opinions[0] ?? null;
  const caseUrl = safeCourtlistenerUrl(tab.url);
  const pdfUrl = safeCourtlistenerUrl(tab.pdfUrl);
  const date = formatDate(tab.dateFiled);
  const title = [tab.caseName, tab.citation].filter(Boolean).join(", ");
  const opinionHtml = useMemo(
    () => activeOpinion?.html?.trim() || null,
    [activeOpinion?.html],
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-white" aria-label="Court opinion">
      <header className="shrink-0 border-b border-gray-200 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-lg text-gray-900">
              {title || "Court opinion"}
            </h2>
            {date ? <p className="mt-1 text-xs text-gray-500">Filed {date}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {pdfUrl ? (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1 rounded-md border border-gray-200 px-2 text-xs text-gray-700 hover:bg-gray-50"
                title="Open court PDF"
              >
                <Download className="h-3.5 w-3.5" />
                PDF
              </a>
            ) : null}
            {caseUrl ? (
              <a
                href={caseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1 rounded-md border border-gray-200 px-2 text-xs text-gray-700 hover:bg-gray-50"
                title="Open in CourtListener"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Source
              </a>
            ) : null}
          </div>
        </div>
      </header>

      {!loading && !error && opinions.length > 1 ? (
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-200 bg-gray-50 px-2 pt-2" aria-label="Opinions">
          {opinions.map((opinion, index) => (
            <button
              key={`${opinion.opinionId ?? "opinion"}-${index}`}
              type="button"
              onClick={() => setActiveIndex(index)}
              className={`max-w-48 truncate rounded-t-md px-3 py-1.5 text-xs transition-colors ${
                activeIndex === index
                  ? "bg-white font-medium text-gray-900"
                  : "text-gray-500 hover:bg-white/70 hover:text-gray-800"
              }`}
              title={opinionTitle(opinion, index)}
            >
              {opinionTitle(opinion, index)}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex h-full items-center justify-center text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading opinion" />
          </div>
        ) : error ? (
          <p className="rounded-md border border-red-100 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : !activeOpinion ? (
          <p className="text-sm text-gray-500">No opinions were returned for this case.</p>
        ) : opinionHtml ? (
          <article
            className="prose prose-sm max-w-none font-serif text-gray-900 [&_a]:text-blue-700 [&_a]:underline [&_blockquote]:border-l-gray-300 [&_blockquote]:text-gray-700 [&_table]:text-sm"
            // The backend strips executable/off-origin markup before this
            // field is serialized. Do not bypass that server boundary.
            dangerouslySetInnerHTML={{ __html: opinionHtml }}
          />
        ) : (
          <article className="whitespace-pre-wrap font-serif text-sm leading-7 text-gray-900">
            {activeOpinion.text || "This opinion did not include readable text."}
          </article>
        )}
      </div>
    </section>
  );
}
