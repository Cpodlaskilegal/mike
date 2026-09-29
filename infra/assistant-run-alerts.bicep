@description('ARM resource ID of the Log Analytics workspace connected to mike-prod-env.')
param logScopeResourceId string = '/subscriptions/9c6e79df-0011-44a6-af74-070f3c92d5e5/resourceGroups/mike-prod-rg/providers/Microsoft.OperationalInsights/workspaces/workspace-mikeprodrg9isV'

@description('Region for the scheduled query rule.')
param alertLocation string = 'eastus2'

resource actionGroup 'Microsoft.Insights/actionGroups@2021-09-01' existing = {
  name: 'docket-assistant-runs'
}

resource assistantRunAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'docket-assistant-run-incidents'
  location: alertLocation
  kind: 'LogAlert'
  properties: {
    displayName: 'Docket assistant failed, empty, or slow run'
    description: 'Content-free startup, slow-run, and terminal diagnostics for Docket assistant runs.'
    enabled: true
    severity: 2
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [logScopeResourceId]
    criteria: {
      allOf: [
        {
          query: '''
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(15m)
| where ContainerAppName_s == "mike-api"
| extend diagnostic = parse_json(Log_s)
| extend event = tostring(diagnostic.event)
| where event in ("assistant_run_terminal", "assistant_run_start_failure", "assistant_run_start_uncertain", "assistant_run_slow")
| extend status = tostring(diagnostic.status), usable_result = tostring(diagnostic.usable_result), elapsed_ms = tolong(diagnostic.elapsed_ms)
| where event in ("assistant_run_start_failure", "assistant_run_start_uncertain", "assistant_run_slow") or (event == "assistant_run_terminal" and (status in ("failed", "interrupted") or (status == "completed" and usable_result == "false") or elapsed_ms >= 600000))
| project TimeGenerated, event, run_id = tostring(diagnostic.run_id), status, terminal_subtype = tostring(diagnostic.terminal_subtype), elapsed_ms
'''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [actionGroup.id]
    }
  }
}

output actionGroupId string = actionGroup.id
output alertRuleId string = assistantRunAlert.id
