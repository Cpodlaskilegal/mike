# Docket CLI

A local command line client for [Docket](https://docket.podlaskilegal.com). It uses a dedicated Microsoft Entra public client registration and Docket's existing delegated API scope. The commands use the Docket API directly; the site domain serves the web interface.

## Install

Use Node.js 20 or newer. To install this version from a fresh machine:

```bash
git clone --branch codex/docket-cli --single-branch https://github.com/Cpodlaskilegal/mike.git
cd mike/cli
npm ci
npm link
docket health
docket login
docket whoami
```

`npm link` puts `docket` on your shell path. If you do not want a global link, run `node bin/docket.mjs` from `mike/cli` after `npm ci`.

At sign-in, the CLI prints a Microsoft device-code message to the terminal. Complete that sign-in with your Docket Entra account. The CLI never prints an access token. It uses the registered public client ID `009d6299-45e1-42d5-ad79-47a575081a8a` and asks for `api://f1642f2c-5548-48b7-8010-7c15a424e105/access_as_user`. Tenant-wide delegated consent is configured for that scope. The Docket API enforces the same user and project access as the web app.

## Commands

```bash
docket health
docket login
docket whoami
docket projects list
docket projects show <project-id>
docket chats list
docket chats show <chat-id>
docket project-chats list <project-id>
docket documents list
docket documents list --project <project-id>
docket workflows list
docket workflows list --type assistant
docket ask "Summarize the issues in this matter" --project <project-id>
docket ask "Follow up on that answer" --chat <chat-id>
docket logout
```

Add `--json` to any command for JSON on stdout. `ask` reports the chat ID for follow-up; in plain text mode the ID appears on stderr so stdout contains only the answer. A stream returns success only after Docket reports `stream_terminal: completed` and closes the stream with `[DONE]`. Background or interrupted runs, input requests, and connector approvals exit nonzero and include the chat ID when available. Open that chat in the web app to answer or approve. `--chat` loads existing messages so the follow-up retains the conversation; if the chat belongs to a project, the CLI uses that project's chat endpoint.

The initial CLI supports read commands and assistant questions. It does not yet expose document uploads, edits, workflow execution, or Ask Inputs responses. Some assistant actions can require approval in the web app.

## Configuration and cache

Production defaults are included for the Docket tenant, dedicated CLI public client, delegated API scope, and API origin. Override them for a separate environment:

```bash
export DOCKET_API_BASE_URL=https://example-api.example.com
export DOCKET_TENANT_ID=<tenant-id>
export DOCKET_CLIENT_ID=<public-client-app-id>
export DOCKET_API_SCOPE=api://<api-app-id>/access_as_user
```

The CLI only sends bearer tokens to an HTTPS API origin, except HTTP on localhost for development. The MSAL token cache lives at `~/.config/docket/msal-cache.json` (or under `$XDG_CONFIG_HOME/docket`). Set `DOCKET_CACHE_PATH` to use another location. The CLI creates its cache directory with mode `0700` and its cache file with mode `0600`; `docket logout` deletes that local cache. Silent MSAL acquisition refreshes tokens as needed. The cache is local to this CLI and separate from your Docket browser session.

## Test

```bash
npm test --prefix cli
```
