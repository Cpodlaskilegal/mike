# Safe Local Testing

Docket is an Azure/Entra/PostgreSQL application. Local testing must use
disposable resources and synthetic documents; this fork does **not** use
Supabase, S3/R2, or OpenRouter.

Start with the checked-in templates rather than copying a production
environment:

```bash
cp -n backend/.env.example backend/.env
cp -n frontend/.env.local.example frontend/.env.local
```

Keep both local files untracked. Before committing, confirm that neither an
environment file nor any generated secret is staged:

```bash
git status --short
```

## Separate Every Stateful Service

Use a non-production resource for each stateful or external integration.

| Component               | Safe local choice                                                                                                                                                                                                                    | Do not use                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Authentication          | Separate Microsoft Entra SPA and API app registrations, with `http://localhost:3000/login` registered as a development redirect URI and a test work account                                                                          | The production client ID or a user account that can reach client matters |
| Database                | Separate Azure Database for PostgreSQL database, role, and credentials. Use TLS (`sslmode=require`). For an empty database, apply [`backend/migrations/azure_postgres_schema.sql`](../backend/migrations/azure_postgres_schema.sql). | Production database, schema, role, or backup                             |
| Document storage        | Separate Azure Blob Storage account or container, with a credential scoped only to that test resource                                                                                                                                | The production Blob container or a broadly privileged storage key        |
| Model providers         | Disposable or capped Anthropic, Gemini, and/or OpenAI key placed only in `backend/.env`                                                                                                                                              | Firm/provider keys with production budgets or document access            |
| Box and PracticePanther | Leave both managed MCP connectors disabled for generic local tests. For a connector-specific test, use a dedicated test user, folder, and OAuth app/credentials where available.                                                     | A Box account or PracticePanther connection with real firm/client data   |
| Email                   | A test recipient and sandbox/test provider configuration, only when testing email behavior                                                                                                                                           | A production mailing list or client email address                        |

The backend expects PostgreSQL through `DATABASE_URL`, Azure Blob Storage
through `AZURE_STORAGE_CONNECTION_STRING` **or** the
`AZURE_STORAGE_ACCOUNT`/`AZURE_STORAGE_KEY` pair, and Entra token validation
through `AZURE_TENANT_ID` and `AZURE_API_CLIENT_ID`.

## Minimal Local Configuration

Use the full examples as the source of truth. For a normal local integration
test, the important backend values are:

```env
PORT=3001
FRONTEND_URL=http://localhost:3000
API_PUBLIC_URL=http://localhost:3001
DOWNLOAD_SIGNING_SECRET=a-dedicated-random-local-secret

DATABASE_URL=postgres://docket:<password>@<test-server>.postgres.database.azure.com:5432/<test-db>?sslmode=require
PGSSLMODE=require

AZURE_TENANT_ID=<test-tenant-id>
AZURE_API_CLIENT_ID=<test-api-app-client-id>

AZURE_STORAGE_ACCOUNT=<test-storage-account>
AZURE_STORAGE_KEY=<test-storage-key>
AZURE_STORAGE_CONTAINER=docket-local-test

# Set only the provider(s) being tested, and keep their spend caps low.
OPENAI_API_KEY=<capped-test-key>
# ANTHROPIC_API_KEY=<capped-test-key>
# GEMINI_API_KEY=<capped-test-key>

# Keep managed connectors out of a normal local assistant test.
PRACTICEPANTHER_MCP_ENABLED=false
BOX_MCP_ENABLED=false
```

When testing saved per-user provider keys or MCP connectors, also use new,
dedicated random values for `USER_API_KEYS_ENCRYPTION_SECRET` and
`MCP_CONNECTORS_ENCRYPTION_SECRET`. Do not reuse a database, storage, auth, or
production secret.

`frontend/.env.local` contains only browser-safe configuration:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_AZURE_TENANT_ID=<test-tenant-id>
NEXT_PUBLIC_AZURE_CLIENT_ID=<test-spa-app-client-id>
NEXT_PUBLIC_AZURE_API_SCOPE=api://<test-api-app-client-id>/access_as_user
```

`NEXT_PUBLIC_*` values are embedded in the browser build. Never put database,
Blob Storage, model-provider, encryption, OAuth client-secret, or signing
secrets in that file. The backend validates Entra access tokens for
`AZURE_API_CLIENT_ID`; the frontend requests
`NEXT_PUBLIC_AZURE_API_SCOPE`.

## Start Offline, Then Add Test Services Deliberately

Install and build each package separately:

```bash
npm ci --prefix backend
npm ci --prefix frontend --legacy-peer-deps
npm run build --prefix backend
npm run lint --prefix frontend
npm run build --prefix frontend
```

The assistant-runtime compatibility check is offline: it reads the repository
contracts and makes no network calls or credential checks.

```bash
(cd backend && ./node_modules/.bin/tsx scripts/assistant-runtime-check.ts)
```

It verifies that the backend model registry and both frontend model pickers
agree, each provider adapter has abort wiring, both assistant SSE routes cancel
provider work on disconnect, and the server/browser agree on the core stream
events (`content_delta`, `reasoning_delta`, `citations`, `error`, and
`[DONE]`).

This check confirms source wiring only. It does **not** prove live provider
authentication, model availability, a real streamed response, Entra login,
Azure networking, Box OAuth, PracticePanther access, Blob permissions, or
production behavior.

Once the offline checks pass and the test resources are configured, run the
apps in separate terminals:

```bash
npm run dev --prefix backend
npm run dev --prefix frontend
```

Verify the unauthenticated backend health endpoint before signing in:

```bash
curl -fsS http://localhost:3001/health
```

Then sign in only with the test Entra account. An authenticated flow requires a
working test database because the backend creates/updates the application user
profile after token validation.

## Use Synthetic Documents and a Bounded Test Plan

Use fake or public documents only: sample NDAs, dummy PDFs/DOCX files, or
public court materials. Do not upload privileged, confidential, client,
matter, personnel, or firm knowledge-management content.

A safe progression is:

1. Run the offline compatibility and build checks.
2. Verify Entra login with the test account and create a test project.
3. Upload one synthetic document and confirm its object appears only in the
   dedicated test Blob container.
4. Exercise a non-LLM document/project flow.
5. Add one capped provider key and send one synthetic assistant request.
6. Only when connector behavior is in scope, enable one connector and use its
   dedicated test identity and data set.

Box is a per-user managed OAuth connector. If it is enabled, Docket can access
what the authenticated Box user can access, so do not authenticate a Box user
with production matter permissions during local testing. The Box OAuth callback
is `${API_PUBLIC_URL}/user/mcp-connectors/oauth/callback`; register the local
callback only in the dedicated test Box integration.

## Clean Up and Verify Deletion

After the test:

- delete uploaded synthetic documents and inspect the dedicated Blob container,
  including document versions, generated documents, and PDF derivatives;
- delete the test project/database rows or dispose of the entire test database;
- revoke disposable provider keys and any test OAuth grants;
- remove `backend/.env` and `frontend/.env.local` if they contain secrets; and
- rotate any test credential that was accidentally exposed or used outside its
  intended test resource.

Deletion is part of the legal-document safety check. A UI delete alone is not
enough—confirm that the corresponding object is gone from the test Azure Blob
container and that the test database no longer exposes it.
