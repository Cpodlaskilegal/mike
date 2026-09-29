# Assistant run diagnostics

Every completed, failed, cancelled, or interrupted assistant run writes one JSON console log line with `event=assistant_run_terminal`. Startup failures before a durable run exists write `assistant_run_start_failure`; a run-creation acknowledgment that cannot be classified safely writes `assistant_run_start_uncertain`; an active run crossing ten minutes writes `assistant_run_slow` from its owning worker or a later recovery worker. The records contain only stable codes and identifiers: run/trace IDs, the initiating Container Apps revision and Git SHA, provider/model and provider request/response IDs/status where available, subtype, error code, elapsed milliseconds, output character count, and whether the outcome was usable. Terminal records also identify the worker revision and SHA. These diagnostics never include the prompt, answer, document text, filename, email address, or client identity.

The browser shows the run ID with an error. A signed-in owner can retrieve safe run metadata from `GET /chat/runs/:runId`. Startup failures before a run row exists show a distinct Request ID; a content-free marker on the saved chat turn restores a confirmed failure after reload. An uncertain run-creation status does not offer a retry because the original run might have committed. The database row `assistant_background_runs` also retains the source revision and Git SHA; a recovery worker does not overwrite them. The terminal log's `worker_revision` and `worker_git_sha` identify a different worker after a cross-revision recovery.

## Find one run without reading client content

Use the run ID shown in Docket. This Log Analytics query projects only safe fields:

```kusto
let runId = "<run UUID>";
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(7d)
| where ContainerAppName_s == "mike-api"
| extend diagnostic = parse_json(Log_s)
| where tostring(diagnostic.run_id) == runId
| where tostring(diagnostic.event) in ("assistant_run_terminal", "assistant_run_start_failure", "assistant_run_start_uncertain", "assistant_run_slow")
| project TimeGenerated, event = tostring(diagnostic.event), run_id = tostring(diagnostic.run_id), trace_id = tostring(diagnostic.trace_id), status = tostring(diagnostic.status), terminal_subtype = tostring(diagnostic.terminal_subtype), error_code = tostring(diagnostic.error_code), provider = tostring(diagnostic.provider), model = tostring(diagnostic.model), provider_status = tostring(diagnostic.provider_status), provider_request_id = tostring(diagnostic.provider_request_id), provider_response_id = tostring(diagnostic.provider_response_id), revision = tostring(diagnostic.revision), git_sha = tostring(diagnostic.git_sha), worker_revision = tostring(diagnostic.worker_revision), worker_git_sha = tostring(diagnostic.worker_git_sha), elapsed_ms = tolong(diagnostic.elapsed_ms), usable_result = tostring(diagnostic.usable_result)
```

If the terminal log is absent and the run started, query only metadata from PostgreSQL:

```sql
select stream_request_id, trace_id, revision, git_sha, model,
       provider_request_id, provider_response_id, provider_status,
       status, error_code, request_started_at, updated_at, completed_at
from public.assistant_background_runs
where stream_request_id = '<run UUID>';
```

Do not select `chat_messages.content` or request the user to send matter text for this diagnosis. Compare the run's source `revision`/`git_sha` to the Azure image tag and revision history. A run still active beyond its expected deadline should be checked against the background recovery logs by run ID.

## Alert configuration

The existing Azure action group `docket-assistant-runs` addresses `christopher@podlaskilegal.com`. The [alert definition](../infra/assistant-run-alerts.bicep) references that group and creates a scheduled query rule. It evaluates every five minutes over a 15-minute window. A startup failure or uncertain start, an active run reaching ten minutes, a failed or interrupted terminal run, a completed run marked unusable, or a completed run lasting ten minutes triggers a severity 2 incident alert. The query projects only metadata and contains no client content. This stateful rule groups incidents while its condition remains true; use the run-ID query above to list every affected run. Review noise after real traffic and adjust the slow-run threshold if needed. The owning API worker emits a slow signal for a live run; a healthy recovery worker also emits a bounded slow signal for a stale provider-pending run after a worker is lost. No alert can be emitted while every API worker is offline.

The Bicep scope defaults to the verified production workspace ARM ID, `/subscriptions/9c6e79df-0011-44a6-af74-070f3c92d5e5/resourceGroups/mike-prod-rg/providers/Microsoft.OperationalInsights/workspaces/workspace-mikeprodrg9isV`. On 2026-09-29, `mike-prod-env` reported its customer ID as `99ed9a48-3334-4735-9ada-9038e65ef336`. A metadata-only query against that workspace succeeded, and `ContainerAppConsoleLogs_CL` contained `Log_s` and `ContainerAppName_s`. The rule `docket-assistant-run-incidents` was deployed successfully and read back enabled with the intended workspace, query, five-minute evaluation, 15-minute window, severity 2, and action group.

For future changes, preview and apply the alert definition from the repository root:

```bash
az deployment group what-if --resource-group mike-prod-rg --template-file infra/assistant-run-alerts.bicep
az deployment group create --resource-group mike-prod-rg --template-file infra/assistant-run-alerts.bicep
```

An authenticated, synthetic failed-run test is still required to verify the full API-to-log-to-alert path. The current Azure CLI session cannot obtain Docket's delegated `access_as_user` token without interactive sign-in; no dedicated synthetic user was confirmed. Use a no-client-access test user and synthetic prompt, then query by run ID and inspect alert evaluation. Do not infer alert delivery from the rule existing alone.

Azure Monitor's test-notification API returned `BadRequest: There are no valid receivers in the request` for the new email receiver on 2026-09-29. [Microsoft requires one-time verification for new action-group email addresses](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups#notification-types). Confirm the recipient's verification and repeat a test notification before considering email delivery validated.

For the API deployment, set `GIT_COMMIT_SHA` to the exact reviewed source commit before starting the new revision. `CONTAINER_APP_REVISION` supplies the runtime revision automatically; `DEPLOY_VERSION` is only a fallback. Check a synthetic terminal event after rollout to confirm both version fields are non-null and match the intended image.
