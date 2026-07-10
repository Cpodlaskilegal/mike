"use client";

import { useEffect, useRef, useState } from "react";
import { DocketIcon } from "@/components/chat/docket-icon";

export type AssistantResponseStatus = "active" | "error" | null;

/**
 * Keeps the status icon lifecycle independent from the message renderer.
 * The short completion state is deliberately visual only: stream content and
 * error handling remain owned by the surrounding assistant message.
 */
export function ResponseStatus({
    status,
}: {
    status: AssistantResponseStatus;
}) {
    const [showDone, setShowDone] = useState(false);
    const [doneVisible, setDoneVisible] = useState(false);
    const wasActiveRef = useRef(false);

    const isActive = status === "active";
    const isError = status === "error";

    useEffect(() => {
        const wasActive = wasActiveRef.current;
        wasActiveRef.current = isActive;

        let completionTimer: number | undefined;
        if (wasActive && !isActive) {
            setShowDone(true);
            setDoneVisible(true);
            completionTimer = window.setTimeout(
                () => setDoneVisible(false),
                1500,
            );
        } else if (!wasActive && isActive) {
            setShowDone(false);
            setDoneVisible(false);
        }

        return () => {
            if (completionTimer) window.clearTimeout(completionTimer);
        };
    }, [isActive]);

    return (
        <div className="mb-2 flex h-9 w-full items-center" aria-live="polite">
            <DocketIcon
                spin={isActive}
                done={showDone && doneVisible}
                error={isError}
                size={22}
            />
        </div>
    );
}
