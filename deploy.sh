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
echo "=== SlumlordWatch Deploy ==="
echo "Project: $PROJECT_ID"
echo "Region:  $REGION"
echo ""

# --- 1. Deploy to Cloud Run (Vertex AI via ADC, no API key needed) ---
echo "Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION},GOOGLE_GENAI_USE_VERTEXAI=True" \
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
