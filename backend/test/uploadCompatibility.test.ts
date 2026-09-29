import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import { singleFileUpload } from "../src/lib/upload";

test("the supported multipart parser preserves upload bytes and rejects invalid requests without killing the server", async (t) => {
  const app = express();
  app.post("/upload", singleFileUpload("file"), (req, res) => {
    res.json({
      filename: req.file?.originalname,
      type: req.file?.mimetype,
      text: req.file?.buffer.toString("utf8"),
      note: req.body.note,
    });
  });
  app.use(((err, _req, res, _next) => {
    res.status(400).json({ detail: "Malformed upload" });
  }) as express.ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;

  const valid = () => {
    const form = new FormData();
    form.set("file", new Blob(["Synthetic document 12.10"], { type: "text/plain" }), "sample.txt");
    form.set("note", "synthetic");
    return form;
  };
  const uploaded = await fetch(url, { method: "POST", body: valid() });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(await uploaded.json(), {
    filename: "sample.txt", type: "text/plain", text: "Synthetic document 12.10", note: "synthetic",
  });

  const wrongField = new FormData();
  wrongField.set("other", new Blob(["synthetic"]), "other.txt");
  const rejectedField = await fetch(url, { method: "POST", body: wrongField });
  assert.equal(rejectedField.status, 400);
  assert.match((await rejectedField.json() as { detail: string }).detail, /Upload failed:/);

  const tooMany = valid();
  tooMany.append("file", new Blob(["second"]), "second.txt");
  const rejectedCount = await fetch(url, { method: "POST", body: tooMany });
  assert.equal(rejectedCount.status, 400);
  assert.match((await rejectedCount.json() as { detail: string }).detail, /Upload failed:/);

  const malformed = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=missing" },
    body: "malformed",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { detail: string }).detail, "Malformed upload");
  const subsequent = await fetch(url, { method: "POST", body: valid() });
  assert.equal(subsequent.status, 200);
  assert.equal((await subsequent.json() as { text: string }).text, "Synthetic document 12.10");
});
