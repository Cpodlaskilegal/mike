"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type {
    AssistantEvent,
    DocketAskInputsResponse,
    DocketCitation,
    DocketCitationAnnotation,
    DocketEditAnnotation,
} from "../shared/types";
import { EditCard } from "./EditCard";
import { PreResponseWrapper } from "../shared/PreResponseWrapper";
import { AskInputsPopup } from "./AskInputsPopup";
import { AssistantMessageSkeleton } from "./message/AssistantMessageSkeleton";
import { preprocessCitations } from "./message/citationUtils";
import { EditCardsSection } from "./message/EditCardsSection";
import { toolCallLabel } from "./message/eventUtils";
import {
    CourtlistenerEventBlock,
    DocCreatedBlock,
    DocDownloadBlock,
    DocEditedBlock,
    DocFindBlock,
    DocReadBlock,
    DocReplicatedBlock,
    McpEventBlock,
    ReasoningBlock,
    ThinkingBlock,
    ToolCallBlock,
    WorkflowAppliedBlock,
} from "./message/EventBlocks";
import { MarkdownContent } from "./message/MarkdownContent";
import {
    ResponseStatus,
    type AssistantResponseStatus,
} from "./message/ResponseStatus";
import { useSmoothedReveal } from "./message/useSmoothedReveal";

