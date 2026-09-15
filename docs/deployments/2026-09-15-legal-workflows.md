# Shared legal Assistant workflows — 2026-09-15 release

## Result

Six Docket-owned legal Assistant workflows are available to every signed-in user: drafting, surgical redlining, legal research, citation checking, draft review, and matter briefs/chronologies. They are built-in, read-only catalog entries, not individually shared copies. Current-user document and connector permissions still apply; uploads are sufficient for work that does not require unavailable sources.

The release preserves the Anthropic model refresh already on `main` (`5b736ff`). Pull request: [#13](https://github.com/Cpodlaskilegal/mike/pull/13). Source methods, input expectations, and quality limitations are documented in [Legal workflows](../legal-workflows.md).

## Build and deployment evidence

Initial runtime source: `008d8195d33452f457c4b5e955d54c6a7f9fa1f0` (tree `b8347d4f80a116bb69e94c54d6aa41e8b682f2a0`). Clean tracked-source archives excluded local dependency symlinks and environment files. Existing browser-safe public configuration was preserved without committing its values.

| Component | ACR run | Result | Image digest |
| --- | --- | --- | --- |
| Backend | `ch2v` | Passed clean `npm ci`, TypeScript build, runtime dependency install, and image push | `sha256:2b8a0bf28920eb95a470e2b39603bac42a8875c105c59e7ec2910fad81d9411d` |
| Initial frontend | `ch2w` | Passed clean `npm ci --legacy-peer-deps`, ESLint, default Next.js/Turbopack build, and image push | `sha256:6b0f0cedf64d94c4a867812da092aa773b7ed0aeedd705b838a8489c7435906e` |
| Final frontend with launch fix | `ch2x` | Passed clean `npm ci --legacy-peer-deps`, ESLint, default Next.js/Turbopack build, and image push | `sha256:46e6cf46e4d0aa37eab9f44460376dd17a4b0e0598465bd94fc99da19706f9b1` |

The build-stage frontend Dockerfile added `npm run lint` before its normal build; the repository Dockerfile was unchanged. ACR provided clean installs without consuming the workstation's limited free disk space.

Final frontend runtime source: `9a5d745c13ecf2fde216e44f990b86b9ed81680d`. Its backend tree is unchanged from `008d819`, so the verified backend image remains in use. Later release-record commits only change documentation.

Backend image: `mikeacr9c6e79.azurecr.io/mike-api:legal-008d819-20260915t175809`.

Backend revision: `mike-api--legal-008d819-1808-api`. Latest and latest-ready matched, the expected image was configured, Single revision mode sent 100% of traffic to latest, and the public `/health` response was `{"ok":true}`.

Final frontend image: `mikeacr9c6e79.azurecr.io/mike-web:legal-9a5d745-20260915t181513`.

Final frontend revision: `mike-web--legal-9a5d745-1821-web`. Latest and latest-ready matched, the expected image was configured, Single revision mode sent 100% of traffic to latest, and `https://docket.podlaskilegal.com/login` returned HTTP 200. Both apps and public endpoints were rechecked together after the final rollout.

## Functional checks

- Backend workflow/provider regression selection: **47 passed** after merging current `main`.
- Actual workflow-router sharing tests with mocked authentication/database boundaries: **4 passed**. Two ordinary identities, including a newcomer with no workflows/shares, received all six Assistant entries. All twelve detail reads resolved without database access. Private workflow isolation, unauthenticated denial at the injected auth boundary, tabular separation, and personal-hide isolation passed. These tests do not exercise Entra token verification.
- Frontend suite after the launch fix: **51 passed**, including two focused startup regressions. The new test executes the page's actual effect callbacks to check delayed readiness, exact workflow/file payload preservation, and once-only dispatch; it is not a browser-rendered integration test. Independent review also reran all five launch/payload tests successfully.
- Production read-only probe: executed the shipped workflow GET handler and assistant workflow store for two randomly generated synthetic identities with no accounts or sharing rows, using the production database with `transaction_read_only=on`. All six had `type: assistant`, `is_system: true`, `user_id: null`, `allow_edit: false`, and `is_owner: false`; route and execution prompts matched. This probe ran below the authentication boundary and is not a real-user authentication test.
- Authenticated browser check: normal Microsoft sign-in to Docket; all six appeared under Workflows with type **Assistant** and source **Docket**. The drafting workflow's description and full instructions opened correctly.
- Final live catalog launch passed. With no documents selected, the synthetic request asked only to read the selected workflow and explain its purpose in one sentence. Docket showed the selected **Draft a Legal Document** badge, completed one step, and returned the expected purpose statement. The expanded step was **Applied workflow → Draft a Legal Document**. No research, source-system access, or document generation was requested or shown. This validates workflow launch/loading, not substantive legal drafting quality.

## Errors found and resolution

1. **Catalog launch stalled before a model response.** The live smoke check saved the selected workflow badge but the standalone chat page cleared `newChatMessages` while generation settings were still initializing. The page now retains initial messages and clears the pending launch only after readiness, immediately before the guarded, once-only send. Project chat already used that clearing order.
2. **Build submission wrapper quirks.** The first relative Dockerfile argument did not resolve from the caller's working directory; absolute staged paths fixed submission. A successful `az acr build --no-wait -o json` returned empty output, so the wrapper's JSON parser failed after queueing. Run IDs were recovered from ACR instead of queueing duplicate builds.
3. **CLI delegated Docket token unavailable.** Azure CLI lacked consent for the Docket API delegated scope (`AADSTS65001`). No consent or permission changes were made. Authenticated visual verification used the existing Microsoft browser sign-in.
4. **Initial local checks were not a clean full-suite pass.** Before release, 297 of 300 backend tests passed; three subprocess startup checks timed out during concurrent builds. The isolated retry passed all three. The complete suite was not rerun after that retry. A transient font-fetch connection reset recovered during the initial local frontend build. Clean cloud builds subsequently passed.

The deployed read-only database probe emitted an existing `pg` SSL-mode compatibility warning. No database connection configuration was changed by this release.

## Commands run

Run from the indicated package directories, cloud stages, or repository; public build argument values are intentionally omitted:

```sh
git fetch origin main
git merge --no-edit origin/main
git archive HEAD

# Required clean checks inside ACR Docker build stages:
cd backend
npm ci
npm run build
cd ../frontend
npm ci --legacy-peer-deps
npm run lint
npm run build

# Local regression runs:
npm test --prefix frontend
# backend: tsx --test --test-concurrency=1, selected workflow/provider tests
# backend: tsx --test test/legalWorkflowSharing.test.ts

az acr build --registry mikeacr9c6e79 --image <repository>:<tag> --file <absolute-staged-Dockerfile> --no-wait <tracked-source-stage>
az acr task list-runs --registry mikeacr9c6e79
az acr task show-run --registry mikeacr9c6e79 --run-id <run-id>
az acr task logs --registry mikeacr9c6e79 --run-id <run-id>

az containerapp update -g mike-prod-rg -n <app> --image <image> --revision-suffix <revision-suffix> --set-env-vars DEPLOY_VERSION=<tag> -o none
az containerapp show -g mike-prod-rg -n <app>
az containerapp exec -g mike-prod-rg -n mike-api --command sh

# HTTP reads used Python urllib.request; equivalent endpoint checks:
curl -fsS https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io/health
curl -fsSI https://docket.podlaskilegal.com/login
```

Only image and `DEPLOY_VERSION` were updated on the apps; existing secrets, connections, resource settings, and source-system permissions were preserved. No database migration or per-user sharing insert was required.

## Changed files

- Backend: `src/lib/legalWorkflows.ts`, `src/lib/systemWorkflows.ts`, `src/lib/chatTools.ts`; workflow catalog, runtime, portability, and sharing tests.
- Frontend: Assistant workflow picker, workflow list/detail/launch UI, `lib/workflowLaunch.ts`, standalone Assistant chat launch timing, launch regression tests, and tutorial copy.
- Documentation: legal workflow source/limitation inventory, training plan, and this deployment record.

## Rollback

Previous backend image: `mikeacr9c6e79.azurecr.io/mike-api:anthropic-20260915t172944`; previous frontend image: `mikeacr9c6e79.azurecr.io/mike-web:anthropic-20260915t172944`. Both previously used `DEPLOY_VERSION=anthropic-20260915t172944`. If rollback is needed, update each app to its prior image and version with a fresh revision suffix, then verify ready revision, image, traffic, and endpoint response again. No data rollback is involved.

## Scope and remaining steps

No user setup or individual sharing step is required. Users with an already-open catalog can refresh it.

This verifies deployment, catalog availability, sharing behavior, and the bounded workflow launch path. It does not establish live quality parity with the CMA Python Word validator, exact-diff engine, or deterministic citation release gate. Those are not installed by this port. Actual legal outputs remain subject to attorney review and disclosed source/verification limits.

Confidence in the final rollout: **high** for deployed availability, global Assistant classification, and the verified launch path. Legal output quality and CMA QA parity are outside this smoke check.
