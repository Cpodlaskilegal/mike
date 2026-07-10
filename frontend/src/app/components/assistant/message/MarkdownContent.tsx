"use client";

import type { RefObject } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
    displayCitationQuote,
    formatCitationPage,
    isDocumentCitation,
} from "../../shared/types";
import type {
    DocketCitation,
    DocketCitationAnnotation,
} from "../../shared/types";

function withoutMarkdownNode<T extends { node?: unknown }>(
    props: T,
): Omit<T, "node"> {
    const { node, ...rest } = props;
    void node;
    return rest;
}

function citationTooltip(citation: DocketCitation): string {
    const locator = formatCitationPage(citation);
    const quote = displayCitationQuote(citation);
    return locator ? `${locator}: "${quote}"` : `"${quote}"`;
}

export function MarkdownContent({
    text,
    citationsList,
    onCitationClick,
    divRef,
}: {
    text: string;
    citationsList: DocketCitation[];
    onCitationClick?: (citation: DocketCitationAnnotation) => void;
    divRef?: RefObject<HTMLDivElement | null>;
}) {
    return (
        <div
            ref={divRef}
            className="prose prose-sm mb-4 max-w-none text-base font-serif text-gray-900"
        >
            <ReactMarkdown
                remarkPlugins={[
                    [remarkMath, { singleDollarTextMath: false }],
                    remarkGfm,
                ]}
                rehypePlugins={[rehypeKatex]}
                urlTransform={defaultUrlTransform}
                components={{
                    table: (props) => (
                        <div className="-mx-1 my-4 overflow-x-auto overscroll-contain px-1">
                            <table
                                className="min-w-[38rem] divide-y divide-gray-300 overflow-hidden rounded-lg border border-gray-200 text-sm"
                                {...withoutMarkdownNode(props)}
                            />
                        </div>
                    ),
                    thead: (props) => (
                        <thead
                            className="bg-gray-50"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    tbody: (props) => (
                        <tbody
                            className="divide-y divide-gray-200 bg-white"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    tr: (props) => <tr {...withoutMarkdownNode(props)} />,
                    th: (props) => (
                        <th
                            className="px-3 py-3 text-left text-xs font-semibold text-gray-900 sm:text-sm"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    td: (props) => (
                        <td
                            className="whitespace-normal px-3 py-3 text-xs text-gray-900 sm:py-4 sm:text-sm"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    h1: (props) => (
                        <h1
                            className="mb-4 mt-6 text-2xl font-serif font-semibold sm:text-3xl"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    h2: (props) => (
                        <h2
                            className="mb-3 mt-5 text-xl font-serif font-semibold sm:text-2xl"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    h3: (props) => (
                        <h3
                            className="mb-2 mt-4 text-lg font-semibold sm:text-xl"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    h4: (props) => (
                        <h4
                            className="mb-2 mt-4 text-base font-semibold sm:text-lg"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    p: ({ node, ...props }) => {
                        const parent =
                            node && typeof node === "object" && "parent" in node
                                ? (node as { parent?: { type?: string } }).parent
                                : undefined;
                        return parent?.type === "listItem" ? (
                            <p className="m-0 inline leading-7" {...props} />
                        ) : (
                            <p className="mb-4 leading-7" {...props} />
                        );
                    },
                    ul: (props) => (
                        <ul
                            className="mb-4 list-outside list-disc pl-6"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    ol: (props) => (
                        <ol
                            className="mb-4 list-outside list-decimal pl-6"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    li: (props) => (
                        <li
                            className="mb-2 leading-7"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    strong: (props) => (
                        <strong
                            className="font-semibold"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    em: (props) => (
                        <em
                            className="italic"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    code: (markdownProps) => {
                        const { children, ...props } =
                            withoutMarkdownNode(markdownProps);
                        const tokenMatch = String(children).match(/^§(\d+)§$/);
                        if (tokenMatch) {
                            const citation = citationsList[
                                Number.parseInt(tokenMatch[1], 10)
                            ];
                            if (citation) {
                                const title = citationTooltip(citation);
                                if (!isDocumentCitation(citation)) {
                                    return citation.url ? (
                                        <a
                                            href={defaultUrlTransform(citation.url)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="mx-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-indigo-50 text-[10px] font-medium align-super text-indigo-800 transition-colors hover:bg-indigo-100"
                                            title={title}
                                        >
                                            {citation.ref}
                                        </a>
                                    ) : (
                                        <span
                                            className="mx-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-indigo-50 text-[10px] font-medium align-super text-indigo-800"
                                            title={title}
                                        >
                                            {citation.ref}
                                        </span>
                                    );
                                }
                                return (
                                    <button
                                        type="button"
                                        onClick={() => onCitationClick?.(citation)}
                                        className="mx-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-100 text-[10px] font-medium align-super text-gray-900 transition-colors hover:bg-gray-200"
                                        title={title}
                                    >
                                        {citation.ref}
                                    </button>
                                );
                            }
                        }
                        return (
                            <code
                                className="rounded bg-gray-100 px-1.5 py-0.5 text-sm font-serif"
                                {...props}
                            >
                                {children}
                            </code>
                        );
                    },
                    blockquote: (props) => (
                        <blockquote
                            className="my-4 border-l-4 border-gray-300 pl-4 italic"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    a: (markdownProps) => {
                        const { href, children, ...props } =
                            withoutMarkdownNode(markdownProps);
                        return (
                            <a
                                href={href}
                                className="text-blue-600 underline hover:text-blue-700"
                                target="_blank"
                                rel="noopener noreferrer"
                                {...props}
                            >
                                {children}
                            </a>
                        );
                    },
                    hr: (props) => (
                        <hr
                            className="my-6 border-gray-200"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}
