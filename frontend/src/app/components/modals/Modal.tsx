"use client";

import { useEffect, useEffectEvent, useId, useRef } from "react";
import { X } from "lucide-react";

interface ModalProps {
    open: boolean;
    title: string;
    eyebrow?: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
    onClose: () => void;
    maxWidthClassName?: string;
}

export function Modal({
    open,
    title,
    eyebrow,
    children,
    footer,
    onClose,
    maxWidthClassName = "max-w-2xl",
}: ModalProps) {
    const titleId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    const closeOnEscape = useEffectEvent(() => onClose());

    useEffect(() => {
        if (!open) return;
        const previousFocus = document.activeElement as HTMLElement | null;
        const focusDialog = () => dialogRef.current?.focus();
        const frame = window.requestAnimationFrame(focusDialog);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") closeOnEscape();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => {
            window.cancelAnimationFrame(frame);
            document.removeEventListener("keydown", onKeyDown);
            previousFocus?.focus?.();
        };
    }, [open]);

    if (!open) return null;
    return (
        <div className="fixed inset-0 z-101 flex items-end justify-center bg-black/20 px-3 py-3 backdrop-blur-xs sm:items-center sm:px-6 sm:py-8">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className={`flex max-h-[calc(100dvh-1.5rem)] w-full ${maxWidthClassName} flex-col overflow-hidden rounded-2xl bg-white shadow-2xl outline-none sm:max-h-[90vh]`}
            >
                <div className="flex items-center justify-between px-4 pb-2 pt-5 sm:px-6">
                    <div>
                        {eyebrow && (
                            <div className="text-xs text-gray-400">
                                {eyebrow}
                            </div>
                        )}
                        <h2
                            id={titleId}
                            className="mt-1 text-lg font-medium text-gray-900"
                        >
                            {title}
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close dialog"
                        className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
                    {children}
                </div>
                {footer && (
                    <div className="shrink-0 border-t border-gray-100 px-4 py-4 sm:px-6">
                        {footer}
                    </div>
                )}
            </div>
        </div>
    );
}
