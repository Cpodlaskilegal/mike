# Docket Azure Deployment

Production resources were created in Azure subscription `Azure subscription 1`
under resource group `mike-prod-rg` in `eastus2`.

## Live URLs

- Frontend: https://mike-web.kindwater-f73a2b5e.eastus2.azurecontainerapps.io
- Backend health: https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io/health

## Friendly Employee URL

Recommended public employee URL: `https://docket.podlaskilegal.com`.

As of 2026-06-23, Azure has `docket.podlaskilegal.com` registered on
`mike-web` with an `SniEnabled` managed certificate binding, and `mike-api`
has `FRONTEND_URL=https://docket.podlaskilegal.com`. A forced DNS test against
the Azure frontend IP returned `HTTP/2 307` over HTTPS, so any remaining access
issue is DNS resolver propagation.

The current Azure subscription does not manage the `podlaskilegal.com` DNS zone.
The domain is served by Wix nameservers (`ns0.wixdns.net`, `ns1.wixdns.net`),
so these DNS records have to be added in Wix before Azure can issue the managed
certificate.

1. Add DNS records for the frontend hostname:

   ```text
   CNAME docket -> mike-web.kindwater-f73a2b5e.eastus2.azurecontainerapps.io
   TXT asuid.docket -> 9E8CDE3EBD97BEBF7B49796920372C222CA4995AAF8CB74FB828DBE4528CB5B5
   ```

   Azure returned the TXT requirement above when `az containerapp hostname add`
   was attempted on 2026-06-23.

2. Bind the hostname to the frontend Container App:

   ```bash
   az containerapp hostname add \
     --resource-group mike-prod-rg \
     --name mike-web \
     --hostname docket.podlaskilegal.com

   az containerapp hostname bind \
     --resource-group mike-prod-rg \
     --name mike-web \
     --environment mike-prod-env \
     --hostname docket.podlaskilegal.com \
     --validation-method CNAME
   ```

3. Update backend CORS to trust the friendly frontend origin:

   ```bash
   az containerapp update \
     --resource-group mike-prod-rg \
     --name mike-api \
     --set-env-vars FRONTEND_URL=https://docket.podlaskilegal.com
   ```

4. Confirm the new SPA redirect URI is present on the Entra app registration
   `Docket` (original resource name: `mike-prod-web`). This was added on
   2026-06-23:

   ```text
   https://docket.podlaskilegal.com/login
   ```

The backend can keep using
`https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io` internally
and for `NEXT_PUBLIC_API_BASE_URL`. Only add a backend vanity hostname such as
`docket-api.podlaskilegal.com` if we also want cleaner OAuth callback URLs for MCP
connectors.

## Resource Names

- Container Apps environment: `mike-prod-env`
- Frontend Container App: `mike-web`
- Backend Container App: `mike-api`
- Azure Container Registry: `mikeacr9c6e79`
- PostgreSQL Flexible Server: `mike-pg-9c6e79`
- PostgreSQL database: `mike`
- Storage account: `mikedocs9c6e79`
- Blob container: `documents`
- Entra API app client id: `f1642f2c-5548-48b7-8010-7c15a424e105`
- Entra SPA app client id: `81f68716-e421-45ee-a90e-e905caa18bfb`
- API scope: `api://f1642f2c-5548-48b7-8010-7c15a424e105/access_as_user`

## Notes

- Container App secrets hold the database URL, storage key, registry password,
  and download signing secret.
- Provider and integration keys are stored as Container App secrets when
  supplied. The CourtListener token is configured on `mike-api` as
  `courtlistener-api-token` and exposed to the backend as
  `COURTLISTENER_API_TOKEN`.
- MCP connectors are enabled in the deployed app. `mike-api` uses
  `mcp-connectors-encryption-secret` for stored connector credentials and
  `API_PUBLIC_URL=https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io`
  for OAuth callbacks.
- Box is connected by default as a backend-managed MCP connector using
  `https://mcp.box.com`. To enable Box OAuth in production, add
  Box Admin Integration Credentials as `BOX_MCP_OAUTH_CLIENT_ID` and
  `BOX_MCP_OAUTH_CLIENT_SECRET` on `mike-api`, with callback
  `https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io/user/mcp-connectors/oauth/callback`.
  Each Docket user must authorize their own managed Box connector; Box MCP calls
  run with that user's Box permissions.
- PracticePanther is connected by default as a backend-managed MCP connector
  using `PRACTICEPANTHER_MCP_SERVER_URL`, which currently points at
  `https://wild-spark-qn7iy.run.mcp-use.com/mcp`. The backend auto-provisions
  the connector for authenticated users and keeps existing read/status tool
  cache behavior while disabling obvious mutating tools such as
  create/update/delete plus `pp_api_request` pending a human-confirmation path.
- Current deployed MCP backend image tag: `202606301419-chat-errors`.
- Current deployed frontend image tag: `202606301419-chat-errors`.
- The database schema for a clean Azure PostgreSQL install is
  `backend/migrations/azure_postgres_schema.sql`.
- Existing Azure PostgreSQL deployments must apply incremental migrations from
  `backend/migrations/` before deploying backend images that depend on them. For
  the user/admin roles rollout, apply
  `backend/migrations/20260701_user_roles_and_per_user_box_oauth.sql` before
  updating `mike-api`; it adds `app_users.role` and promotes the earliest
  existing user if no admin exists.
- Azure CLI has a stale local default group on this machine, so use
  `--resource-group mike-prod-rg` explicitly for Azure commands.
