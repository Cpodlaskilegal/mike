"use client";

import { useRef, useState } from "react";
import { Check, Loader2, Upload, X } from "lucide-react";
import {
  uploadProjectDocument,
  uploadStandaloneDocument,
} from "@/app/lib/docketApi";
import {
  SUPPORTED_DOCUMENT_ACCEPT,
  formatUnsupportedDocumentWarning,
  partitionSupportedDocumentFiles,
} from "@/app/lib/documentUploadValidation";
import type {
  AssistantEvent,
  DocketAskInputsResponse,
  DocketDocument,
} from "../shared/types";

type AskInputsEvent = Extract<AssistantEvent, { type: "ask_inputs" }>;

type Props = {
  event: AskInputsEvent;
  projectId?: string;
  disabled?: boolean;
  onSubmit: (
    response: DocketAskInputsResponse,
    content: string,
    files: { filename: string; document_id: string }[],
  ) => void;
};

export function AskInputsPopup({
  event,
  projectId,
  disabled = false,
  onSubmit,
}: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [documents, setDocuments] = useState<Record<string, DocketDocument[]>>(
    {},
  );
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const resolved = (item: AskInputsEvent["items"][number]) => {
    if (skipped.has(item.id)) return true;
    return item.kind === "choice"
      ? !!answers[item.id]?.trim()
      : (documents[item.id] ?? []).length > 0;
  };
  const allResolved = event.items.length > 0 && event.items.every(resolved);

  const toggleSkip = (id: string) => {
    if (disabled || uploadingId) return;
    setSkipped((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const uploadFiles = async (inputId: string, incoming: File[]) => {
    if (disabled || !incoming.length) return;
    const { supported, unsupported } = partitionSupportedDocumentFiles(incoming);
    setWarning(formatUnsupportedDocumentWarning(unsupported));
    if (!supported.length) return;
    setUploadingId(inputId);
    try {
      const uploaded = await Promise.all(
        supported.map((file) =>
          projectId
            ? uploadProjectDocument(projectId, file)
            : uploadStandaloneDocument(file),
        ),
      );
      setSkipped((current) => {
        const next = new Set(current);
        next.delete(inputId);
        return next;
      });
      setDocuments((current) => {
        const existing = current[inputId] ?? [];
        const ids = new Set(existing.map((document) => document.id));
        return {
          ...current,
          [inputId]: [
            ...existing,
            ...uploaded.filter((document) => !ids.has(document.id)),
          ],
        };
      });
    } catch {
      setWarning("Docket could not upload one or more documents. Please try again.");
    } finally {
      setUploadingId(null);
      const input = inputs.current[inputId];
      if (input) input.value = "";
    }
  };

  const submit = () => {
    if (disabled || !!uploadingId || !allResolved) return;
    const responses = event.items.map((item) => {
      if (item.kind === "choice") {
        return skipped.has(item.id)
          ? {
              id: item.id,
              kind: "choice" as const,
              question: item.question,
              skipped: true,
            }
          : {
              id: item.id,
              kind: "choice" as const,
              question: item.question,
              answer: answers[item.id]?.trim() ?? "",
            };
      }
      return skipped.has(item.id)
        ? {
            id: item.id,
            kind: "documents" as const,
            filenames: [],
            skipped: true,
          }
        : {
            id: item.id,
            kind: "documents" as const,
            filenames: (documents[item.id] ?? []).map(
              (document) => document.filename,
            ),
          };
    });
    const response: DocketAskInputsResponse = {
      request_id: event.request_id,
      responses,
    };
    const seen = new Set<string>();
    const files = Object.values(documents).flatMap((list) =>
      list.flatMap((document) => {
        if (seen.has(document.id)) return [];
        seen.add(document.id);
        return [{ filename: document.filename, document_id: document.id }];
      }),
    );
    const content = ["Responses to Docket's questions:", ...responses.map((item, index) => {
      if (item.kind === "choice") {
        return item.skipped
          ? `${index + 1}. Skipped: ${item.question ?? "Question"}`
          : `${index + 1}. ${item.question ?? "Question"}\n${item.answer ?? ""}`;
      }
      return item.skipped
        ? `${index + 1}. Skipped document request.`
        : `${index + 1}. Documents attached: ${(item.filenames ?? []).join(", ")}`;
    })].join("\n\n");
    onSubmit(response, content, files);
  };

  return (
    <section className="my-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-50/80 font-sans shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div>
          <p className="text-sm font-medium text-slate-900">Docket needs a few inputs</p>
          <p className="mt-0.5 text-xs text-slate-500">Answer or skip each item to continue.</p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-500">
          {event.items.filter(resolved).length}/{event.items.length}
        </span>
      </div>

      <div className="space-y-4 p-4">
        {event.items.map((item, index) => (
          <div key={item.id} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  {item.kind === "choice" ? `Question ${index + 1}` : "Documents"}
                </p>
                {item.kind === "choice" ? (
                  <p className="mt-1 text-sm text-slate-800">{item.question}</p>
                ) : (
                  <p className="mt-1 text-sm text-slate-800">
                    Add {item.document_types.length ? item.document_types.join(" or ") : "the requested"} document{item.document_types.length === 1 ? "" : "s"}.
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => toggleSkip(item.id)}
                disabled={disabled || !!uploadingId}
                className="shrink-0 text-xs text-slate-500 hover:text-slate-800 disabled:opacity-50"
              >
                {skipped.has(item.id) ? "Include" : "Skip"}
              </button>
            </div>

            {!skipped.has(item.id) && item.kind === "choice" && (
              <div className="flex flex-wrap gap-2">
                {item.options.map((option) => {
                  const selected = answers[item.id] === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setAnswers((current) => ({ ...current, [item.id]: option.value }));
                        setSkipped((current) => {
                          const next = new Set(current);
                          next.delete(item.id);
                          return next;
                        });
                      }}
                      className={`rounded-full border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${selected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"}`}
                    >
                      {selected && <Check className="mr-1 inline h-3 w-3" />}
                      {option.value}
                    </button>
                  );
                })}
                {item.allow_other && (
                  <input
                    aria-label={item.other_label || "Other answer"}
                    disabled={disabled}
                    value={answers[item.id] ?? ""}
                    onChange={(change) => {
                      setAnswers((current) => ({ ...current, [item.id]: change.target.value }));
                      setSkipped((current) => {
                        const next = new Set(current);
                        next.delete(item.id);
                        return next;
                      });
                    }}
                    placeholder={item.other_label || "Other"}
                    className="min-w-36 flex-1 rounded-md border border-slate-200 px-2 py-1 text-sm outline-none focus:border-slate-500"
                  />
                )}
              </div>
            )}

            {!skipped.has(item.id) && item.kind === "documents" && (
              <div>
                <input
                  ref={(element) => {
                    inputs.current[item.id] = element;
                  }}
                  className="hidden"
                  type="file"
                  accept={SUPPORTED_DOCUMENT_ACCEPT}
                  multiple
                  onChange={(change) => void uploadFiles(item.id, Array.from(change.target.files ?? []))}
                />
                <button
                  type="button"
                  disabled={disabled || !!uploadingId}
                  onClick={() => inputs.current[item.id]?.click()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {uploadingId === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {uploadingId === item.id ? "Uploading…" : "Upload documents"}
                </button>
                {(documents[item.id] ?? []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(documents[item.id] ?? []).map((document) => (
                      <span key={document.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-700">
                        {document.filename}
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => setDocuments((current) => ({
                            ...current,
                            [item.id]: (current[item.id] ?? []).filter((candidate) => candidate.id !== document.id),
                          }))}
                          aria-label={`Remove ${document.filename}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {warning && <p className="text-xs text-amber-700">{warning}</p>}
        <button
          type="button"
          disabled={disabled || !!uploadingId || !allResolved}
          onClick={submit}
          className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Continue with these inputs
        </button>
      </div>
    </section>
  );
}
