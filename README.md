# Mike

Mike is a legal document assistant with a Next.js frontend, an Express backend, Microsoft Entra authentication, Azure PostgreSQL, and Azure Blob Storage.

Website: [mikeoss.com](https://mikeoss.com)

## Contents

- `frontend/` - Next.js application
- `backend/` - Express API, PostgreSQL access, document processing, and database schema
- `backend/schema.sql` - PostgreSQL schema for fresh databases
- `backend/migrations/` - incremental database updates for existing deployments

## Prerequisites

- Node.js 20 or newer
- npm
- git
- A PostgreSQL database, such as Azure Database for PostgreSQL
- Microsoft Entra app registrations for the frontend SPA and backend API
- An Azure Blob Storage account/container
- At least one supported model provider API key: Anthropic, Google Gemini, or OpenAI
- LibreOffice installed locally if you need DOC/DOCX to PDF conversion

## Database Setup

For a new PostgreSQL database, run:

```sql
-- copy and run the contents of:
-- backend/schema.sql
```

The schema file is based on `supabase-migration.sql` and folds in the later files in `backend/migrations/`.

For an existing database, do not run the full schema file over production data. Apply the incremental files in `backend/migrations/` instead.

## Environment

Create local env files:

```bash
touch backend/.env
touch frontend/.env.local
```

Create `backend/.env`:

```bash
PORT=3001
FRONTEND_URL=http://localhost:3000
DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string
DATABASE_URL=postgres://mike:<password>@<server>.postgres.database.azure.com:5432/mike?sslmode=require
PGSSLMODE=require

AZURE_TENANT_ID=your-azure-tenant-id
AZURE_API_CLIENT_ID=your-api-app-client-id
AZURE_STORAGE_ACCOUNT=your-storage-account
AZURE_STORAGE_KEY=your-storage-account-key
AZURE_STORAGE_CONTAINER=documents

GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
RESEND_API_KEY=your-resend-key
USER_API_KEYS_ENCRYPTION_SECRET=your-long-random-secret
```

Create `frontend/.env.local`:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_AZURE_TENANT_ID=your-azure-tenant-id
NEXT_PUBLIC_AZURE_CLIENT_ID=your-spa-app-client-id
NEXT_PUBLIC_AZURE_API_SCOPE=api://your-api-app-client-id/access_as_user
```

Entra values come from the Microsoft Entra app registrations. The backend validates access tokens for `AZURE_API_CLIENT_ID`; the frontend requests `NEXT_PUBLIC_AZURE_API_SCOPE`.

Provider keys are only needed for the models and email features you plan to use. Model provider keys can be configured in `backend/.env` for the whole instance, or per user in **Account > Models & API Keys**. If a provider key is present in `backend/.env`, that provider is available by default and the matching browser API key field is read-only.

## Install

Install each app package:

```bash
npm install --prefix backend
npm install --prefix frontend
```

## Run Locally

Start the backend:

```bash
npm run dev --prefix backend
```

Start the main app:

```bash
npm run dev --prefix frontend
```

Open `http://localhost:3000`.

## First Run

1. Sign in with a Microsoft work account that can access the Entra app.
2. If you did not set provider keys in `backend/.env`, open **Account > Models & API Keys** and add an Anthropic, Gemini, or OpenAI API key.
3. Create or open a project and start chatting with documents.

## Troubleshooting

**Sign-in fails before reaching Mike.** Confirm the frontend redirect URI is registered in the Entra SPA app and that the API scope/admin consent configuration matches `NEXT_PUBLIC_AZURE_API_SCOPE`.

**The model picker shows a missing-key warning.** Add a key for that provider in **Account > Models & API Keys**, or configure the provider key in `backend/.env` and restart the backend.

**DOC or DOCX conversion fails.** Install LibreOffice locally and restart the backend so document conversion commands are available on the process path.

## Useful Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run lint --prefix frontend
```
