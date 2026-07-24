// Shared TypeScript types for Docket AI legal assistant

export interface DocketFolder {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocketProject {
  id: string;
  user_id: string;
  is_owner?: boolean;
  name: string;
  cm_number: string | null;
  shared_with: string[];
  created_at: string;
  updated_at: string;
  documents?: DocketDocument[];
  folders?: DocketFolder[];
  document_count?: number;
  chat_count?: number;
  review_count?: number;
}

export interface DocketDocument {
  id: string;
  user_id?: string;
  project_id: string | null;
  folder_id?: string | null;
  filename: string;
  file_type: string | null; // pdf | docx | doc
  storage_path: string | null;
  pdf_storage_path: string | null;
  size_bytes: number | null;
  page_count: number | null;
  structure_tree: StructureNode[] | null;
  status: "pending" | "processing" | "ready" | "error";
  created_at: string | null;
  updated_at?: string | null;
  /** Highest active version number across user and assistant history. */
  latest_version_number?: number | null;
}

export interface StructureNode {
  id: string;
  title: string;
  level: number;
  page_number: number | null;
  children: StructureNode[];
}

export interface DocketChat {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  created_at: string;
}

export interface DocketEditAnnotation {
  type?: "edit_data";
  kind?: "edit";
  edit_id: string;
  document_id: string;
  version_id: string;
  /** Per-document monotonic Vn for the edit's target version. */
  version_number?: number | null;
  change_id: string;
  del_w_id?: string;
  ins_w_id?: string;
  deleted_text: string;
  inserted_text: string;
  context_before?: string;
  context_after?: string;
  reason?: string;
  status: "pending" | "accepted" | "rejected";
}

export type DocketAskInputItem =
  | {
      id: string;
      kind: "choice";
      question: string;
      options: { value: string }[];
      allow_other: boolean;
      other_label: string;
      response_prefix?: string;
    }
  | {
      id: string;
      kind: "documents";
      document_types: string[];
      response_prefix?: string;
    };

export type DocketAskInputResponseItem =
  | {
      id: string;
      kind: "choice";
      question?: string;
      answer?: string;
      skipped?: boolean;
    }
  | {
      id: string;
      kind: "documents";
      filenames?: string[];
      skipped?: boolean;
    };

export type DocketAskInputsResponse = {
  request_id: string;
  responses: DocketAskInputResponseItem[];
};

export type AssistantEvent =
  | { type: "reasoning"; text: string; isStreaming?: boolean }
  | {
      type: "ask_inputs";
      request_id: string;
      items: DocketAskInputItem[];
    }
  | ({ type: "ask_inputs_response" } & DocketAskInputsResponse)
  | {
        type: "tool_call_start";
        name: string;
        isStreaming?: boolean;
    }
  | { type: "thinking"; isStreaming?: boolean }
  | {
        type: "doc_read";
        filename: string;
        document_id?: string;
        isStreaming?: boolean;
    }
  | {
        type: "doc_find";
        filename: string;
        query: string;
        total_matches: number;
        isStreaming?: boolean;
    }
  | {
        type: "doc_created";
        filename: string;
        download_url: string;
        /** Set when the generated doc is persisted as a first-class document. */
        document_id?: string;
        version_id?: string;
        version_number?: number | null;
        isStreaming?: boolean;
    }
  | { type: "doc_download"; filename: string; download_url: string }
  | {
        type: "doc_replicated";
        /** Source document filename. */
        filename: string;
        /** How many copies were produced in this single tool call. */
        count: number;
        /** One entry per new copy. Empty while streaming. */
        copies?: {
            new_filename: string;
            document_id: string;
            version_id: string;
        }[];
        error?: string;
        isStreaming?: boolean;
    }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
        type: "case_citation";
        cluster_id: number | null;
        case_name: string | null;
        citation: string | null;
        url: string;
        pdfUrl?: string | null;
        dateFiled?: string | null;
        isStreaming?: boolean;
    }
  | {
        type: "courtlistener_search_case_law";
        query: string;
        result_count: number;
        error?: string;
        isStreaming?: boolean;
    }
  | {
        type: "courtlistener_get_cases";
        cluster_ids: number[];
        case_count: number;
        opinion_count: number;
        cases?: {
            cluster_id: number;
            case_name: string | null;
            citation: string | null;
            dateFiled?: string | null;
            url?: string | null;
        }[];
        error?: string;
        isStreaming?: boolean;
    }
  | {
        type: "courtlistener_find_in_case";
        cluster_id: number | null;
        query: string;
        total_matches: number;
        case_name?: string | null;
        citation?: string | null;
        error?: string;
        isStreaming?: boolean;
    }
  | {
        type: "courtlistener_read_case";
        cluster_id: number | null;
        case_name?: string | null;
        citation?: string | null;
        opinion_count: number;
        error?: string;
        isStreaming?: boolean;
    }
  | {
        type: "courtlistener_verify_citations";
        citation_count: number;
        match_count: number;
        error?: string;
        isStreaming?: boolean;
    }
  | {
        type: "mcp_tool_call";
        connector_id: string;
        connector_name: string;
        tool_name: string;
        openai_tool_name: string;
            status: "ok" | "error" | "approval_required";
            action_kind?: "read" | "mutation";
            execution_outcome?: "failed" | "indeterminate";
        actor_email?: string;
        docket_audit_id?: string;
        approval_id?: string;
            approval_status?:
                | "pending"
                | "executing"
                | "succeeded"
                | "failed"
                | "indeterminate"
                | "rejected"
                | "expired";
        approval_expires_at?: string;
        policy_version?: string;
        practicepanther_audit_note_id?: string;
        practicepanther_audit_status?:
          | "not_required"
          | "pending"
          | "created"
          | "finalized"
          | "failed";
            attribution_warning?: string;
            result_summary?: string;
            error?: string;
        isStreaming?: boolean;
    }
  | {
        type: "doc_edited";
        filename: string;
        document_id: string;
        version_id: string;
        /** Per-document monotonic Vn written at emit time. */
        version_number?: number | null;
        download_url: string;
        annotations: DocketEditAnnotation[];
        error?: string;
        isStreaming?: boolean;
    }
  | { type: "content"; text: string; isStreaming?: boolean };

