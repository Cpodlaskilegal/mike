export type CourtlistenerToolEvent =
    | {
          type: "courtlistener_search_case_law";
          query: string;
          result_count: number;
          error?: string;
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
      }
    | {
          type: "courtlistener_find_in_case";
          cluster_id: number | null;
          query: string;
          total_matches: number;
          case_name?: string | null;
          citation?: string | null;
          searches?: {
              cluster_id: number | null;
              query: string;
              total_matches: number;
              case_name?: string | null;
              citation?: string | null;
              error?: string;
          }[];
          error?: string;
      }
    | {
          type: "courtlistener_read_case";
          cluster_id: number | null;
          case_name?: string | null;
          citation?: string | null;
          opinion_count: number;
          error?: string;
      }
    | {
          type: "courtlistener_verify_citations";
          citation_count: number;
          match_count: number;
          error?: string;
      };

export type CaseCitationEvent = {
    type: "case_citation";
    cluster_id: number | null;
    case_name: string | null;
    citation: string | null;
    url: string;
    pdfUrl?: string | null;
    dateFiled?: string | null;
};

export const COURTLISTENER_TOOL_NAMES = {
    searchCaseLaw: "courtlistener_search_case_law",
    getCases: "courtlistener_get_cases",
    findInCase: "courtlistener_find_in_case",
    readCase: "courtlistener_read_case",
    verifyCitations: "courtlistener_verify_citations",
} as const;

export const COURTLISTENER_SYSTEM_PROMPT = `US CASE LAW RESEARCH:
Use CourtListener when answering US-law questions that require case law.

Workflow:
1. If you have reporter citations, verify them with courtlistener_verify_citations using only clean citations: {"citations":["467 U.S. 837","323 U.S. 134"]}. Never pass case names to this tool.
2. Fetch matched clusters with courtlistener_get_cases.
3. Get cite-worthy text from the fetched cases with courtlistener_find_in_case. Use short 1-3 word searches, maximum 3 searches per assistant turn.
4. If snippets are not enough, read only the necessary opinion(s) with courtlistener_read_case. For multi-opinion cases, choose the specific opinion_id/opinionIds needed; do not read all opinions by default.

Citation rules:
- Final case citations must be based on opinion text or passage snippets supplied in this turn. Do not cite cases based only on memory, metadata, search results, citationLinks, or verification results.
- If you mention a CourtListener case as legal support in the final answer, cite it with both: (a) the clickable markdown link returned in citationLinks, and (b) an inline [N] marker. Include the clickable case link only the first time you cite that case; later references to the same case should use the existing inline [N] marker without repeating the link unless clarity requires it.
- Assign new annotation refs in first-use order as much as possible: [1], then [2], then [3]. Reuse an existing ref when citing the same case/passage again, even if that means a later sentence cites [3] and then [1] again.
- The final <CITATIONS> block must include one matching case entry for each [N] case marker: {"ref": N, "cluster_id": 123, "quotes": [{"opinion_id": 456, "quote": "exact verbatim opinion text"}]}.
- Do not use doc_id, page, top-level quote, case_name, or citation fields in case entries.
- If you have not obtained opinion text or snippets for a useful case, fetch/read it before citing it, or say you could not read it and do not rely on it.

Limits:
- If any CourtListener call returns a rate-limit/throttling/429 error, stop all CourtListener calls for that turn and answer using only information already available.`;

export const COURTLISTENER_TOOLS = [
    {
        type: "function",
        function: {
            name: COURTLISTENER_TOOL_NAMES.searchCaseLaw,
            description:
                "Search CourtListener case law by query and optional court/date filters. Returns case metadata and cluster IDs. Use courtlistener_get_cases before relying on a case as legal authority.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string" },
                    court: {
                        type: "string",
                        description:
                            "Optional CourtListener court id such as scotus, ca7, or ind.",
                    },
                    filedAfter: {
                        type: "string",
                        description: "Optional filed-after date in YYYY-MM-DD format.",
                    },
                    filedBefore: {
                        type: "string",
                        description: "Optional filed-before date in YYYY-MM-DD format.",
                    },
                    limit: {
                        type: "integer",
                        description: "Maximum number of search results. Default 10, max 20.",
                    },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: COURTLISTENER_TOOL_NAMES.getCases,
            description:
                "Fetch and cache one or more CourtListener case clusters and their opinions by cluster ID. This returns metadata/counts only, not full opinion text. After this, call courtlistener_find_in_case for targeted passages or courtlistener_read_case if broader full-case context is needed.",
            parameters: {
                type: "object",
                properties: {
                    clusterIds: {
                        type: "array",
                        items: { type: "integer" },
                        description:
                            "CourtListener cluster IDs from courtlistener_verify_citations or search results.",
                    },
                },
                required: ["clusterIds"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: COURTLISTENER_TOOL_NAMES.findInCase,
            description:
                "Search within an already-fetched CourtListener case cluster for specific keyword(s) or phrases. Call courtlistener_get_cases first.",
            parameters: {
                type: "object",
                properties: {
                    clusterId: { type: "integer" },
                    query: {
                        type: "string",
                        description:
                            "Short term to search for, 1-3 words long and likely to appear exactly as written.",
                    },
                    max_results: {
                        type: "integer",
                        description: "Maximum number of matches to return. Default 20.",
                    },
                    context_chars: {
                        type: "integer",
                        description:
                            "Characters of surrounding context to include on each side. Default 160.",
                    },
                },
                required: ["clusterId", "query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: COURTLISTENER_TOOL_NAMES.readCase,
            description:
                "Read selected opinion text from an already-fetched CourtListener case cluster in this turn's cache. Use after courtlistener_find_in_case if snippets are insufficient.",
            parameters: {
                type: "object",
                properties: {
                    clusterId: { type: "integer" },
                    opinionId: {
                        type: "integer",
                        description: "Specific opinion ID to read.",
                    },
                    opinionIds: {
                        type: "array",
                        items: { type: "integer" },
                        description:
                            "Specific opinion IDs to read. Use the smallest set needed.",
                    },
                },
                required: ["clusterId"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: COURTLISTENER_TOOL_NAMES.verifyCitations,
            description:
                "Verify legal case citations using CourtListener's citation lookup. Accepts only clean reporter citations, not case names.",
            parameters: {
                type: "object",
                properties: {
                    citations: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Clean reporter citations only, e.g. [\"467 U.S. 837\", \"323 U.S. 134\"]. Up to 250 items.",
                    },
                },
                required: ["citations"],
            },
        },
    },
];
