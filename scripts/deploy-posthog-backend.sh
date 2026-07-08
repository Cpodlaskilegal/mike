#!/usr/bin/env bash
set -euo pipefail

POSTHOG_KEY="${POSTHOG_KEY:-}"
POSTHOG_HOST="${POSTHOG_HOST:-https://us.i.posthog.com}"
POSTHOG_AI_CAPTURE_CONTENT="${POSTHOG_AI_CAPTURE_CONTENT:-false}"
TAG="${TAG:-$(date -u +%Y%m%d%H%M)-posthog-ai}"

if [[ -z "$POSTHOG_KEY" ]]; then
  echo "Set POSTHOG_KEY to the PostHog project token, for example: phc_..." >&2
  exit 2
fi

if [[ ! "$POSTHOG_KEY" =~ ^phc_ ]]; then
  echo "POSTHOG_KEY should be the public project token that starts with phc_." >&2
  exit 2
fi

case "$POSTHOG_HOST" in
  http://*|https://*) ;;
  *)
    echo "POSTHOG_HOST must be a URL, for example https://us.i.posthog.com." >&2
    exit 2
    ;;
esac

case "$POSTHOG_AI_CAPTURE_CONTENT" in
  true|false) ;;
  *)
    echo "POSTHOG_AI_CAPTURE_CONTENT must be true or false." >&2
    exit 2
    ;;
esac

az acr build \
  --registry mikeacr9c6e79 \
  --image "mike-api:$TAG" \
  --file backend/Dockerfile \
  backend

az containerapp update \
  --resource-group mike-prod-rg \
  --name mike-api \
  --image "mikeacr9c6e79.azurecr.io/mike-api:$TAG" \
  --set-env-vars \
    "DEPLOY_VERSION=$TAG" \
    "POSTHOG_KEY=$POSTHOG_KEY" \
    "POSTHOG_HOST=$POSTHOG_HOST" \
    "POSTHOG_AI_CAPTURE_CONTENT=$POSTHOG_AI_CAPTURE_CONTENT"

az containerapp show \
  --resource-group mike-prod-rg \
  --name mike-api \
  --query '{latestReadyRevisionName:properties.latestReadyRevisionName,image:properties.template.containers[0].image,traffic:properties.configuration.ingress.traffic}' \
  -o json

echo "Backend deployed with PostHog host: $POSTHOG_HOST"
echo "AI trace content capture: $POSTHOG_AI_CAPTURE_CONTENT"
echo "Image tag: $TAG"
