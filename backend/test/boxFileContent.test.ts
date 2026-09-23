import assert from "node:assert/strict";
import test from "node:test";
import { Document, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import {
  readBoxFileContentFallback,
  shouldFallbackBoxFileContent,
  type BoxFileContentFallbackOptions,
} from "../src/lib/mcp/boxFileContent";

const fileId = "743588051504";
const token = "private-user-token";
const signedUrl = "https://dl.boxcloud.com/d/1/secret-single-use-url/download";

function metadata(name: string, extra: Record<string, unknown> = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ id: Number(fileId), name, ...extra }),
      },
    ],
  };
}

function setup(
  bytes: Buffer,
  options: Partial<BoxFileContentFallbackOptions> = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: signedUrl } })
      : new Response(bytes, { status: 200 });
  };
  return {
    calls,
    options: {
      fileId,
      getFileDetails: async () =>
        metadata("example.txt", { size: bytes.length }),
      getAccessToken: async () => token,
      fetchImpl,
      ...options,
    } satisfies BoxFileContentFallbackOptions,
  };
}

test("fallback triggers only for failed unavailable text representation reads", () => {
  const content = [
    { type: "text", text: "File text representation is not available" },
  ];
  assert.equal(shouldFallbackBoxFileContent({ isError: true, content }), true);
  assert.equal(
    shouldFallbackBoxFileContent(new Error("Text representation unavailable")),
    true,
  );
  assert.equal(shouldFallbackBoxFileContent({ content }), false);
  assert.equal(
    shouldFallbackBoxFileContent({
      isError: true,
      content: [{ text: "Permission denied" }],
    }),
    false,
  );
  assert.equal(
    shouldFallbackBoxFileContent(new Error("request timeout")),
    false,
  );
});

test("reads a real generated DOCX through the user's OAuth and drops auth at redirects", async () => {
  const bytes = await Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({ children: [new TextRun("NON-COMPETE EXAMPLE")] }),
            new Paragraph("The restricted period is twelve months."),
          ],
        },
      ],
    }),
  );
  const { options, calls } = setup(bytes, {
    getFileDetails: async () =>
      metadata("Non-Compete Example.docx", {
        size: bytes.length,
        extension: "docx",
      }),
  });
  const result = await readBoxFileContentFallback(options);
  assert.equal(result.isError, false);
  assert.equal(result.status, "read");
  assert.match(
    result.content[0].text,
    /NON-COMPETE EXAMPLE\nThe restricted period is twelve months\./,
  );
  assert.match(result.coverage, /accepted-revisions/);
  assert.match(result.coverage, /footnotes/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://api.box.com/2.0/files/${fileId}/content`);
  assert.equal(
    new Headers(calls[0].init?.headers).get("authorization"),
    `Bearer ${token}`,
  );
  assert.equal(calls[1].url, signedUrl);
  assert.equal(new Headers(calls[1].init?.headers).has("authorization"), false);
  assert.equal(
    calls.every((call) => call.init?.redirect === "manual"),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-user-token|secret-single-use-url/,
  );
});

test("DOCX fallback excludes deleted revisions and retains inserted text", async () => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>
      <w:r><w:t>Period: </w:t></w:r><w:del w:id="1"><w:r><w:delText>twenty years</w:delText></w:r></w:del>
      <w:ins w:id="2"><w:r><w:t>twelve months</w:t></w:r></w:ins></w:p></w:body></w:document>`,
  );
  const { options } = setup(await zip.generateAsync({ type: "nodebuffer" }), {
    getFileDetails: async () => metadata("example.docx"),
  });
  const result = await readBoxFileContentFallback(options);
  assert.equal(result.content[0].text, "Period: twelve months");
  assert.doesNotMatch(result.content[0].text, /twenty years/);
});

test("reads legacy DOCX archives with Windows-style entry paths", async () => {
  const zip = new JSZip();
  zip.file(
    "word\\document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Legacy exemplar</w:t></w:r></w:p></w:body></w:document>`,
  );
  const { options } = setup(await zip.generateAsync({ type: "nodebuffer" }), {
    getFileDetails: async () => metadata("legacy.docx"),
  });
  const result = await readBoxFileContentFallback(options);
  assert.equal(result.isError, false);
  assert.equal(result.content[0].text, "Legacy exemplar");
});

function makePdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test("extracts PDF embedded text and explicitly discloses no OCR coverage", async () => {
  const { options } = setup(makePdf("Non-compete example twelve months"), {
    getFileDetails: async () => metadata("example.pdf"),
  });
  const result = await readBoxFileContentFallback(options);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Non-compete example twelve months/);
  assert.match(result.coverage, /1 of 1 pages/);
  assert.match(result.coverage, /not OCR-read/);
});

test("an image-only or blank PDF is unread rather than a successful empty result", async () => {
  const { options } = setup(makePdf(""), {
    getFileDetails: async () => metadata("scan.pdf"),
  });
  const result = await readBoxFileContentFallback(options);
  assert.equal(result.status, "unread");
  assert.match(result.content[0].text, /may require OCR/);
});

