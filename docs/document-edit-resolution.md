# Durable tracked-edit decisions

Accept/reject reads the active Word file, resolves the tracked IDs, and uploads
to a new immutable Blob key. A PostgreSQL transaction locks the document and
edit, checks the active version has not changed, inserts a `user_accept` or
`user_reject` version, activates it, and saves the decision. HTTP success means
the transaction committed. Original bytes and the original version remain
available in history. Edit/current tabs follow the new version; explicit historical document and
citation tabs retain their selected version. No optimistic DOM edits are made
to those immutable views. PDF renditions are not reused across versions.

Missing tracked IDs produce a conflict and leave the decision pending. The API
does not infer that an absent change was accepted or rejected. Identical retries
return the durable status; the opposite decision returns a conflict. Bulk
resolution stops on its first failure and displays the API recovery message.

An upload or confirmed transaction rollback preserves the original file and
pending decision and removes staged bytes. A failed cleanup logs
`document_edit_stage_cleanup_failed`, with document/edit/version IDs and the
staged key. A lost COMMIT or rollback response keeps staged bytes: deleting them
could destroy a committed version. `document_edit_persistence_failed` logs the
IDs, key, and commit/rollback certainty, without document content. The API returns
503 and asks the user to refresh and retry the same decision.

For reconciliation, first read the document pointer, edit status and the reported
version row. If that row or any active/history version references the staged key,
retain it. Only delete an unreferenced key after confirming the transaction has
ended and no version references it. Never overwrite or delete the prior file to
repair a decision. Investigate repeated persistence/cleanup events as an
operational issue.

`backend/test/documentEditResolution.test.ts` exercises actual DOCX resolution
with synthetic XML and injected upload, insert, activation, status-save,
zero-row, concurrency, missing-marker, and uncertain-commit failures. It does
not use production storage/database or prove a signed-in deployment flow.
