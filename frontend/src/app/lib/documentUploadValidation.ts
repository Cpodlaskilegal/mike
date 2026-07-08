export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".doc",
  ".xlsx",
  ".xlsm",
  ".xls",
  ".pptx",
  ".ppt",
] as const;

export const SUPPORTED_DOCUMENT_ACCEPT = SUPPORTED_DOCUMENT_EXTENSIONS.join(",");

const SUPPORTED_EXTENSION_SET = new Set(
  SUPPORTED_DOCUMENT_EXTENSIONS.map((ext) => ext.slice(1)),
);

export function getDocumentExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function isSupportedDocumentFile(file: File): boolean {
  return SUPPORTED_EXTENSION_SET.has(getDocumentExtension(file.name));
}

export function partitionSupportedDocumentFiles(files: File[]) {
  const supported: File[] = [];
  const unsupported: File[] = [];
  for (const file of files) {
    if (isSupportedDocumentFile(file)) supported.push(file);
    else unsupported.push(file);
  }
  return { supported, unsupported };
}

export function formatUnsupportedDocumentWarning(files: File[]): string | null {
  if (files.length === 0) return null;
  const names = files.map((file) => file.name).join(", ");
  return `Unsupported file type: ${names}. Supported: ${SUPPORTED_DOCUMENT_ACCEPT}`;
}
