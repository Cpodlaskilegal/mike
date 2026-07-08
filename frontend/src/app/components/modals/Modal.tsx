"use client";

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
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-101 flex items-center justify-center bg-black/20 backdrop-blur-xs">
            <div
                className={`flex max-h-[90vh] w-full ${maxWidthClassName} flex-col overflow-hidden rounded-2xl bg-white shadow-2xl`}
            >
                <div className="flex items-center justify-between px-6 pt-5 pb-2">
                    <div>
                        {eyebrow && (
                            <div className="text-xs text-gray-400">
                                {eyebrow}
                            </div>
                        )}
                        <h2 className="mt-1 text-lg font-medium text-gray-900">
                            {title}
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                    {children}
                </div>
                {footer && (
                    <div className="shrink-0 border-t border-gray-100 px-6 py-4">
                        {footer}
                    </div>
                )}
            </div>
        </div>
    );
}
