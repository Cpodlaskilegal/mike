# DCK-012: production dependency refresh

The September 29 lockfile refresh removes every high and critical alert from both production npm dependency trees. The backend has zero alerts. The frontend has four moderate package alerts stemming from the same UUID advisory; its affected APIs are not called by the dependent spreadsheet packages.

| Production audit | Fresh baseline | After refresh |
| --- | --- | --- |
| Frontend | 18 package alerts: 1 critical, 7 high, 9 moderate, 1 low | 4 moderate |
| Backend | 11 package alerts: 4 high, 7 moderate | 0 |

These are npm's affected-package counts, not unique advisory counts. The frontend baseline increased from the earlier review's 17 as the advisory feed changed.

## Version changes and reachability

| Dependency | Prior lockfile | Updated lockfile | Relevant boundary |
| --- | --- | --- | --- |
| Next.js / eslint-config-next | 16.2.9 | 16.3.7 | The default image optimization endpoint is exposed even without a `next/image` import. Upgraded beyond the [AVIF RCE fix](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4). No Server Actions were found, but their advisories are also patched. |
| Tiptap React, PM, Starter Kit and core | 3.22.3 | 3.31.3 | Workflow prompts accept Markdown, using the standard Starter Kit and `tiptap-markdown`; HTML input is disabled. Upgrade fixes [prototype attributes](https://github.com/advisories/GHSA-cp6q-959q-f8rh) and [Markdown attribute ReDoS](https://github.com/advisories/GHSA-j95f-988m-3j2f) without relying on those source constraints. |
| libreoffice-convert | 1.8.1 | 1.8.2 | Docket supplies a fixed `.pdf` extension and no caller-controlled `options.fileName`. The patched wrapper also confines `fileName` with `path.basename`; see the [traversal advisory](https://github.com/advisories/GHSA-gmxc-r82q-347r). |
| Express | 4.22.2 | 4.22.3 | Keeps the existing Express 4 API and resolves body parser/query parser alerts. |
| Multer / @types/multer | 1.4.5-lts.2 / 1.4.12 | 2.4.0 / 2.3.0 | The old production parser is deprecated for security reasons despite this audit not reporting it. The supported [2.4.0 release](https://github.com/expressjs/multer/releases/tag/v2.4.0) retains Docket's memory storage and single-file API. |

Compatible transitive patches also update XML parsing, URI/IP parsing, ID generation, Markdown link parsing, compression, DOM sanitization and image processing. Notable fixed versions are `@xmldom/xmldom` 0.8.15, `fast-uri` 3.1.8, `ip-address` 10.7.2, `nanoid` 5.1.16, `qs` 6.16.0, `protobufjs` 7.6.6, `markdown-it` 14.3.2, `linkify-it` 5.0.2, `fflate` 0.4.9 and DOMPurify 3.4.16. Next's image optimizer resolves Sharp 0.35.5; the separate Cloudflare build tool resolves Sharp 0.35.4. Both satisfy the current advisory's patched range.

Direct version requirements were raised for the affected supported packages; both lockfiles record the complete resolved tree. Next.js and its ESLint configuration remain pinned to the same exact version. Context7's requested documentation lookup returned its monthly quota error, so compatibility and remediation were checked against official maintainer documentation and advisories.

## Residual advisory decision

`npm audit --omit=dev` reports `uuid`, `@fortune-sheet/core`, `@fortune-sheet/react` and `exceljs` as four moderate package alerts caused by [GHSA-w5hq-g745-h8pq / CVE-2026-41907](https://github.com/advisories/GHSA-w5hq-g745-h8pq). The installed UUID version is 8.3.2; Fortune Sheet 1.0.4 and ExcelJS 4.4.0 are the current upstream releases and constrain UUID to 8.x.

The issue requires a call to UUID's `v3`, `v5` or `v6` API with an externally supplied output buffer or offset. The reviewed installed Fortune Sheet code imports/calls only `v4()` with no parameters; ExcelJS imports `v4` for conditional-format rule IDs and calls it with no parameters. Docket has no direct UUID runtime calls. Those APIs and their buffer/offset preconditions are therefore unreachable through the current spreadsheet viewer/export paths. This is a source-based disposition, not a claim that UUID 8.x is patched or supported.

Keep the moderate alerts visible. Do not use `npm audit fix --force`: its proposed ExcelJS downgrade is a compatibility change that does not fix Fortune Sheet's constraint. Revisit this disposition when either spreadsheet library updates its UUID dependency, introduces a new UUID API call, or changes its identifier inputs. No high or critical production advisory is accepted or suppressed.

## Local validation

- Clean `npm ci` in `backend/` and `npm ci --legacy-peer-deps` in `frontend/` passed after the final manifest/lockfile changes.
- Focused backend tests passed: upload bytes, unexpected fields, multiple-file rejection, malformed multipart followed by another usable upload; DOCX separator normalization, tracked-change preservation, XLSX/PPTX generation (8 tests).
- The Tiptap prototype-attribute regression passed through the `@tiptap/react` export used by the editor (1 test).
- A temporary Playwright harness rendered the actual `WorkflowPromptEditor` component in Chrome at 1200 × 950. Markdown headings, bold text and lists loaded; typing emitted Markdown; the Bold toolbar emitted bold Markdown; an external prompt reload and read-only mode worked. No page or console errors were observed. The harness used synthetic text and omitted app styling/authentication.
- A separate temporary Next.js 16.3.7 app using the same installed dependency tree exercised `/_next/image` with generated PNG and AVIF files. Both returned HTTP 200 with WebP output and rendered successfully in Chrome; no page or console errors were observed. This tests the patched optimizer locally, not a production route or deployment image.
- Generated DOCX bytes passed through Docket's `docxToPdf` pipeline using the bundled local LibreOffice executable (selected only in the temporary test harness). Canonical and Windows-style ZIP entries both yielded readable PDFs preserving `12.10`. A traversal `fileName` remained confined to the conversion temporary directory. The local Node 26 process emitted a promisify deprecation warning; the production container uses Node 22, and conversion results passed.
- Final production audit: backend **0**; frontend **4 moderate, 0 high, 0 critical**. Audit advisory data is time-sensitive; rerun before releases.

The focused checks use synthetic content and no live client/provider data. Full application build/test gates and confirmation of the active Azure image are separate release evidence. DCK-012's deployment acceptance requires confirming both active images contain these lockfile versions; local success alone does not close that acceptance check.

The alternative Cloudflare preview/deploy scripts were not exercised; this release targets the existing Azure standalone containers.