export interface DocketMessage {
  role: "user" | "assistant";
  content: string;
  files?: { filename: string; document_id?: string }[];
  workflow?: { id: string; title: string };
  model?: string;
  annotations?: DocketCitationAnnotation[];
  citations?: DocketCitation[];
  citationStatus?: "started" | "partial" | "final";
  events?: AssistantEvent[];
  /** Set when streaming failed; rendered as a red error block. */
  error?: string;
  /** True when the backend has created the assistant row but is still streaming. */
  pending?: boolean;
  /** Durable run metadata used to restore Stop after navigation or reload. */
  assistantRun?: DocketAssistantRun;
}

export type DocketAssistantRunStatus =
  | "starting"
  | "queued"
  | "in_progress"
  | "background_pending"
  | "cancel_requested"
  | "running_tools";

export interface DocketAssistantRun {
  streamRequestId: string;
  projectId?: string;
  status: DocketAssistantRunStatus;
}

export interface CitationQuote {
  page: number;
  quote: string;
  sheet?: string;
  cell?: string;
}

/**
 * A citation emitted by the assistant. Single-page citations have a numeric
 * `page` and a plain `quote`. A citation that spans a page break (one
 * continuous sentence cut by a page boundary) has `page` as a range string
 * like "41-42" and a `quote` containing the `[[PAGE_BREAK]]` sentinel at the
 * break point (text before is on page 41, text after is on page 42).
 */
export interface DocketCitationAnnotation {
  type: "citation_data";
  kind?: "document";
  ref: number;
  doc_id: string;
  document_id: string;
  version_id?: string | null;
  version_number?: number | null;
  filename: string;
  page: number | string;
  quote: string;
  sheet?: string;
  cell?: string;
  quotes?: DocketDocumentCitationQuote[];
}

export interface DocketDocumentCitationQuote {
  page: number | string;
  quote: string;
  sheet?: string;
  cell?: string;
}

export interface DocketCaseCitation {
  type: "citation_data";
  kind: "case";
  ref: number;
  cluster_id: number;
  case_name?: string | null;
  citation?: string | null;
  url?: string | null;
  pdfUrl?: string | null;
  dateFiled?: string | null;
  quotes: {
    opinionId: number | null;
    type: string | null;
    author: string | null;
    quote: string;
  }[];
}

export type DocketCitation = DocketCitationAnnotation | DocketCaseCitation;

const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";

/**
 * Expand a citation into one or more (page, quote) entries suitable for
 * highlighting in the PDF viewer. A single-page citation yields one entry; a
 * cross-page citation with page "N-M" and a `[[PAGE_BREAK]]` split yields two.
 */
export function expandCitationToEntries(
  a: DocketCitationAnnotation,
): CitationQuote[] {
  const rangeMatch =
    typeof a.page === "string"
      ? a.page.match(/^(\d+)\s*-\s*(\d+)$/)
      : null;
  if (rangeMatch && a.quote.includes(PAGE_BREAK_SENTINEL)) {
    const startPage = parseInt(rangeMatch[1], 10);
    const endPage = parseInt(rangeMatch[2], 10);
    const [before, after] = a.quote.split(PAGE_BREAK_SENTINEL);
    return [
      {
        page: startPage,
        quote: before.trim(),
        sheet: a.sheet,
        cell: a.cell,
      },
      {
        page: endPage,
        quote: after.trim(),
        sheet: a.sheet,
        cell: a.cell,
      },
    ].filter((e) => e.quote.length > 0);
  }
  const pageNum =
    typeof a.page === "number" ? a.page : parseInt(String(a.page), 10);
  if (!Number.isFinite(pageNum)) return [];
  return [{
    page: pageNum,
    quote: a.quote,
    sheet: a.sheet,
    cell: a.cell,
  }];
}

