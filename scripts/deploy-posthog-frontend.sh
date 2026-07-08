#!/usr/bin/env bash
set -euo pipefail

POSTHOG_KEY="${POSTHOG_KEY:-}"
POSTHOG_HOST="${POSTHOG_HOST:-https://us.i.posthog.com}"
TAG="${TAG:-$(date -u +%Y%m%d%H%M)-posthog}"

if [[ -z "$POSTHOG_KEY" ]]; then
  echo "Set POSTHOG_KEY to the PostHog project token, for example: phc_..." >&2
  exit 2
fi

if [[ ! "$POSTHOG_KEY" =~ ^phc_ ]]; then
  echo "POSTHOG_KEY should be the public project token that starts with phc_." >&2
  exit 2
fi

case "$POSTHOG_HOST" in
  https://us.i.posthog.com|https://eu.i.posthog.com|http://*|https://*) ;;
  *)
    echo "POSTHOG_HOST must be a URL, for example https://us.i.posthog.com." >&2
    exit 2
    ;;
esac

az acr build \
  --registry mikeacr9c6e79 \
  --image "mike-web:$TAG" \
  --file frontend/Dockerfile \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://mike-api.kindwater-f73a2b5e.eastus2.azurecontainerapps.io \
  --build-arg NEXT_PUBLIC_AZURE_TENANT_ID=93fa5a2e-4598-4c6e-86f9-6092f6b8c0c4 \
  --build-arg NEXT_PUBLIC_AZURE_CLIENT_ID=81f68716-e421-45ee-a90e-e905caa18bfb \
  --build-arg NEXT_PUBLIC_AZURE_API_SCOPE=api://f1642f2c-5548-48b7-8010-7c15a424e105/access_as_user \
  --build-arg NEXT_PUBLIC_OPENAI_ENABLED=false \
  --build-arg "NEXT_PUBLIC_POSTHOG_KEY=$POSTHOG_KEY" \
  --build-arg "NEXT_PUBLIC_POSTHOG_HOST=$POSTHOG_HOST" \
  frontend

az containerapp update \
  --resource-group mike-prod-rg \
  --name mike-web \
  --image "mikeacr9c6e79.azurecr.io/mike-web:$TAG" \
  --set-env-vars "DEPLOY_VERSION=$TAG" "NEXT_PUBLIC_POSTHOG_HOST=$POSTHOG_HOST"

az containerapp show \
  --resource-group mike-prod-rg \
  --name mike-web \
  --query '{latestReadyRevisionName:properties.latestReadyRevisionName,image:properties.template.containers[0].image,traffic:properties.configuration.ingress.traffic}' \
  -o json

echo "Frontend deployed with PostHog host: $POSTHOG_HOST"
echo "Image tag: $TAG"
