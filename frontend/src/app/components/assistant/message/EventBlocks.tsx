"use client";

import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { AssistantEvent } from "../../shared/types";
import { safeCourtlistenerHref } from "./citationUtils";

const THINKING_PHRASES = [
    "Thinking...",
    "Pondering...",
    "Analyzing...",
    "Reviewing...",
    "Reasoning...",
];

type DotColor = "green" | "gray" | "red";

function EventConnector() {
    return (
        <div className="absolute bottom-0 left-[2.5px] top-[13px] h-[calc(100%+11px)] w-px bg-gray-300" />
    );
}

/** Shared chronology row for tool, document, and research activity. */
export function EventBlock({
    showConnector,
    isStreaming,
    dotColor = "green",
    children,
}: {
    showConnector?: boolean;
    isStreaming?: boolean;
    dotColor?: DotColor;
    children: ReactNode;
}) {
    const dotClass =
        dotColor === "green"
            ? "bg-green-400"
            : dotColor === "red"
              ? "bg-red-400"
              : "bg-gray-300";

    return (
        <div className="relative flex items-start text-sm font-serif text-gray-500">
            {showConnector && <EventConnector />}
            {isStreaming ? (
                <div className="mt-2 h-1.5 w-1.5 shrink-0 animate-spin rounded-full border border-gray-400 border-t-transparent" />
            ) : (
                <div className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
            )}
            <div className="ml-2 min-w-0 flex-1 break-words whitespace-normal">
                {children}
            </div>
        </div>
    );
}

export function ToolCallBlock({
    label,
    showConnector,
}: {
    label: string;
    showConnector?: boolean;
}) {
    return (
        <EventBlock showConnector={showConnector} isStreaming dotColor="gray">
            <span className="font-medium">{label}</span>
        </EventBlock>
    );
}

export function ThinkingBlock({ showConnector }: { showConnector?: boolean }) {
    return (
        <EventBlock showConnector={showConnector} isStreaming dotColor="gray">
            Thinking...
        </EventBlock>
    );
}

