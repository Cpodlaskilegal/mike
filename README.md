# Docket

Docket is a legal document assistant with a Next.js frontend, an Express backend, Microsoft Entra authentication, Azure PostgreSQL, and Azure Blob Storage.

Website: [docket.podlaskilegal.com](https://docket.podlaskilegal.com)

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

No separate seed command is required for the application to start. Managed MCP
connectors are provisioned lazily for each authenticated user by the backend.

## Environment

Create local env files:

```bash
touch backend/.env
touch frontend/.env.local
```

The checked-in examples, `backend/.env.example` and
`frontend/.env.local.example`, list the required local environment variables.

Create `backend/.env`:

```bash
PORT=3001
FRONTEND_URL=http://localhost:3000
DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string
DATABASE_URL=postgres://docket:<password>@<server>.postgres.database.azure.com:5432/docket?sslmode=require
PGSSLMODE=require

AZURE_TENANT_ID=your-azure-tenant-id
AZURE_API_CLIENT_ID=your-api-app-client-id
AZURE_API_CLIENT_SECRET=your-api-app-client-secret
AZURE_API_SCOPE_NAME=access_as_user
AZURE_STORAGE_ACCOUNT=your-storage-account
AZURE_STORAGE_KEY=your-storage-account-key
AZURE_STORAGE_CONTAINER=documents

GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
POSTHOG_KEY=phc_your_posthog_project_api_key
POSTHOG_HOST=https://us.i.posthog.com
POSTHOG_AI_CAPTURE_CONTENT=false
RESEND_API_KEY=your-resend-key
SPEND_REPORT_FROM=Docket <reports@your-domain.com>
USER_API_KEYS_ENCRYPTION_SECRET=your-long-random-secret
MCP_CONNECTORS_ENCRYPTION_SECRET=your-long-random-secret
API_PUBLIC_URL=http://localhost:3001

# Box is backend-managed by default via Box's hosted MCP server.
# Create these in Box Admin Console Integration Credentials and register:
# ${API_PUBLIC_URL}/user/mcp-connectors/oauth/callback
BOX_MCP_SERVER_URL=https://mcp.box.com
BOX_MCP_OAUTH_CLIENT_ID=your-box-mcp-oauth-client-id
BOX_MCP_OAUTH_CLIENT_SECRET=your-box-mcp-oauth-client-secret
# Defaults to root_readwrite. Add ai.readwrite/docgen.readwrite only if enabled
# on the Box app.
# BOX_MCP_OAUTH_SCOPE=root_readwrite
# BOX_MCP_ENABLED=false
```

Create `frontend/.env.local`:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_AZURE_TENANT_ID=your-azure-tenant-id
NEXT_PUBLIC_AZURE_CLIENT_ID=your-spa-app-client-id
NEXT_PUBLIC_AZURE_API_SCOPE=api://your-api-app-client-id/access_as_user
NEXT_PUBLIC_POSTHOG_KEY=phc_your_posthog_project_api_key
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

Entra values come from the Microsoft Entra app registrations. The backend validates access tokens for `AZURE_API_CLIENT_ID` and requires the delegated scope named by `AZURE_API_SCOPE_NAME`; the frontend requests `NEXT_PUBLIC_AZURE_API_SCOPE`.

### Signed-in user's email

Docket's assistant and project assistant can get read-only access to the
currently signed-in user's own Microsoft 365 mailbox through the existing
sign-in. The browser still requests only the Docket API scope. The backend
exchanges that already-validated access token through Microsoft's OAuth
on-behalf-of flow and calls Microsoft Graph `/me` as that user. A user who can
access a shared Docket chat still queries their own mailbox, never the chat
creator's mailbox. Mailbox tools are not exposed in tabular reviews.

Configure the backend API app registration as follows:

1. Add Microsoft Graph **delegated** permission `Mail.Read` and grant tenant
   admin consent.
2. Create a confidential-client credential for the backend API registration
   and provide it to the backend as the `AZURE_API_CLIENT_SECRET` secret. Never
   bake this value into an image or frontend environment variable.
3. Do not add Graph application mail permissions, `Mail.Read.Shared`,
   `Mail.ReadWrite`, or `Mail.Send`. Docket's native mail tools are hard-coded
   to `/me/messages` and cannot select another mailbox.
4. Apply `backend/migrations/20260812_assistant_native_tool_audit_logs.sql` to
   an existing database **before deploying this backend**, even if mailbox
   access will remain disabled initially.

Mailbox tools activate when the user's current request explicitly asks for
email. The assistant can search and read bounded messages; after a successful
mail read, the remainder of that one assistant response is limited to reading
messages returned by that search so email content cannot trigger unrelated
tools. The next user turn has the normal toolset again. The assistant cannot
send, draft, delete, move, or edit mail. Email content is treated as untrusted
data, is supplied to the selected model when a mail tool is used, and may be
reflected in the persisted assistant response. The response follows the chat's
existing Docket visibility rules; mailbox use does not silently change sharing
or disable later turns. Docket's mailbox audit stores actor and correlation
metadata, never the message body, subject, access token, or search text.

PostHog is optional. When `NEXT_PUBLIC_POSTHOG_KEY` is unset, the frontend does not initialize PostHog. Set `NEXT_PUBLIC_POSTHOG_HOST` to your PostHog region host, such as `https://us.i.posthog.com` or `https://eu.i.posthog.com`. The frontend starts session replay with inputs masked and supports `ph-no-capture` / `ph-mask` CSS classes for sensitive UI.

Backend AI observability uses `POSTHOG_KEY` and `POSTHOG_HOST`. OpenAI calls are captured as PostHog `$ai_generation` events with model, latency, token counts, route, user, chat, and project metadata. Prompt and completion text are redacted by default; set `POSTHOG_AI_CAPTURE_CONTENT=true` only in an environment where full AI trace content is acceptable.

The admin spend report ledger tracks Docket-managed GPT and Claude calls at published model pricing and creates a report when account spend crosses each $100 milestone. Set both `RESEND_API_KEY` and `SPEND_REPORT_FROM` to email each current admin; without both, the report remains in the admin dashboard with a `not_configured` delivery status. Administrators can retry a persisted report from Settings after fixing mail configuration or an email-provider outage. User-supplied provider-key usage is retained as usage metadata but excluded from Docket account spend totals.

For the Azure Container Apps frontend, `NEXT_PUBLIC_*` values are baked into
the Next.js client bundle during the Docker build. To roll out PostHog to
production, run `scripts/deploy-posthog-frontend.sh` with `POSTHOG_KEY` and
`POSTHOG_HOST` set.

Provider keys are only needed for the model providers and administrative report delivery features you plan to use. Model provider keys can be configured in `backend/.env` for the whole instance, or per user in **Account > Models & API Keys**. If a provider key is present in `backend/.env`, that provider is available by default and the matching browser API key field is read-only.

MCP connector credentials and OAuth tokens are encrypted with `MCP_CONNECTORS_ENCRYPTION_SECRET`. PracticePanther is connected by default as a backend-managed MCP connector using `PRACTICEPANTHER_MCP_SERVER_URL` (default `https://wild-spark-qn7iy.run.mcp-use.com/mcp`). Box is also connected by default as a backend-managed MCP connector using Box's hosted endpoint at `https://mcp.box.com`. Each Docket user authorizes Box separately, and Docket can access whatever that logged-in user can access in Box.

Box write tools are available to the assistant, but each proposed write pauses
for the initiating user's **Approve once** or **Deny** decision. Enabling a tool
in connector settings only makes it available; it never authorizes a write.
Approval records bind the exact arguments and current tool contract, expire
after 30 minutes, and cannot be replayed. Uploads, copies, folder creation,
metadata changes, moves, sharing changes, and other mutations use this same
flow. Box permissions and admin-enabled tool availability still apply.

For an existing deployment, apply
`backend/migrations/20260915_box_write_approvals.sql` with the updated backend
to re-enable Box tools disabled by the previous blanket confirmation policy.
The existing `20260723_practicepanther_access_control.sql` approval table is
reused; the Box change does not require a new table. A tool-catalog refresh
discovers tools newly enabled by the Box administrator.

## Custom Instructions

Under **Settings > Instructions**, each user can save personal instructions.
Administrators can also save firm-wide instructions that everyone can read.
Firm-wide instructions take priority over personal preferences. Both apply to
new Assistant, Project Assistant, and Tabular Review chat replies. They do not
change the separate structured cell-extraction or title-generation prompts,
and they do not grant access to tools or authorize external actions. Both
instruction fields are empty until someone saves them.

For an existing database, apply
`backend/migrations/20260923_custom_instructions.sql` before deploying the
backend code that reads these settings.

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
4. To connect Box, configure the Box MCP OAuth env vars, open **Account > Connectors**, refresh the backend-managed Box connector, and complete Box OAuth while signed in as the Box user whose permissions Docket should use. When Box OAuth is configured and enabled, authenticated users must connect Box before using the rest of the app.

## Troubleshooting

**Sign-in fails before reaching Docket.** Confirm the frontend redirect URI is registered in the Entra SPA app and that the API scope/admin consent configuration matches `NEXT_PUBLIC_AZURE_API_SCOPE`.

**The assistant cannot access email.** Confirm the backend API app registration
has delegated Microsoft Graph `Mail.Read` with tenant consent, the Container App
has a valid `AZURE_API_CLIENT_SECRET`, and the user signed in again after consent
was granted. Do not resolve this by granting an application mail permission.

**The model picker shows a missing-key warning.** Add a key for that provider in **Account > Models & API Keys**, or configure the provider key in `backend/.env` and restart the backend.

**DOC or DOCX conversion fails.** Install LibreOffice locally and restart the backend so document conversion commands are available on the process path.

## Useful Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run lint --prefix frontend
```