test("rejects unsafe redirects without fetching them or disclosing their URLs", async () => {
  for (const location of [
    "http://dl.boxcloud.com/file",
    "https://127.0.0.1/file",
    "https://evil.test/file",
    "https://dl.boxcloud.com.evil.test/file",
    "https://user:pass@dl.boxcloud.com/file",
    "https://dl.boxcloud.com:8080/file",
    "https://api.box.com/2.0/users/me",
  ]) {
    let calls = 0;
    const result = await readBoxFileContentFallback({
      ...setup(Buffer.from("text")).options,
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location } });
      },
    });
    assert.equal(result.isError, true, location);
    assert.equal(calls, 1, location);
    assert.doesNotMatch(
      JSON.stringify(result),
      /evil\.test|user:pass|127\.0\.0\.1/,
    );
  }
});

test("requires exact metadata identity and a numeric requested ID", async () => {
  for (const override of [
    { fileId: "../users/me" },
    { getFileDetails: async () => ({ id: "99", name: "other.txt" }) },
    {
      getFileDetails: async () => ({
        isError: true,
        content: [{ type: "text", text: "Forbidden" }],
      }),
    },
  ]) {
    const { options, calls } = setup(Buffer.from("text"), override);
    const result = await readBoxFileContentFallback(options);
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  }
});

test("refuses unsupported legacy DOC and oversized metadata before download", async () => {
  for (const fields of [
    { name: "legacy.doc" },
    { name: "example.txt", size: 11 * 1024 * 1024 },
  ]) {
    const { options, calls } = setup(Buffer.from("text"), {
      getFileDetails: async () => metadata(fields.name, fields),
    });
    const result = await readBoxFileContentFallback(options);
    assert.equal(result.status, "unread");
    assert.equal(calls.length, 0);
  }
});

test("enforces actual streamed download size even without a content-length header", async () => {
  const { options } = setup(Buffer.from("a".repeat(64)), {
    getFileDetails: async () => metadata("example.txt"),
    limits: { maxBytes: 16 },
  });
  const result = await readBoxFileContentFallback(options);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /size limit/);
});

test("marks bounded returned text partial instead of claiming full review", async () => {
  const { options } = setup(
    Buffer.from("The contract has a longer second paragraph."),
    {
      limits: { maxTextChars: 12 },
    },
  );
  const result = await readBoxFileContentFallback(options);
  assert.equal(result.status, "partial");
  assert.equal(result.truncated, true);
  assert.equal(result.content[0].text, "The contract");
  assert.match(result.coverage, /do not claim full-document review/);
});

test("returns unread and sanitizes failed downloads, missing auth and malformed files", async () => {
  const failures: Partial<BoxFileContentFallbackOptions>[] = [
    {
      fetchImpl: async () => {
        throw new Error(`failed ${signedUrl} Authorization: ${token}`);
      },
    },
    { fetchImpl: async () => new Response("Forbidden", { status: 403 }) },
    { getAccessToken: async () => null },
    { getFileDetails: async () => metadata("corrupt.docx") },
  ];
  for (const failure of failures) {
    const result = await readBoxFileContentFallback(
      setup(Buffer.from("not a docx"), failure).options,
    );
    assert.equal(result.isError, true);
    assert.equal(result.status, "unread");
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-user-token|secret-single-use-url|not a docx/,
    );
  }
});

test("bounded DOCX extraction rejects highly compressed oversized body XML", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", "x".repeat(6 * 1024 * 1024));
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  const { options } = setup(bytes, {
    getFileDetails: async () => metadata("compressed.docx"),
  });
  const result = await readBoxFileContentFallback(options);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /safe extraction limit/);

  // A dishonest central-directory size must not bypass the actual inflater cap.
  const forged = Buffer.from(bytes);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  for (
    let offset = forged.indexOf(signature);
    offset >= 0;
    offset = forged.indexOf(signature, offset + 4)
  ) {
    const nameLength = forged.readUInt16LE(offset + 28);
    if (
      forged.subarray(offset + 46, offset + 46 + nameLength).toString() ===
      "word/document.xml"
    ) {
      forged.writeUInt32LE(1, offset + 24);
    }
  }
  const forgedResult = await readBoxFileContentFallback(
    setup(forged, {
      getFileDetails: async () => metadata("compressed.docx"),
    }).options,
  );
  assert.equal(forgedResult.isError, true);
  assert.match(forgedResult.content[0].text, /safe extraction limit/);
});

test("cancellation ends a stalled metadata callback with a sanitized failure", async () => {
  const controller = new AbortController();
  const { options } = setup(Buffer.from("text"), {
    getFileDetails: () => new Promise(() => {}),
    signal: controller.signal,
  });
  const reading = readBoxFileContentFallback(options);
  controller.abort(new Error(`cancelled ${token}`));
  const result = await reading;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cancelled/);
  assert.doesNotMatch(JSON.stringify(result), /private-user-token/);
});

test("read-only metadata download URLs need no OAuth and are not exposed in results", async () => {
  let tokenCalls = 0;
  const result = await readBoxFileContentFallback({
    fileId,
    getFileDetails: async () =>
      metadata("example.txt", { download_url: signedUrl }),
    getAccessToken: async () => {
      tokenCalls++;
      return token;
    },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), signedUrl);
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return new Response("Readable example");
    },
  });
  assert.equal(result.isError, false);
  assert.equal(tokenCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret-single-use-url/);
});