export function isDocumentCitation(
  citation: DocketCitation,
): citation is DocketCitationAnnotation {
  return citation.kind !== "case";
}

export function getDocumentCitationQuotes(
  citation: DocketCitationAnnotation,
): DocketDocumentCitationQuote[] {
  return citation.quotes?.length
    ? citation.quotes
    : [
        {
          page: citation.page,
          quote: citation.quote,
          sheet: citation.sheet,
          cell: citation.cell,
        },
      ];
}

/** Format the page(s) of a citation for display, e.g. "Page 3" or "Page 41-42". */
export function formatCitationPage(a: DocketCitation): string {
  if (!isDocumentCitation(a)) {
    return a.citation ?? a.case_name ?? `Case ${a.cluster_id}`;
  }
  const quotes = getDocumentCitationQuotes(a);
  const cells = quotes
    .map((quote) =>
      quote.sheet && quote.cell
        ? `${quote.sheet}!${quote.cell}`
        : quote.cell ?? quote.sheet ?? "",
    )
    .filter(Boolean);
  if (cells.length) return Array.from(new Set(cells)).join(", ");
  if (typeof a.page === "string") return `Page ${a.page}`;
  return `Page ${a.page}`;
}

/** Produce a reader-friendly version of the quote (replaces [[PAGE_BREAK]] with "..."). */
export function displayCitationQuote(a: DocketCitation): string {
  if (!isDocumentCitation(a)) {
    return a.quotes
      .map((quote) => quote.quote.replaceAll(PAGE_BREAK_SENTINEL, "..."))
      .join(" / ");
  }
  return getDocumentCitationQuotes(a)
    .map((quote) => quote.quote.replaceAll(PAGE_BREAK_SENTINEL, "..."))
    .join(" / ");
}

// Tabular Review

export type ColumnFormat =
    | "text"
    | "bulleted_list"
    | "number"
    | "currency"
    | "yes_no"
    | "date"
    | "tag"
    | "percentage"
    | "monetary_amount";

export interface ColumnConfig {
    index: number;
    name: string;
    prompt: string;
    format?: ColumnFormat;
    tags?: string[];
}

export interface TabularReview {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  columns_config: ColumnConfig[] | null;
  workflow_id: string | null;
  /** Stable application catalog ID when this review started from a system workflow. */
  system_workflow_id?: string | null;
  practice?: string | null;
  /** Per-review email list. Used so standalone (project_id null) reviews can be shared directly. */
  shared_with?: string[];
  /** Server-set: true when the requesting user is the review's creator. */
  is_owner?: boolean;
  created_at: string;
  updated_at: string;
  document_count?: number;
}

export interface TabularCell {
  id: string;
  review_id: string;
  document_id: string;
  column_index: number;
  content: {
    summary: string;
    flag?: "green" | "grey" | "yellow" | "red";
    reasoning?: string;
  } | null;
  status: "pending" | "generating" | "done" | "error";
  created_at: string;
}

// Workflows

export interface DocketWorkflow {
  id: string;
  user_id: string | null;
  title: string;
  type: "assistant" | "tabular";
  prompt_md: string | null;
  columns_config: ColumnConfig[] | null;
  is_system: boolean;
  created_at: string;
  language?: string | null;
  practice?: string | null;
  jurisdictions?: string[] | null;
  /** Server-owned description for Docket system workflows, if supplied. */
  description?: string | null;
  /** Immutable catalog revision for a Docket system workflow. */
  version?: string | null;
  shared_by_name?: string | null;
  allow_edit?: boolean;
  is_owner?: boolean;
  open_source_submission?: DocketWorkflowContributionSubmission | null;
}

export type DocketWorkflowContributionStatus =
  | "pending_review"
  | "accepted"
  | "declined"
  | "withdrawn";

export interface DocketWorkflowContributionSubmission {
  id: string;
  attribution: "named" | "docket-community";
  public_name: string | null;
  status: DocketWorkflowContributionStatus;
  submitted_at: string;
  updated_at: string;
  reviewed_at?: string | null;
  review_notes?: string | null;
}

// API helpers

export interface DocketChatDetailOut {
  chat: DocketChat;
  messages: DocketMessage[];
}

export interface TabularReviewDetailOut {
  review: TabularReview;
  cells: TabularCell[];
  documents: DocketDocument[];
}
