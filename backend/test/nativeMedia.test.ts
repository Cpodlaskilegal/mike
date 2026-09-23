import assert from "node:assert/strict";
import { test } from "node:test";
import { loadNativeMedia, nativeMediaSupport } from "../src/lib/nativeMedia";

test("image and PDF input is supported across providers, audio and video by Gemini", () => {
    for (const model of ["gpt-6-astra", "claude-opus-5-5", "gemini-3-flash-preview"]) {
        assert.equal(nativeMediaSupport(model, "image/png"), true);
        assert.equal(nativeMediaSupport(model, "application/pdf"), true);
    }
    assert.equal(nativeMediaSupport("gpt-6-astra", "audio/mpeg"), false);
    assert.equal(nativeMediaSupport("claude-opus-5-5", "video/mp4"), false);
    assert.equal(nativeMediaSupport("gemini-3-flash-preview", "audio/mpeg"), true);
    assert.equal(nativeMediaSupport("gemini-3.1-pro-preview", "video/mp4"), true);
});

test("media loader sends original bytes once and enforces provider support", async () => {
    const bytes = Buffer.from("original image bytes");
    let reads = 0;
    const source = {
        documentId: "doc-1",
        filename: "photo.png",
        fileType: "png",
        storagePath: "private/user/doc-1.png",
        sizeBytes: bytes.byteLength,
    };
    const result = await loadNativeMedia({
        model: "claude-opus-5-5",
        sources: [source, source],
        download: async () => {
            reads++;
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
    });
    assert.equal(reads, 1);
    assert.deepEqual(result.oversizedPdfs, []);
    assert.equal(result.media[0]?.base64Data, bytes.toString("base64"));
    assert.equal(result.media[0]?.mimeType, "image/png");

    await assert.rejects(
        loadNativeMedia({
            model: "gpt-6-astra",
            sources: [{ ...source, filename: "clip.mp4", fileType: "mp4" }],
            download: async () => { throw new Error("should not download unsupported media"); },
        }),
        /requires a Gemini model/,
    );
});

test("oversized PDF stays available to Docket text tools", async () => {
    const result = await loadNativeMedia({
        model: "gpt-6-astra",
        sources: [{
            documentId: "large-pdf",
            filename: "record.pdf",
            fileType: "pdf",
            storagePath: "private/user/record.pdf",
            sizeBytes: 25 * 1024 * 1024,
        }],
        download: async () => { throw new Error("oversized PDF should not be fetched"); },
    });
    assert.deepEqual(result.media, []);
    assert.deepEqual(result.oversizedPdfs, ["record.pdf"]);
});
