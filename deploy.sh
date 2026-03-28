#!/bin/bash
# deploy.sh — Deploy SlumlordWatch to Cloud Run
# Serves both backend API and frontend static files.
# Custom domain: slumwatch.poemswe.com (Cloudflare CNAME)
#
# Run from the project root: ./deploy.sh

set -e

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-slumwatch}"
REGION="us-central1"
SERVICE_NAME="slumlordwatch"
SECRET_NAME="gemini-api-key"

echo "=== SlumlordWatch Deploy ==="
echo "Project: $PROJECT_ID"
echo "Region:  $REGION"
echo ""

# --- 0. Ensure secret exists in Secret Manager ---
if ! gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" &>/dev/null; then
  echo "Creating secret '$SECRET_NAME' in Secret Manager..."
  echo "  Paste your Gemini API key, then press Enter:"
  read -rs API_KEY
  echo -n "$API_KEY" | gcloud secrets create "$SECRET_NAME" \
    --project "$PROJECT_ID" \
    --data-file=-
  echo "  Secret created."
else
  echo "Secret '$SECRET_NAME' already exists."
fi

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
  --project "$PROJECT_ID" \
  --member "serviceAccount:${SA}" \
  --role "roles/secretmanager.secretAccessor" \
  --quiet

# --- 1. Deploy to Cloud Run ---
echo ""
echo "Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-secrets "GOOGLE_API_KEY=${SECRET_NAME}:latest" \
  --memory 512Mi \
  --cpu 1 \
  --timeout 600 \
  --concurrency 10 \
  --min-instances 0 \
  --max-instances 3

BACKEND_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format 'value(status.url)')

echo ""
echo "Deployment complete!"
echo "  Cloud Run: $BACKEND_URL"
echo ""
echo "Cloudflare DNS setup (one-time):"
echo "  Type:  CNAME"
echo "  Name:  slumwatch"
echo "  Target: ${BACKEND_URL#https://}"
echo "  Proxy:  ON (orange cloud)"