export function ReasoningBlock({
    text,
    isStreaming,
    showConnector,
}: {
    text: string;
    isStreaming: boolean;
    showConnector?: boolean;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [thinkingIndex, setThinkingIndex] = useState(0);

    useEffect(() => {
        if (!isStreaming) return;
        const interval = window.setInterval(() => {
            setThinkingIndex((index) => (index + 1) % THINKING_PHRASES.length);
        }, 2000);
        return () => window.clearInterval(interval);
    }, [isStreaming]);

    const showContent = isOpen || isStreaming;
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor="gray"
        >
            <button
                type="button"
                onClick={() => !isStreaming && setIsOpen((open) => !open)}
                className="flex items-center text-sm font-serif text-gray-500 transition-colors hover:text-gray-600"
                aria-expanded={isStreaming ? true : isOpen}
            >
                <span className="font-medium">
                    {isStreaming ? THINKING_PHRASES[thinkingIndex] : "Thought process"}
                </span>
                {!isStreaming && (
                    <ChevronDown
                        size={10}
                        className={`ml-1 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                    />
                )}
            </button>
            {showContent && (
                <div className="prose prose-sm mt-2 max-w-none text-sm font-serif text-gray-400 [&>*]:text-sm [&>*]:text-gray-400">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
                </div>
            )}
        </EventBlock>
    );
}

export function DocReadBlock({
    filename,
    onClick,
    showConnector,
    isStreaming,
}: {
    filename: string;
    onClick?: () => void;
    showConnector?: boolean;
    isStreaming?: boolean;
}) {
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor="green"
        >
            <span className="font-medium">{isStreaming ? "Reading" : "Read"}</span>{" "}
            {isStreaming ? (
                <span>{filename}...</span>
            ) : onClick ? (
                <button
                    type="button"
                    onClick={onClick}
                    className="text-left transition-colors hover:text-gray-700"
                >
                    {filename}
                </button>
            ) : (
                <span>{filename}</span>
            )}
        </EventBlock>
    );
}

export function DocFindBlock({
    filename,
    query,
    totalMatches,
    isStreaming,
    showConnector,
}: {
    filename: string;
    query: string;
    totalMatches: number;
    isStreaming?: boolean;
    showConnector?: boolean;
}) {
    const suffix = isStreaming
        ? ""
        : ` (${totalMatches} ${totalMatches === 1 ? "match" : "matches"})`;
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={totalMatches > 0 ? "green" : "gray"}
        >
            <span className="font-medium">{isStreaming ? "Finding" : "Found"}</span>{" "}
            <span>
                &ldquo;{query}&rdquo;{suffix}
                <span className="ml-1 text-gray-400">in {filename}</span>
                {isStreaming && "..."}
            </span>
        </EventBlock>
    );
}

export function DocCreatedBlock({
    filename,
    showConnector,
    isStreaming,
}: {
    filename: string;
    showConnector?: boolean;
    isStreaming?: boolean;
}) {
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor="green"
        >
            <span className="font-medium">{isStreaming ? "Creating" : "Created"}</span>{" "}
            <span>{isStreaming ? `${filename}...` : filename}</span>
        </EventBlock>
    );
}

export function DocReplicatedBlock({
    filename,
    count,
    showConnector,
    isStreaming,
    hasError,
}: {
    filename: string;
    count: number;
    showConnector?: boolean;
    isStreaming?: boolean;
    hasError?: boolean;
}) {
    const suffix =
        !isStreaming && count > 1 ? ` ${count} times` : isStreaming ? "..." : "";
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={hasError ? "red" : "green"}
        >
            <span className="font-medium">{isStreaming ? "Replicating" : "Replicated"}</span>{" "}
            <span>
                {filename}
                {suffix}
            </span>
        </EventBlock>
    );
}

export function DocDownloadBlock({
    filename,
    download_url,
    onOpen,
    isReloading = false,
    versionNumber,
}: {
    filename: string;
    download_url: string;
    onOpen?: () => void;
    isReloading?: boolean;
    versionNumber?: number | null;
}) {
    const hasVersion =
        typeof versionNumber === "number" &&
        Number.isFinite(versionNumber) &&
        versionNumber > 0;
    const extMatch = filename.match(/\.(\w+)$/);
    const extension = extMatch ? extMatch[1].toUpperCase() : "FILE";
    const rawBasename = extMatch
        ? filename.slice(0, -extMatch[0].length)
        : filename;
    const basename = rawBasename.replace(/\s*\[Edited V\d+\]\s*$/, "").trim();
    const apiBase =
        process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
    // Download requests attach a bearer token, so retain the existing strict
    // relative-URL rule instead of following a tool-provided absolute link.
    const href = download_url.startsWith("/") ? `${apiBase}${download_url}` : null;
    const [busy, setBusy] = useState(false);

    const handleDownload = async (event?: {
        stopPropagation?: () => void;
        preventDefault?: () => void;
    }) => {
        event?.stopPropagation?.();
        event?.preventDefault?.();
        if (busy || isReloading || !href) return;
        setBusy(true);
        try {
            const {
                data: { session },
            } = await supabase.auth.getSession();
            const response = await fetch(href, {
                headers: session?.access_token
                    ? { Authorization: `Bearer ${session.access_token}` }
                    : {},
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = blobUrl;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        } finally {
            setBusy(false);
        }
    };

    const spinning = busy || isReloading;
    const body = (
        <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-0 break-words text-base font-serif text-gray-900">
                        {basename}
                    </p>
                    {hasVersion && (
                        <span className="shrink-0 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                            V{versionNumber}
                        </span>
                    )}
                </div>
                <p className="mt-0.5 text-xs text-blue-500">{extension}</p>
            </div>
        </div>
    );

    const downloadControl = spinning ? (
        <div
            aria-disabled="true"
            className="flex min-h-11 shrink-0 items-center justify-center border-t border-gray-200 bg-white px-6 text-gray-400 sm:min-h-0 sm:border-l sm:border-t-0"
        >
            <Loader2 size={13} className="animate-spin" />
        </div>
    ) : (
        <button
            type="button"
            onClick={handleDownload}
            aria-label={`Download ${filename}`}
            className="flex min-h-11 shrink-0 items-center justify-center border-t border-gray-200 bg-white px-6 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 sm:min-h-0 sm:border-l sm:border-t-0"
        >
            <Download size={13} />
        </button>
    );

    const cardClassName =
        "flex w-full flex-col overflow-hidden rounded-lg border border-gray-200 bg-gray-50 font-sans sm:flex-row sm:items-stretch";
    if (onOpen) {
        return (
            <div className={cardClassName}>
                <button
                    type="button"
                    onClick={onOpen}
                    className="flex min-w-0 flex-1 items-stretch text-left transition-colors hover:bg-gray-100"
                >
                    {body}
                </button>
                {downloadControl}
            </div>
        );
    }

    if (spinning) {
        return (
            <div className={cardClassName}>
                {body}
                {downloadControl}
            </div>
        );
    }

    return (
        <div className={cardClassName}>
            <button
                type="button"
                onClick={handleDownload}
                className="flex min-w-0 flex-1 items-stretch text-left transition-colors hover:bg-gray-100"
            >
                {body}
            </button>
            {downloadControl}
        </div>
    );
}

export function WorkflowAppliedBlock({
    title,
    showConnector,
    onClick,
}: {
    title: string;
    showConnector?: boolean;
    onClick?: () => void;
}) {
    return (
        <EventBlock showConnector={showConnector} dotColor="green">
            <span className="font-medium">Applied workflow</span>{" "}
            {onClick ? (
                <button
                    type="button"
                    onClick={onClick}
                    className="text-left transition-colors hover:text-gray-700"
                >
                    {title}
                </button>
            ) : (
                <span>{title}</span>
            )}
        </EventBlock>
    );
}

export function DocEditedBlock({
    filename,
    showConnector,
    isStreaming,
    hasError,
}: {
    filename: string;
    showConnector?: boolean;
    isStreaming?: boolean;
    hasError?: boolean;
}) {
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={hasError ? "red" : "green"}
        >
            <span className="font-medium">
                {isStreaming ? "Editing" : hasError ? "Edit failed" : "Edited"}
            </span>{" "}
            <span>{isStreaming ? `${filename}...` : filename}</span>
        </EventBlock>
    );
}

type CourtEvent = Extract<
    AssistantEvent,
    {
        type:
            | "case_citation"
            | "courtlistener_search_case_law"
            | "courtlistener_get_cases"
            | "courtlistener_find_in_case"
            | "courtlistener_read_case"
            | "courtlistener_verify_citations";
    }
>;

export function CourtlistenerEventBlock({
    event,
    showConnector,
    onOpenCase,
}: {
    event: CourtEvent;
    showConnector: boolean;
    onOpenCase?: (event: Extract<AssistantEvent, { type: "case_citation" }>) => void;
}) {
    let label = "Researching case law";
    if (event.type === "case_citation") {
        label = event.case_name ? `Found ${event.case_name}` : "Found case citation";
    } else if (event.type === "courtlistener_search_case_law") {
        label = event.error
            ? "Case-law search failed"
            : `Searched case law (${event.result_count})`;
    } else if (event.type === "courtlistener_get_cases") {
        label = event.error
            ? "Case fetch failed"
            : `Fetched cases (${event.case_count})`;
    } else if (event.type === "courtlistener_find_in_case") {
        label = event.error
            ? "Case search failed"
            : `Searched case text (${event.total_matches})`;
    } else if (event.type === "courtlistener_read_case") {
        label = event.error
            ? "Case read failed"
            : `Read case opinion (${event.opinion_count})`;
    } else if (event.type === "courtlistener_verify_citations") {
        label = event.error
            ? "Citation lookup failed"
            : `Verified citations (${event.match_count})`;
    }

    const detail =
        event.type === "case_citation"
            ? event.citation
            : event.type === "courtlistener_find_in_case"
              ? event.query
              : undefined;
    const externalHref =
        event.type === "case_citation" ? safeCourtlistenerHref(event.url) : null;

    return (
        <EventBlock
            showConnector={showConnector}
            dotColor={"error" in event && event.error ? "red" : "gray"}
        >
            {event.type === "case_citation" && onOpenCase ? (
                <button
                    type="button"
                    onClick={() => onOpenCase(event)}
                    className="text-left font-medium underline decoration-gray-300 underline-offset-2 transition-colors hover:text-gray-900"
                    title="Open court opinion"
                >
                    {label}
                </button>
            ) : event.type === "case_citation" && externalHref ? (
                <a
                    href={externalHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline decoration-gray-300 underline-offset-2 transition-colors hover:text-gray-900"
                >
                    {label}
                </a>
            ) : (
                <span className="font-medium">{label}</span>
            )}
            {detail && <span className="ml-1 text-gray-400">{detail}</span>}
        </EventBlock>
    );
}

export function McpEventBlock({
    event,
    showConnector,
}: {
    event: Extract<AssistantEvent, { type: "mcp_tool_call" }>;
    showConnector: boolean;
}) {
    const label =
        event.status === "ok"
            ? `Ran ${event.connector_name || "connector"} tool`
            : "Connector tool failed";
    const detail = event.tool_name || event.openai_tool_name;
    return (
        <EventBlock
            showConnector={showConnector}
            dotColor={event.status === "ok" ? "gray" : "red"}
        >
            <span className="font-medium">{label}</span>
            {detail && <span className="ml-1 text-gray-400">{detail}</span>}
            {event.error && <span className="ml-1 text-red-500">{event.error}</span>}
        </EventBlock>
    );
}
