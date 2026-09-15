-- Run with the Box approval-capable backend release. The old backend disabled
-- every confirmation-required Box tool and did not let users enable it.
-- Restore those tools' availability; executing each write still needs its own
-- initiating-user approval. Preserve disabled tools outside that old policy.
begin;

-- Mark each connector once so rerunning the migration cannot undo a user's
-- later decision to disable a write tool.
with upgraded_connectors as (
  update public.user_mcp_connectors as connectors
     set tool_policy = coalesce(tool_policy, '{}'::jsonb) ||
           '{"boxWriteApprovalPolicy":"2026-09-15.1"}'::jsonb,
         updated_at = now()
   where (
     connectors.tool_policy->>'managedConnector' = 'box'
     or connectors.server_url in ('https://mcp.box.com', 'https://mcp.box.com/')
   )
     and connectors.tool_policy->>'boxWriteApprovalPolicy'
           is distinct from '2026-09-15.1'
  returning connectors.id
)
update public.user_mcp_connector_tools as tools
   set enabled = true, updated_at = now()
  from upgraded_connectors
 where tools.connector_id = upgraded_connectors.id
   and tools.requires_confirmation = true
   and tools.enabled = false;

commit;
