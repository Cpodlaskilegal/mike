"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function AssistantDiagnosticId({
    id,
    kind,
}: {
    id: string;
    kind: "run" | "request";
}) {
    const [copied, setCopied] = useState(false);
    const label = kind === "run" ? "Run ID" : "Request ID";

    const copyId = async () => {
        try {
            await navigator.clipboard.writeText(id);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    };

    return (
        <span className="inline-flex flex-wrap items-center gap-2 text-xs text-gray-600">
            <span>{label}:</span>
            <code className="break-all select-all">{id}</code>
            <button
                type="button"
                onClick={() => void copyId()}
                aria-label={`Copy ${kind} ID`}
                className="rounded p-1 hover:bg-amber-100"
            >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
        </span>
    );
}
