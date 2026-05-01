# Mike Azure Deployment

Production resources were created in Azure subscription `Azure subscription 1`
under resource group `mike-prod-rg` in `eastus2`.

## Live URLs

- Frontend: https://mike-web.kindwater-f73a2b5e.eastus2.azurecontainerapps.io
- Backend health: https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io/health

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
- Model provider keys are intentionally unset in Azure until real Gemini,
  Anthropic, OpenRouter, or Resend secrets are provided.
- The database schema for a clean Azure PostgreSQL install is
  `backend/migrations/azure_postgres_schema.sql`.
- Azure CLI has a stale local default group on this machine, so use
  `--resource-group mike-prod-rg` explicitly for Azure commands.
