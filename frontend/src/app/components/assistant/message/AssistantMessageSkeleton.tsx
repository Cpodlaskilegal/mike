"use client";

/** Lightweight placeholder used only before the first stream event arrives. */
export function AssistantMessageSkeleton() {
    return (
        <div
            className="space-y-3 py-1 motion-reduce:[&_*]:animate-none"
            aria-live="polite"
            aria-label="Preparing assistant response"
        >
            <div className="h-4 w-full animate-pulse rounded bg-gray-100" />
            <div className="h-4 w-11/12 animate-pulse rounded bg-gray-100 [animation-delay:120ms]" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-gray-100 [animation-delay:240ms]" />
        </div>
    );
}
