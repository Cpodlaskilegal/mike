#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Checking Node.js"
node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 20) { console.error(`Node.js 20+ is required; found ${process.version}`); process.exit(1); } console.log(`Node ${process.version}`);'

install_system_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "==> apt-get not found; skipping system package install"
    return 0
  fi

  local apt_cmd=(apt-get)
  if [ "$(id -u)" -ne 0 ]; then
    if ! command -v sudo >/dev/null 2>&1; then
      echo "==> sudo not found; skipping system package install"
      return 0
    fi
    apt_cmd=(sudo apt-get)
  fi

  echo "==> Installing system packages used by document conversion"
  DEBIAN_FRONTEND=noninteractive "${apt_cmd[@]}" update
  DEBIAN_FRONTEND=noninteractive "${apt_cmd[@]}" install -y --no-install-recommends libreoffice poppler-utils
}

write_backend_env() {
  if [ -f backend/.env ]; then
    echo "==> backend/.env already exists; leaving it unchanged"
    return 0
  fi

  echo "==> Creating backend/.env with non-secret Codex defaults"
  cat > backend/.env <<'EOF'
PORT=3001
FRONTEND_URL=http://localhost:3000
DOWNLOAD_SIGNING_SECRET=0000000000000000000000000000000000000000000000000000000000000000
DATABASE_URL=postgres://docket:dummy@localhost:5432/docket
PGSSLMODE=disable

AZURE_TENANT_ID=00000000-0000-0000-0000-000000000000
AZURE_API_CLIENT_ID=00000000-0000-0000-0000-000000000000
AZURE_STORAGE_ACCOUNT=devstoreaccount1
AZURE_STORAGE_KEY=dummy
AZURE_STORAGE_CONTAINER=documents

GEMINI_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
POSTHOG_KEY=
POSTHOG_HOST=https://us.i.posthog.com
POSTHOG_AI_CAPTURE_CONTENT=false
COURTLISTENER_API_TOKEN=
COURTLISTENER_BULK_DATA_ENABLED=false
RESEND_API_KEY=
USER_API_KEYS_ENCRYPTION_SECRET=codex-user-api-keys-local-placeholder-32-bytes
MCP_CONNECTORS_ENCRYPTION_SECRET=codex-mcp-connectors-local-placeholder-32-bytes
API_PUBLIC_URL=http://localhost:3001
PRACTICEPANTHER_MCP_SERVER_URL=https://wild-spark-qn7iy.run.mcp-use.com/mcp
PRACTICEPANTHER_MCP_ENABLED=false
BOX_MCP_SERVER_URL=https://mcp.box.com
BOX_MCP_OAUTH_CLIENT_ID=
BOX_MCP_OAUTH_CLIENT_SECRET=
BOX_MCP_ENABLED=false
EOF
}

write_frontend_env() {
  if [ -f frontend/.env.local ]; then
    echo "==> frontend/.env.local already exists; leaving it unchanged"
    return 0
  fi

  echo "==> Creating frontend/.env.local with non-secret Codex defaults"
  cat > frontend/.env.local <<'EOF'
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_AZURE_TENANT_ID=00000000-0000-0000-0000-000000000000
NEXT_PUBLIC_AZURE_CLIENT_ID=00000000-0000-0000-0000-000000000000
NEXT_PUBLIC_AZURE_API_SCOPE=api://00000000-0000-0000-0000-000000000000/access_as_user
NEXT_PUBLIC_POSTHOG_KEY=
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
EOF
}

install_node_packages() {
  echo "==> Installing backend dependencies"
  npm ci --prefix backend

  echo "==> Installing frontend dependencies"
  npm ci --prefix frontend --legacy-peer-deps
}

install_system_packages
write_backend_env
write_frontend_env
install_node_packages

echo "==> Codex Cloud setup complete"
