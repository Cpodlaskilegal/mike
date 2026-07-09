# AGENTS.md

## Project

Docket is a split Node application:

- `backend/` - Express API, TypeScript, PostgreSQL, Azure Blob Storage, MCP connector logic.
- `frontend/` - Next.js app.

Use npm in each package directory. Do not use root-level package manager commands for this repo.

## Codex Cloud Environment

Configure the Codex Cloud environment for `Cpodlaskilegal/mike` with:

```bash
bash scripts/codex-cloud-setup.sh
```

Use this optional maintenance script for cached containers:

```bash
bash scripts/codex-cloud-maintenance.sh
```

The setup script installs backend and frontend dependencies from the lockfiles and creates non-secret local env files that are sufficient for builds and basic start smoke checks. Do not put production secrets in the repo.

Recommended Codex Cloud runtime:

- Node.js 20 or newer.
- Agent internet access can stay off for normal code work after setup; setup needs internet access for npm and apt packages.
- If cloud tasks need live Azure deployment, provide Azure credentials through the Codex environment UI or perform deployment from a local authenticated shell instead.

## Required Checks

Before claiming this app is deployable, verify from a clean state:

```bash
npm ci --prefix backend
npm ci --prefix frontend --legacy-peer-deps
npm run build --prefix backend
npm run lint --prefix frontend
npm run build --prefix frontend
```

If changing backend runtime startup behavior, also run a backend smoke check:

```bash
PORT=3201 npm start --prefix backend
curl -fsS http://localhost:3201/health
```

If changing frontend runtime startup behavior, also run a frontend smoke check after building:

```bash
PORT=3200 npm start --prefix frontend
curl -fsSI http://localhost:3200/login
```

## Deployment Rule

Before claiming this app is deployed, verify the deployed Azure Container Apps, not only the local build.

Production resources:

- Resource group: `mike-prod-rg`
- Backend Container App: `mike-api`
- Frontend Container App: `mike-web`
- ACR: `mikeacr9c6e79`

After deployment, confirm:

- `mike-api` latest revision equals latest ready revision.
- `mike-web` latest revision equals latest ready revision.
- Both apps run the expected image tag.
- Traffic is 100% to the intended revision.
- `https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io/health` returns OK.
- `https://docket.podlaskilegal.com/login` returns HTTP 200 or the expected login response.

## Migrations

For fresh databases, use `backend/migrations/azure_postgres_schema.sql` or the documented schema path in `README.md`.

For existing production databases, do not run the full schema over live data. Apply only the relevant incremental migration files in `backend/migrations/` before deploying backend code that depends on them.

## Output Format For Deployment Work

End every deployment task with:

- commands run
- errors found
- files changed
- remaining manual steps
- confidence level
