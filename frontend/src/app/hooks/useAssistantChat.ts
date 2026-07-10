"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getChat, streamChat, streamProjectChat } from "@/app/lib/docketApi";
import { describeChatError } from "@/app/lib/chatErrors";
import { buildAssistantGenerationPayload } from "@/app/lib/assistantChatPayload";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAssistantGenerationSettings } from "@/app/contexts/AssistantGenerationSettingsContext";
import { useGenerateChatTitle } from "./useGenerateChatTitle";
import type {
    AssistantEvent,
    DocketAskInputsResponse,
    DocketCitation,
    DocketCitationAnnotation,
    DocketMessage,
} from "@/app/components/shared/types";

interface UseAssistantChatOptions {
    initialMessages?: DocketMessage[];
    chatId?: string;
    projectId?: string;
}

function findLastContentIndex(events: AssistantEvent[]): number {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "content") return i;
    }
    return -1;
}

function replaceBrowserUrlForChat(chatId: string, projectId?: string) {
    if (typeof window === "undefined") return;
    const chatBasePath = projectId
        ? `/projects/${projectId}/assistant/chat`
        : `/assistant/chat`;
    const nextPath = `${chatBasePath}/${chatId}`;
    if (window.location.pathname === nextPath) return;
    window.history.replaceState(null, "", nextPath);
}

function assistantMessageText(message: DocketMessage): string {
    if (message.role !== "assistant") return message.content;
    const content = message.content?.trim();
    if (content) return message.content;
    return (
        message.events
            ?.filter((event) => event.type === "content")
            .map((event) => event.text)
            .join("") ?? ""
    );
}

