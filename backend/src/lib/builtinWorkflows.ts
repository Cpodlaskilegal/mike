/**
 * Compatibility export for the assistant tool runtime.
 *
 * The full Docket-owned catalog lives in systemWorkflows.ts. Keeping this
 * narrow export avoids touching the chat tool contract while ensuring the
 * assistant and the workflow UI read the same source of truth.
 */
export { SYSTEM_ASSISTANT_WORKFLOWS as BUILTIN_WORKFLOWS } from "./systemWorkflows";
