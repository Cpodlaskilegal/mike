/**
 * Azure Blob Storage utilities for Docket document management.
 */

import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";

const account = process.env.AZURE_STORAGE_ACCOUNT ?? "";
const accountKey = process.env.AZURE_STORAGE_KEY ?? "";
const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? "";
const containerName = process.env.AZURE_STORAGE_CONTAINER ?? "documents";

function getContainerClient() {
  if (connectionString) {
    return BlobServiceClient.fromConnectionString(connectionString).getContainerClient(
      containerName,
    );
  }
  if (!account || !accountKey) {
    throw new Error("Azure Blob Storage is not configured");
  }
  const credential = new StorageSharedKeyCredential(account, accountKey);
  return new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    credential,
  ).getContainerClient(containerName);
}

function getSharedKeyCredential(): StorageSharedKeyCredential | null {
  if (!account || !accountKey) return null;
  return new StorageSharedKeyCredential(account, accountKey);
}

export const storageEnabled = Boolean(
  connectionString || (account && accountKey && containerName),
);

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const blockBlob = getContainerClient().getBlockBlobClient(key);
  await blockBlob.uploadData(Buffer.from(content), {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  if (!storageEnabled) return null;
  try {
    const blob = getContainerClient().getBlobClient(key);
    const response = await blob.download();
    const chunks: Buffer[] = [];
    for await (const chunk of response.readableStreamBody ?? []) {
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
  } catch {
    return null;
  }
}

export async function deleteFile(key: string): Promise<void> {
  if (!storageEnabled) return;
  await getContainerClient().deleteBlob(key, { deleteSnapshots: "include" });
}

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  if (!storageEnabled) return null;
  try {
    const blob = getContainerClient().getBlobClient(key);
    const credential = getSharedKeyCredential();
    if (!credential) return blob.url;
    const startsOn = new Date(Date.now() - 60_000);
    const expiresOn = new Date(Date.now() + expiresIn * 1000);
    const contentDisposition = downloadFilename
      ? buildContentDisposition("attachment", downloadFilename)
      : undefined;
    const sas = generateBlobSASQueryParameters(
      {
        containerName,
        blobName: key,
        permissions: BlobSASPermissions.parse("r"),
        startsOn,
        expiresOn,
        contentDisposition,
      },
      credential,
    ).toString();
    return `${blob.url}?${sas}`;
  } catch {
    return null;
  }
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name)
    .replace(/["\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}
