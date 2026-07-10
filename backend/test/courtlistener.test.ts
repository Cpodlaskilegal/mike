import assert from "node:assert/strict";
import test from "node:test";

import {
  getCourtlistenerCaseOpinions,
  sanitizeCourtlistenerOpinionHtml,
  verifyCourtlistenerCitations,
} from "../src/lib/courtlistener";

test("CourtListener opinion sanitizer strips executable and off-origin markup", () => {
  const sanitized = sanitizeCourtlistenerOpinionHtml(
    [
      '<p onclick="alert(1)">Holding <strong>text</strong></p>',
      '<script>alert("xss")</script>',
      '<a href="javascript:alert(1)">bad</a>',
      '<a href="https://example.test/escape">outside</a>',
      '<a href="/opinion/123/">CourtListener</a>',
      '<page-number>42</page-number>',
    ].join(""),
  );

  assert.ok(sanitized);
  assert.doesNotMatch(sanitized, /script|onclick|javascript:|example\.test/i);
  assert.match(sanitized, /<strong>text<\/strong>/);
  assert.match(
    sanitized,
    /href="https:\/\/www\.courtlistener\.com\/opinion\/123\/"/,
  );
  assert.match(sanitized, /target="_blank"/);
  assert.match(sanitized, /case-page-number">42/);
});

test("citation lookup follows CourtListener's documented form-data API and normalizes clusters", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  let contentType = "";
  globalThis.fetch = (async (input, init) => {
    assert.equal(
      String(input),
      "https://www.courtlistener.com/api/rest/v4/citation-lookup/",
    );
    contentType = new Headers(init?.headers).get("content-type") ?? "";
    requestBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify([
        {
          citation: "576 U.S. 644",
          status: 200,
          clusters: [
            {
              id: 123,
              case_name: "Example v. State",
              date_filed: "2015-06-26",
              absolute_url: "/opinion/123/example-v-state/",
              filepath_pdf_harvard: "opinions/example.pdf",
            },
          ],
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await verifyCourtlistenerCitations({
      citations: ["576 U.S. 644"],
      apiToken: "test-token",
    });
    assert.equal(contentType, "application/x-www-form-urlencoded");
    assert.equal(requestBody, "text=576+U.S.+644");
    assert.equal(result.source, "api");
    assert.equal(result.results[0]?.status, "found");
    assert.deepEqual(result.citationLinks[0], {
      clusterId: 123,
      citation: "576 U.S. 644",
      caseName: "Example v. State",
      court: null,
      url: "https://www.courtlistener.com/opinion/123/example-v-state/",
      pdfUrl: "https://storage.courtlistener.com/opinions/example.pdf",
      dateFiled: "2015-06-26",
      markdown:
        "[Example v. State, 576 U.S. 644](https://www.courtlistener.com/opinion/123/example-v-state/)",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("case-opinion payloads expose only sanitized HTML for the reader panel", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        results: [
          {
            id: 44,
            type: "majority",
            author_str: "Justice Example",
            absolute_url: "/opinion/44/example/",
            html_with_citations:
              '<p><a href="/opinion/44/">Holding</a><img src=x onerror=alert(1)></p>',
          },
        ],
        next: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const result = await getCourtlistenerCaseOpinions({
      clusterId: 88,
      includeFullText: true,
      maxChars: 4000,
      apiToken: "test-token",
    });
    const opinion = result.opinions[0];
    assert.equal(opinion?.opinionId, 44);
    assert.match(
      opinion?.html ?? "",
      /https:\/\/www\.courtlistener\.com\/opinion\/44\//,
    );
    assert.doesNotMatch(opinion?.html ?? "", /img|onerror/i);
    assert.match(opinion?.text ?? "", /Holding/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