export function useAssistantChat({
    initialMessages = [],
    chatId: initialChatId,
    projectId,
}: UseAssistantChatOptions = {}) {
    const router = useRouter();
    const {
        replaceChatId,
        loadChats,
        setCurrentChatId,
        saveChat,
        setNewChatMessages,
    } = useChatHistoryContext();
    const {
        activateSession,
        adoptCreatedChat,
        effectiveSettings,
        hydrated,
    } =
        useAssistantGenerationSettings();
    const { generate: generateTitle } = useGenerateChatTitle();

    const sessionIdentity = projectId
        ? `project:${projectId}:${initialChatId ?? "new"}`
        : initialChatId
          ? `assistant:${initialChatId}`
          : "new:assistant";

    const [messages, setMessages] = useState<DocketMessage[]>(initialMessages);
    const [isResponseLoading, setIsResponseLoading] = useState(false);
    const [isLoadingCitations, setIsLoadingCitations] = useState(false);
    const [chatId, setChatId] = useState<string | undefined>(initialChatId);
    const [activatedSessionKey, setActivatedSessionKey] = useState<
        string | null
    >(null);

    const abortControllerRef = useRef<AbortController | null>(null);
    const adoptedCreatedChatRef = useRef(false);
    const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(
        null,
    );

    const dripIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const dripTargetRef = useRef<string>("");
    const dripDisplayLenRef = useRef<number>(0);
    const eventsRef = useRef<AssistantEvent[]>([]);
    const DRIP_CHARS_PER_TICK = 8;
    const sessionReady = activatedSessionKey === sessionIdentity;

    useEffect(() => {
        if (!hydrated) return;
        adoptedCreatedChatRef.current = false;
        activateSession(sessionIdentity);
        setActivatedSessionKey(sessionIdentity);
    }, [activateSession, hydrated, sessionIdentity]);

    const stopDrip = () => {
        if (dripIntervalRef.current !== null) {
            clearInterval(dripIntervalRef.current);
            dripIntervalRef.current = null;
        }
    };

    // Without this, navigating away mid-stream leaves the SSE connection and
    // 60Hz drip timer running. On Safari (single shared NetworkProcess) a
    // handful of orphaned streams will eventually wedge the whole browser.
    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort();
            abortControllerRef.current = null;
            const r = readerRef.current;
            readerRef.current = null;
            if (r) {
                r.cancel().catch(() => {});
            }
            if (dripIntervalRef.current !== null) {
                clearInterval(dripIntervalRef.current);
                dripIntervalRef.current = null;
            }
        };
    }, []);

    const updateLastContentEvent = (
        prev: DocketMessage[],
        text: string,
        isStreaming?: boolean,
    ): DocketMessage[] => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role !== "assistant") return prev;
        const events = last.events ?? [];
        const idx = findLastContentIndex(events);
        if (idx < 0) return prev;
        const current = events[idx];
        if (
            current.type === "content" &&
            current.text === text &&
            !!current.isStreaming === !!isStreaming
        ) {
            return prev;
        }
        const newEvents = [...events];
        newEvents[idx] = isStreaming
            ? { type: "content", text, isStreaming: true }
            : { type: "content", text };
        updated[updated.length - 1] = { ...last, events: newEvents };
        return updated;
    };

    const flushDrip = () => {
        stopDrip();
        const target = dripTargetRef.current;
        dripDisplayLenRef.current = target.length;
        setMessages((prev) => updateLastContentEvent(prev, target));
    };

    /**
     * Finalize any in-flight streaming content event and reset the drip
     * counters so the next content_delta starts a fresh block. Called
     * before any non-content event is appended, so interleaved content /
     * reasoning / tool events stay in chronological order — without the
     * later content block inheriting the earlier block's accumulated text.
     */
    const finalizeStreamingContent = () => {
        stopDrip();
        const events = eventsRef.current;
        const last = events[events.length - 1];
        if (last?.type === "content" && last.isStreaming) {
            const finalText = dripTargetRef.current;
            eventsRef.current = [
                ...events.slice(0, -1),
                { type: "content", text: finalText },
            ];
            const snapshot = [...eventsRef.current];
            setMessages((prev) => {
                const updated = [...prev];
                const lastMsg = updated[updated.length - 1];
                if (lastMsg?.role === "assistant") {
                    updated[updated.length - 1] = {
                        ...lastMsg,
                        events: snapshot,
                    };
                }
                return updated;
            });
        }
        dripTargetRef.current = "";
        dripDisplayLenRef.current = 0;
    };

    // If the model transitions from reasoning into content/tool without a
    // reasoning_block_end (or the events arrive out of order), the prior
    // reasoning event would otherwise stay flagged isStreaming forever.
    const finalizeStreamingReasoning = () => {
        const events = eventsRef.current;
        const last = events[events.length - 1];
        if (last?.type !== "reasoning" || !last.isStreaming) return;
        eventsRef.current = [
            ...events.slice(0, -1),
            { type: "reasoning", text: last.text },
        ];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const lastMsg = updated[updated.length - 1];
            if (lastMsg?.role === "assistant") {
                updated[updated.length - 1] = {
                    ...lastMsg,
                    events: snapshot,
                };
            }
            return updated;
        });
    };

    const startDrip = () => {
        if (dripIntervalRef.current !== null) return;
        dripIntervalRef.current = setInterval(() => {
            const target = dripTargetRef.current;
            const displayLen = dripDisplayLenRef.current;
            if (displayLen >= target.length) {
                stopDrip();
                return;
            }

            const newLen = Math.min(
                displayLen + DRIP_CHARS_PER_TICK,
                target.length,
            );
            dripDisplayLenRef.current = newLen;
            const visibleText = target.slice(0, newLen);
            const events = eventsRef.current;
            const lastIdx = events.length - 1;
            const last = events[lastIdx];
            if (last?.type === "content" && last.isStreaming) {
                const next = events.slice();
                next[lastIdx] = {
                    type: "content",
                    text: visibleText,
                    isStreaming: true,
                };
                eventsRef.current = next;
            }

            setMessages((prev) =>
                updateLastContentEvent(prev, visibleText, true),
            );

            if (newLen >= target.length) {
                stopDrip();
            }
        }, 16);
    };

    useEffect(() => {
        return () => stopDrip();
    }, []);

    const pendingAssistantCount = messages.filter(
        (message) => message.role === "assistant" && message.pending,
    ).length;

    useEffect(() => {
        if (!chatId || pendingAssistantCount === 0) return;

        let cancelled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;

        const poll = async () => {
            try {
                const { messages: loaded } = await getChat(chatId);
                if (cancelled) return;
                setMessages(loaded);
                const stillPending = loaded.some(
                    (message) =>
                        message.role === "assistant" && message.pending,
                );
                if (stillPending) {
                    timeout = setTimeout(poll, 2000);
                    return;
                }
                setIsResponseLoading(false);
                setIsLoadingCitations(false);
                void loadChats();
            } catch {
                if (!cancelled) timeout = setTimeout(poll, 4000);
            }
        };

        setIsResponseLoading(true);
        timeout = setTimeout(poll, 1500);

        return () => {
            cancelled = true;
            if (timeout) clearTimeout(timeout);
        };
    }, [chatId, pendingAssistantCount, loadChats]);

    const cancel = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsResponseLoading(false);
            setIsLoadingCitations(false);
        }
    };

    // Transient placeholder events (tool_call_start, thinking) fill the
    // latency gap between real SSE events so the wrapper doesn't look stuck.
    // Anytime a real event arrives, drop any streaming placeholder first.
    const isStreamingPlaceholder = (e: AssistantEvent) =>
        (e.type === "tool_call_start" || e.type === "thinking") &&
        !!e.isStreaming;

    const clearStreamingPlaceholders = () => {
        const before = eventsRef.current;
        const after = before.filter((e) => !isStreamingPlaceholder(e));
        if (after.length === before.length) return;
        eventsRef.current = after;
        const snapshot = [...after];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    };

    const pushThinkingPlaceholder = () => {
        const events = eventsRef.current;
        const last = events[events.length - 1];
        // Don't stack placeholders back-to-back; one "Thinking…" line is plenty.
        if (last && isStreamingPlaceholder(last)) return;
        eventsRef.current = [
            ...events,
            { type: "thinking" as const, isStreaming: true },
        ];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const lastMsg = updated[updated.length - 1];
            if (lastMsg?.role === "assistant") {
                updated[updated.length - 1] = { ...lastMsg, events: snapshot };
            }
            return updated;
        });
    };

    const pushEvent = (event: AssistantEvent) => {
        finalizeStreamingContent();
        finalizeStreamingReasoning();
        // A real event, or a more specific placeholder such as
        // tool_call_start, should replace any generic "Thinking..." line.
        const next = eventsRef.current.filter(
            (e) => !isStreamingPlaceholder(e),
        );
        eventsRef.current = [...next, event];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    };

    const updateMatchingEvent = (
        predicate: (e: AssistantEvent) => boolean,
        updater: (e: AssistantEvent) => AssistantEvent,
    ) => {
        const events = eventsRef.current;
        const idx = [...events]
            .map((_, i) => i)
            .reverse()
            .find((i) => predicate(events[i]));
        if (idx === undefined) return;
        const newEvents = [...events];
        newEvents[idx] = updater(events[idx]);
        eventsRef.current = newEvents;
        const snapshot = [...newEvents];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    };

    const handleChat = async (
        message: DocketMessage,
        opts?: {
            displayedDoc?: { filename: string; documentId: string } | null;
            askInputsResponse?: DocketAskInputsResponse;
        },
    ): Promise<string | null> => {
        if (!sessionReady || !message.content.trim()) return null;

        setIsResponseLoading(true);

        const lastMessage = messages[messages.length - 1];
        const isMessageAlreadyAdded =
            lastMessage &&
            lastMessage.role === "user" &&
            lastMessage.content === message.content;

        const newMessages: DocketMessage[] = isMessageAlreadyAdded
            ? messages
            : [...messages, message];

        setMessages([
            ...newMessages,
            { role: "assistant", content: "", annotations: [], events: [] },
        ]);

        let streamedChatId: string | null = null;

        stopDrip();
        dripTargetRef.current = "";
        dripDisplayLenRef.current = 0;
        eventsRef.current = [];

        try {
            const controller = new AbortController();
            abortControllerRef.current = controller;

            const apiMessages = newMessages
                .map((currentMessage) => ({
                    role: currentMessage.role,
                    content:
                        currentMessage.role === "assistant"
                            ? assistantMessageText(currentMessage)
                            : currentMessage.content,
                    files: currentMessage.files,
                    workflow: currentMessage.workflow,
                }))
                .filter(
                    (currentMessage) =>
                        currentMessage.role !== "assistant" ||
                        currentMessage.content.trim().length > 0,
                );

            const generationPayload = buildAssistantGenerationPayload(
                effectiveSettings,
            );

            const displayedDoc = opts?.displayedDoc ?? null;

            // Pull the user's attachments from the just-submitted message.
            // These are the files dragged into / picked from the chat input
            // for this turn (separate from the running history of past
            // attachments). Sent as a request-level field so the backend
            // can call them out specifically in the system prompt.
            const attachedDocs = (
                message.files?.filter((f) => !!f.document_id) ?? []
            ).map((f) => ({
                filename: f.filename,
                document_id: f.document_id as string,
            }));

            const response = await (projectId
                ? streamProjectChat({
                      projectId,
                      messages: apiMessages,
                      chat_id: chatId,
                      ...generationPayload,
                      displayed_doc: displayedDoc
                          ? {
                                filename: displayedDoc.filename,
                                document_id: displayedDoc.documentId,
                            }
                          : undefined,
                      attached_documents:
                          attachedDocs.length > 0 ? attachedDocs : undefined,
                      ask_inputs_response: opts?.askInputsResponse,
                      signal: controller.signal,
                  })
                : streamChat({
                      messages: apiMessages,
                      chat_id: chatId,
                      ...generationPayload,
                      ask_inputs_response: opts?.askInputsResponse,
                      signal: controller.signal,
                  }));

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(errText || `HTTP ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response body");
            readerRef.current = reader;

            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data:")) continue;

                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === "[DONE]") continue;

                    try {
                        const data = JSON.parse(dataStr);

                        if (data.type === "error") {
                            const streamError = new Error(
                                typeof data.message === "string"
                                    ? data.message
                                    : "The assistant failed before it could finish.",
                            );
                            streamError.name = "DocketStreamError";
                            throw streamError;
                        }

                        if (data.type === "chat_id") {
                            streamedChatId = data.chatId;
                            if (
                                !projectId &&
                                !initialChatId &&
                                !adoptedCreatedChatRef.current
                            ) {
                                adoptedCreatedChatRef.current = true;
                                adoptCreatedChat(
                                    `assistant:${data.chatId as string}`,
                                );
                            }
                            setChatId(data.chatId);
                            setCurrentChatId(data.chatId);
                            replaceBrowserUrlForChat(data.chatId, projectId);
                            continue;
                        }

                        if (data.type === "content_done") {
                            setIsLoadingCitations(true);
                            continue;
                        }

                        if (data.type === "content_delta") {
                            const text = data.text as string;

                            // Real content is streaming — retire any
                            // "Thinking…" / "Running…" placeholders, and
                            // finalize any in-flight reasoning block so it
                            // doesn't get stuck rendering as streaming.
                            clearStreamingPlaceholders();
                            finalizeStreamingReasoning();

                            // Ensure a streaming content event exists. If
                            // the last event isn't already a streaming
                            // content block, start a fresh one — and reset
                            // the drip so we don't inherit a previous
                            // block's accumulated text.
                            const events = eventsRef.current;
                            const lastEvent = events[events.length - 1];
                            if (
                                lastEvent?.type !== "content" ||
                                !lastEvent.isStreaming
                            ) {
                                dripTargetRef.current = text;
                                dripDisplayLenRef.current = 0;
                                eventsRef.current = [
                                    ...events,
                                    {
                                        type: "content" as const,
                                        text: "",
                                        isStreaming: true,
                                    },
                                ];
                                const snapshot = [...eventsRef.current];
                                setMessages((prev) => {
                                    const updated = [...prev];
                                    const last = updated[updated.length - 1];
                                    if (last?.role === "assistant") {
                                        updated[updated.length - 1] = {
                                            ...last,
                                            events: snapshot,
                                        };
                                    }
                                    return updated;
                                });
                            } else {
                                dripTargetRef.current += text;
                            }

                            startDrip();
                            continue;
                        }

                        if (data.type === "reasoning_delta") {
                            const text = data.text as string;
                            let events = eventsRef.current;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                eventsRef.current = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text + text,
                                        isStreaming: true,
                                    },
                                ];
                            } else {
                                // New reasoning block — finalize any in-flight
                                // content event first so the next content_delta
                                // starts a fresh block at the correct position.
                                finalizeStreamingContent();
                                clearStreamingPlaceholders();
                                events = eventsRef.current;
                                eventsRef.current = [
                                    ...events,
                                    {
                                        type: "reasoning" as const,
                                        text,
                                        isStreaming: true,
                                    },
                                ];
                            }
                            const snapshot = [...eventsRef.current];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }

                        if (data.type === "reasoning_block_end") {
                            const events = eventsRef.current;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                eventsRef.current = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text,
                                    },
                                ];
                            }
                            const snapshot = [...eventsRef.current];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "tool_call_start") {
                            // Transient placeholder so the client immediately
                            // shows activity after Claude ends a turn with
                            // tool_use. Replaced by the real tool event
                            // (doc_edited_start, doc_read_start, …) if one
                            // arrives; otherwise it lingers as a "Working…"
                            // indicator until the next iteration streams.
                            pushEvent({
                                type: "tool_call_start",
                                name: (data.name as string) ?? "",
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "workflow_applied") {
                            pushEvent({
                                type: "workflow_applied",
                                workflow_id: data.workflow_id as string,
                                title: data.title as string,
                            });
                            continue;
                        }

                        if (data.type === "ask_inputs") {
                            if (
                                typeof data.request_id === "string" &&
                                Array.isArray(data.items)
                            ) {
                                pushEvent({
                                    type: "ask_inputs",
                                    request_id: data.request_id,
                                    items: data.items as Extract<
                                        AssistantEvent,
                                        { type: "ask_inputs" }
                                    >["items"],
                                });
                            }
                            continue;
                        }

                        if (data.type === "case_citation") {
                            pushEvent({
                                type: "case_citation",
                                cluster_id:
                                    typeof data.cluster_id === "number"
                                        ? data.cluster_id
                                        : null,
                                case_name:
                                    typeof data.case_name === "string"
                                        ? data.case_name
                                        : null,
                                citation:
                                    typeof data.citation === "string"
                                        ? data.citation
                                        : null,
                                url: data.url as string,
                                pdfUrl:
                                    typeof data.pdfUrl === "string"
                                        ? data.pdfUrl
                                        : null,
                                dateFiled:
                                    typeof data.dateFiled === "string"
                                        ? data.dateFiled
                                        : null,
                            });
                            continue;
                        }

                        if (
                            data.type === "courtlistener_search_case_law" ||
                            data.type === "courtlistener_get_cases" ||
                            data.type === "courtlistener_find_in_case" ||
                            data.type === "courtlistener_read_case" ||
                            data.type === "courtlistener_verify_citations"
                        ) {
                            pushEvent(data as AssistantEvent);
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "mcp_tool_call_start") {
                            pushEvent({
                                type: "tool_call_start",
                                name:
                                    typeof data.openai_tool_name === "string"
                                        ? data.openai_tool_name
                                        : "mcp_tool_call",
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "mcp_tool_call") {
                            pushEvent(data as AssistantEvent);
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_read_start") {
                            pushEvent({
                                type: "doc_read",
                                filename: data.filename as string,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_read") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_read" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => ({ ...e, isStreaming: false }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_find_start") {
                            pushEvent({
                                type: "doc_find",
                                filename: data.filename as string,
                                query: (data.query as string) ?? "",
                                total_matches: 0,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_find") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_find" &&
                                    e.filename === data.filename &&
                                    e.query === (data.query as string) &&
                                    !!e.isStreaming,
                                (e) => ({
                                    ...e,
                                    isStreaming: false,
                                    total_matches:
                                        typeof data.total_matches === "number"
                                            ? (data.total_matches as number)
                                            : (
                                                  e as {
                                                      type: "doc_find";
                                                      total_matches: number;
                                                  }
                                              ).total_matches,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_created_start") {
                            pushEvent({
                                type: "doc_created",
                                filename: data.filename as string,
                                download_url: "",
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_download") {
                            pushEvent({
                                type: "doc_download",
                                filename: data.filename as string,
                                download_url: data.download_url as string,
                            });
                            continue;
                        }

                        if (data.type === "doc_created") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_created" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => {
                                    const next: Extract<
                                        AssistantEvent,
                                        { type: "doc_created" }
                                    > = {
                                        type: "doc_created",
                                        filename: (e as { filename: string })
                                            .filename,
                                        download_url:
                                            data.download_url as string,
                                        isStreaming: false,
                                    };
                                    if (typeof data.document_id === "string") {
                                        next.document_id =
                                            data.document_id as string;
                                    }
                                    if (typeof data.version_id === "string") {
                                        next.version_id =
                                            data.version_id as string;
                                    }
                                    if (
                                        typeof data.version_number === "number"
                                    ) {
                                        next.version_number =
                                            data.version_number as number;
                                    }
                                    return next;
                                },
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_replicate_start") {
                            pushEvent({
                                type: "doc_replicated",
                                filename: data.filename as string,
                                count:
                                    typeof data.count === "number"
                                        ? (data.count as number)
                                        : 1,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_replicated") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_replicated" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "doc_replicated",
                                    filename: data.filename as string,
                                    count:
                                        typeof data.count === "number"
                                            ? (data.count as number)
                                            : Array.isArray(data.copies)
                                              ? (data.copies as unknown[])
                                                    .length
                                              : 1,
                                    copies: Array.isArray(data.copies)
                                        ? (data.copies as {
                                              new_filename: string;
                                              document_id: string;
                                              version_id: string;
                                          }[])
                                        : undefined,
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_edited_start") {
                            pushEvent({
                                type: "doc_edited",
                                filename: data.filename as string,
                                document_id: "",
                                version_id: "",
                                download_url: "",
                                annotations: [],
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_edited") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_edited" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "doc_edited",
                                    filename: data.filename as string,
                                    document_id:
                                        (data.document_id as string) ?? "",
                                    version_id:
                                        (data.version_id as string) ?? "",
                                    version_number:
                                        typeof data.version_number === "number"
                                            ? (data.version_number as number)
                                            : null,
                                    download_url:
                                        (data.download_url as string) ?? "",
                                    annotations: Array.isArray(data.annotations)
                                        ? (data.annotations as import("@/app/components/shared/types").DocketEditAnnotation[])
                                        : [],
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "citations") {
                            const citationStatus =
                                data.status === "started" ||
                                data.status === "partial" ||
                                data.status === "final"
                                    ? data.status
                                    : "final";
                            if (citationStatus === "final") {
                                // End-of-stream signal — scrub any lingering
                                // placeholders so they don't persist into the
                                // finalised message.
                                clearStreamingPlaceholders();
                            }
                            const incoming = (data.citations ??
                                []) as DocketCitation[];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        citations: incoming,
                                        citationStatus,
                                        annotations: incoming.filter(
                                            (citation): citation is DocketCitationAnnotation =>
                                                citation.kind !== "case",
                                        ),
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }
                    } catch (e) {
                        if (e instanceof Error && e.name === "DocketStreamError") {
                            throw e;
                        }
                        console.warn(
                            "[useAssistantChat] failed to parse SSE line:",
                            trimmed,
                            e,
                        );
                    }
                }
            }

            flushDrip();
            finalizeStreamingReasoning();
            setIsResponseLoading(false);
            setIsLoadingCitations(false);

            const finalChatId = streamedChatId || chatId || null;
            if (finalChatId && finalChatId !== chatId) {
                if (chatId) {
                    replaceChatId(
                        chatId,
                        finalChatId,
                        message.content.trim().slice(0, 120) || "New Chat",
                    );
                }
                setCurrentChatId(finalChatId);
                const chatBasePath = projectId
                    ? `/projects/${projectId}/assistant/chat`
                    : `/assistant/chat`;
                const nextPath = `${chatBasePath}/${finalChatId}`;
                if (
                    typeof window === "undefined" ||
                    window.location.pathname !== nextPath
                ) {
                    router.replace(nextPath);
                }
            }

            await loadChats();

            const finalChatIdForTitle = streamedChatId || chatId || null;
            if (finalChatIdForTitle && newMessages.length === 1) {
                const titleParts = [message.content];
                if (message.workflow)
                    titleParts.push(`Workflow: ${message.workflow.title}`);
                if (message.files?.length)
                    titleParts.push(
                        `Files: ${message.files.map((f) => f.filename).join(", ")}`,
                    );
                void generateTitle(finalChatIdForTitle, titleParts.join("\n"));
            }

            return streamedChatId || null;
        } catch (error: unknown) {
            if (error instanceof Error && error.name === "AbortError") {
                flushDrip();
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant") {
                        const updated = [...prev];
                        const events = last.events ?? [];
                        const idx = findLastContentIndex(events);
                        const cancelText = "Cancelled by user";
                        if (idx >= 0) {
                            const newEvents = [...events];
                            const existing = newEvents[idx] as {
                                type: "content";
                                text: string;
                            };
                            newEvents[idx] = {
                                type: "content",
                                text: existing.text
                                    ? `${existing.text}\n\nCancelled by user`
                                    : cancelText,
                            };
                            updated[updated.length - 1] = {
                                ...last,
                                events: newEvents,
                            };
                        } else {
                            updated[updated.length - 1] = {
                                ...last,
                                events: [
                                    ...events,
                                    { type: "content", text: cancelText },
                                ],
                            };
                        }
                        return updated;
                    }
                    return [
                        ...prev,
                        {
                            role: "assistant",
                            content: "",
                            events: [
                                { type: "content", text: "Cancelled by user" },
                            ],
                        },
                    ];
                });
            } else {
                stopDrip();
                const errorMessage = describeChatError(error);
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant") {
                        const updated = [...prev];
                        updated[updated.length - 1] = {
                            ...last,
                            error: errorMessage,
                        };
                        return updated;
                    }
                    return [
                        ...prev,
                        {
                            role: "assistant",
                            content: "",
                            error: errorMessage,
                        },
                    ];
                });
            }

            setIsResponseLoading(false);
            setIsLoadingCitations(false);
            return null;
        } finally {
            const r = readerRef.current;
            readerRef.current = null;
            if (r) {
                try {
                    await r.cancel();
                } catch {
                    // reader may already be released or cancelled
                }
            }
            abortControllerRef.current = null;
        }
    };

    const submitAskInputs = (
        response: DocketAskInputsResponse,
        content: string,
        files: { filename: string; document_id: string }[],
    ) =>
        handleChat(
            {
                role: "user",
                content,
                files: files.length ? files : undefined,
            },
            { askInputsResponse: response },
        );

    const handleNewChat = async (
        message: DocketMessage,
        projectId?: string,
    ): Promise<string | null> => {
        if (!message.content.trim()) return null;

        setMessages([message]);
        setNewChatMessages([message]);

        const newChatId = await saveChat(projectId);
        if (newChatId) {
            setChatId(newChatId);
            setCurrentChatId(newChatId);
        }

        return newChatId;
    };

    return {
        messages,
        isResponseLoading: isResponseLoading || !sessionReady,
        setIsResponseLoading,
        isLoadingCitations,
        handleChat,
        submitAskInputs,
        handleNewChat,
        setMessages,
        cancel,
        chatId,
    };
}