interface Props {
    /** Kept for older persisted messages that have content but no event log. */
    content: string;
    events?: AssistantEvent[];
    isStreaming?: boolean;
    isError?: boolean;
    /** Human-readable error text rendered alongside the red Docket icon. */
    errorMessage?: string;
    annotations?: DocketCitationAnnotation[];
    citations?: DocketCitation[];
    onCitationClick?: (citation: DocketCitationAnnotation) => void;
    onAskInputsSubmit?: (
        response: DocketAskInputsResponse,
        content: string,
        files: { filename: string; document_id: string }[],
    ) => void;
    projectId?: string;
    onCaseCitationClick?: (
        event: Extract<AssistantEvent, { type: "case_citation" }>,
    ) => void;
    minHeight?: string;
    onWorkflowClick?: (workflowId: string) => void;
    onEditViewClick?: (annotation: DocketEditAnnotation, filename: string) => void;
    /** Opens a document without targeting a specific citation or edit. */
    onOpenDocument?: (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => void;
    onEditResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onEditResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    onEditError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
    isDocReloading?: (documentId: string) => boolean;
    isEditReloading?: (editId: string) => boolean;
    /** UI-side status overrides after a bulk accept/reject response. */
    resolvedEditStatuses?: Record<string, "accepted" | "rejected">;
}

type EventGroup =
    | { kind: "pre"; events: AssistantEvent[]; indices: number[] }
    | {
          kind: "content";
          event: Extract<AssistantEvent, { type: "content" }>;
          index: number;
      };

function buildEventGroups(events: AssistantEvent[] | undefined): EventGroup[] {
    if (!events?.length) return [];

    const groups: EventGroup[] = [];
    let current: Extract<EventGroup, { kind: "pre" }> | null = null;
    events.forEach((event, index) => {
        if (event.type === "content") {
            if (current) {
                groups.push(current);
                current = null;
            }
            groups.push({ kind: "content", event, index });
            return;
        }
        if (!current) current = { kind: "pre", events: [], indices: [] };
        current.events.push(event);
        current.indices.push(index);
    });
    if (current) groups.push(current);
    return groups;
}

/**
 * The composition layer deliberately owns only event ordering, persistence
 * callbacks, and assistant-specific choices. Individual visual states live
 * in `message/` so future polish cannot accidentally change tool behavior.
 */
export function AssistantMessage({
    content,
    events,
    isStreaming = false,
    isError = false,
    errorMessage,
    annotations = [],
    citations,
    onCitationClick,
    onAskInputsSubmit,
    projectId,
    onCaseCitationClick,
    minHeight = "0px",
    onWorkflowClick,
    onEditViewClick,
    onOpenDocument,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    isDocReloading,
    isEditReloading,
    resolvedEditStatuses,
}: Props) {
    const contentDivRef = useRef<HTMLDivElement | null>(null);
    const [isCopied, setIsCopied] = useState(false);
    // Per-document overrides let a resolved tracked change immediately point
    // its download card at the latest version without waiting for a refetch.
    const [resolvedOverrides, setResolvedOverrides] = useState<
        Record<string, string>
    >({});

    const handleEditResolved = (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => {
        const downloadUrl = args.downloadUrl;
        if (downloadUrl) {
            setResolvedOverrides((previous) => ({
                ...previous,
                [args.documentId]: downloadUrl,
            }));
        }
        onEditResolved?.(args);
    };

    const status: AssistantResponseStatus = isError
        ? "error"
        : isStreaming
          ? "active"
          : null;
    const activeCitations = citations ?? annotations;
    const lastContentIdx = events
        ? events.reduce(
              (last, event, index) =>
                  event.type === "content" ? index : last,
              -1,
          )
        : -1;
    const lastContentEvent =
        lastContentIdx >= 0 && events
            ? (events[lastContentIdx] as Extract<
                  AssistantEvent,
                  { type: "content" }
              >)
            : null;
    const lastRenderableIdx = events
        ? events.reduce(
              (last, event, index) =>
                  event.type === "ask_inputs_response" ? last : index,
              -1,
          )
        : -1;
    const smoothedLastText = useSmoothedReveal(
        lastContentEvent?.text ?? "",
        isStreaming && lastContentIdx === lastRenderableIdx,
    );

    const citationsList: DocketCitation[] = [];
    const processedTexts: string[] = [];
    if (events) {
        events.forEach((event, index) => {
            processedTexts.push(
                event.type === "content"
                    ? preprocessCitations(
                          index === lastContentIdx
                              ? smoothedLastText
                              : event.text,
                          activeCitations,
                          citationsList,
                      )
                    : "",
            );
        });
    }
    const legacyContent =
        !events?.length && content.trim().length > 0
            ? preprocessCitations(content, activeCitations, citationsList)
            : "";
    const groups = buildEventGroups(events);
    const resolvedInputRequestIds = new Set(
        events
            ?.filter((event) => event.type === "ask_inputs_response")
            .map((event) => event.request_id) ?? [],
    );

    const handleCopy = async () => {
        const source = contentDivRef.current;
        if (!source || !navigator.clipboard) return;
        try {
            const clone = source.cloneNode(true) as HTMLElement;
            const html = clone.innerHTML;
            const plainText = clone.textContent || "";
            if (typeof ClipboardItem === "undefined") {
                await navigator.clipboard.writeText(plainText);
            } else {
                await navigator.clipboard.write([
                    new ClipboardItem({
                        "text/html": new Blob([html], { type: "text/html" }),
                        "text/plain": new Blob([plainText], {
                            type: "text/plain",
                        }),
                    }),
                ]);
            }
            setIsCopied(true);
            window.setTimeout(() => setIsCopied(false), 2000);
        } catch {
            // Clipboard permissions vary by browser; the response itself is
            // still available to select and copy normally.
        }
    };

    const hasContentAfter = (groupIndex: number): boolean =>
        groups.slice(groupIndex + 1).some(
            (group) => group.kind === "content" && group.event.text.length > 0,
        );

    const renderEvent = (
        event: AssistantEvent,
        index: number,
        allEvents: AssistantEvent[],
        globalIndex: number,
    ) => {
        const nextEvent = allEvents[index + 1];
        const showConnector =
            nextEvent !== undefined && nextEvent.type !== "content";

        if (event.type === "ask_inputs") {
            if (resolvedInputRequestIds.has(event.request_id)) {
                return (
                    <div
                        key={globalIndex}
                        className="rounded-md border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
                    >
                        Inputs provided
                    </div>
                );
            }
            return onAskInputsSubmit ? (
                <AskInputsPopup
                    key={globalIndex}
                    event={event}
                    projectId={projectId}
                    disabled={isStreaming}
                    onSubmit={onAskInputsSubmit}
                />
            ) : null;
        }
        if (event.type === "ask_inputs_response" || event.type === "content") {
            return null;
        }
        if (event.type === "reasoning") {
            return (
                <ReasoningBlock
                    key={globalIndex}
                    text={event.text}
                    isStreaming={!!event.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "tool_call_start") {
            return (
                <ToolCallBlock
                    key={globalIndex}
                    label={toolCallLabel(event.name)}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "thinking") {
            return <ThinkingBlock key={globalIndex} showConnector={showConnector} />;
        }
        if (event.type === "doc_read") {
            const annotation = annotations.find(
                (candidate) => candidate.filename === event.filename,
            );
            return (
                <DocReadBlock
                    key={globalIndex}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    onClick={
                        !event.isStreaming && annotation && onCitationClick
                            ? () => onCitationClick(annotation)
                            : undefined
                    }
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_find") {
            return (
                <DocFindBlock
                    key={globalIndex}
                    filename={event.filename}
                    query={event.query}
                    totalMatches={event.total_matches}
                    isStreaming={!!event.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_created") {
            return (
                <DocCreatedBlock
                    key={globalIndex}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_replicated") {
            return (
                <DocReplicatedBlock
                    key={globalIndex}
                    filename={event.filename}
                    count={event.count}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_edited") {
            return (
                <DocEditedBlock
                    key={globalIndex}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (
            event.type === "case_citation" ||
            event.type === "courtlistener_search_case_law" ||
            event.type === "courtlistener_get_cases" ||
            event.type === "courtlistener_find_in_case" ||
            event.type === "courtlistener_read_case" ||
            event.type === "courtlistener_verify_citations"
        ) {
            return (
                <CourtlistenerEventBlock
                    key={globalIndex}
                    event={event}
                    showConnector={showConnector}
                    onOpenCase={onCaseCitationClick}
                />
            );
        }
        if (event.type === "mcp_tool_call") {
            return (
                <McpEventBlock
                    key={globalIndex}
                    event={event}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "workflow_applied") {
            return (
                <WorkflowAppliedBlock
                    key={globalIndex}
                    title={event.title}
                    showConnector={showConnector}
                    onClick={
                        onWorkflowClick
                            ? () => onWorkflowClick(event.workflow_id)
                            : undefined
                    }
                />
            );
        }
        return null;
    };

    const editCards = !isStreaming && events
        ? (() => {
              const editedEvents = events.filter(
                  (event): event is Extract<
                      AssistantEvent,
                      { type: "doc_edited" }
                  > => event.type === "doc_edited" && !event.isStreaming,
              );
              const pending: {
                  annotation: DocketEditAnnotation;
                  filename: string;
              }[] = [];
              const filenameByDocId = new Map<string, string>();
              const statusOf = (annotation: DocketEditAnnotation) =>
                  resolvedEditStatuses?.[annotation.edit_id] ?? annotation.status;

              editedEvents.forEach((event) => {
                  filenameByDocId.set(event.document_id, event.filename);
                  event.annotations.forEach((annotation) => {
                      if (statusOf(annotation) === "pending") {
                          pending.push({ annotation, filename: event.filename });
                      }
                  });
              });
              const cards = editedEvents.flatMap((event) =>
                  event.annotations.map((annotation) => (
                      <EditCard
                          key={`editcard-${annotation.edit_id}`}
                          annotation={annotation}
                          resolvedStatus={resolvedEditStatuses?.[annotation.edit_id]}
                          isReloading={
                              isEditReloading?.(annotation.edit_id) ?? false
                          }
                          onViewClick={(edit) =>
                              onEditViewClick?.(edit, event.filename)
                          }
                          onResolveStart={onEditResolveStart}
                          onResolved={handleEditResolved}
                          onError={onEditError}
                      />
                  )),
              );
              if (cards.length <= 1) return cards;
              const resolvedCount = editedEvents.reduce(
                  (count, event) =>
                      count +
                      event.annotations.filter(
                          (annotation) => statusOf(annotation) !== "pending",
                      ).length,
                  0,
              );
              return (
                  <EditCardsSection
                      pending={pending}
                      filenameByDocId={filenameByDocId}
                      cards={cards}
                      resolvedCount={resolvedCount}
                      onViewClick={onEditViewClick}
                      onResolveStart={onEditResolveStart}
                      onResolved={handleEditResolved}
                      onError={onEditError}
                  />
              );
          })()
        : null;

    const editedDownloadCards = !isStreaming && events
        ? (() => {
              const latestByDocument = new Map<
                  string,
                  Extract<AssistantEvent, { type: "doc_edited" }>
              >();
              events.forEach((event) => {
                  if (
                      event.type === "doc_edited" &&
                      !event.isStreaming &&
                      event.download_url
                  ) {
                      latestByDocument.set(event.document_id, event);
                  }
              });
              return Array.from(latestByDocument.values()).map((event) => (
                  <div
                      key={`edited-download-${event.document_id}`}
                      className="mb-3 mt-2 flex flex-col gap-2"
                  >
                      <DocDownloadBlock
                          filename={event.filename}
                          download_url={
                              resolvedOverrides[event.document_id] ??
                              event.download_url
                          }
                          versionNumber={event.version_number ?? null}
                          onOpen={
                              onOpenDocument
                                  ? () =>
                                        onOpenDocument({
                                            documentId: event.document_id,
                                            filename: event.filename,
                                            versionId: event.version_id ?? null,
                                            versionNumber:
                                                event.version_number ?? null,
                                        })
                                  : onEditViewClick && event.annotations[0]
                                    ? () =>
                                          onEditViewClick(
                                              event.annotations[0],
                                              event.filename,
                                          )
                                    : undefined
                          }
                          isReloading={
                              isDocReloading?.(event.document_id) ?? false
                          }
                      />
                  </div>
              ));
          })()
        : null;

    const createdDownloadCards = !isStreaming && events
        ? events
              .filter(
                  (event): event is Extract<
                      AssistantEvent,
                      { type: "doc_created" }
                  > => event.type === "doc_created" && !!event.download_url,
              )
              .map((event, index) => {
                  const documentId = event.document_id;
                  const versionId = event.version_id ?? null;
                  const versionNumber = event.version_number ?? null;
                  return (
                      <DocDownloadBlock
                          key={`${event.filename}-${index}`}
                          filename={event.filename}
                          download_url={event.download_url}
                          versionNumber={versionNumber}
                          onOpen={
                              onOpenDocument && documentId
                                  ? () =>
                                        onOpenDocument({
                                            documentId,
                                            filename: event.filename,
                                            versionId,
                                            versionNumber,
                                        })
                                  : undefined
                          }
                      />
                  );
              })
        : null;

    return (
        <div style={{ minHeight }}>
            <ResponseStatus status={status} />
            <div className="relative mt-2 w-full font-inter">
                {isStreaming && !events?.length && <AssistantMessageSkeleton />}
                {groups.length > 0 && (
                    <div className="flex flex-col gap-4">
                        {groups.map((group, groupIndex) => {
                            if (group.kind === "content") {
                                return (
                                    <MarkdownContent
                                        key={`content-${group.index}`}
                                        text={processedTexts[group.index]}
                                        citationsList={citationsList}
                                        onCitationClick={onCitationClick}
                                        divRef={
                                            group.index === lastContentIdx
                                                ? contentDivRef
                                                : undefined
                                        }
                                    />
                                );
                            }
                            const wrapperIsStreaming = group.events.some(
                                (event) =>
                                    "isStreaming" in event &&
                                    !!event.isStreaming,
                            );
                            return (
                                <PreResponseWrapper
                                    key={`pre-${group.indices[0]}`}
                                    stepCount={group.events.length}
                                    shouldMinimize={hasContentAfter(groupIndex)}
                                    isStreaming={wrapperIsStreaming}
                                >
                                    {group.events.map((event, index) =>
                                        renderEvent(
                                            event,
                                            index,
                                            group.events,
                                            group.indices[index],
                                        ),
                                    )}
                                </PreResponseWrapper>
                            );
                        })}
                        {editCards}
                    </div>
                )}
                {legacyContent && (
                    <MarkdownContent
                        text={legacyContent}
                        citationsList={citationsList}
                        onCitationClick={onCitationClick}
                        divRef={contentDivRef}
                    />
                )}
                {isError && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-serif text-red-700">
                        <span className="leading-snug">
                            {errorMessage ?? "Sorry, something went wrong."}
                        </span>
                    </div>
                )}
                {editedDownloadCards}
                {createdDownloadCards && createdDownloadCards.length > 0 && (
                    <div className="mb-3 mt-2 flex flex-col gap-2">
                        {createdDownloadCards}
                    </div>
                )}
                <div className="flex items-center gap-2 justify-start pb-4 pt-2 font-sans md:pb-8">
                    {!isStreaming && (groups.length > 0 || legacyContent) && (
                        <button
                            type="button"
                            className="rounded p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                            onClick={handleCopy}
                            aria-label={isCopied ? "Response copied" : "Copy response"}
                        >
                            {isCopied ? (
                                <Check className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                                <Copy className="h-3.5 w-3.5" />
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
