#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Automated Cloud Run deployment for Janus
# Usage: ./deploy.sh
# Prerequisites: gcloud CLI installed and authenticated
# =============================================================================
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
PROJECT_ID="norse-ego-479919-v2"
REGION="us-central1"
SERVICE_NAME="janus-backend"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# ── Ensure gcloud project is set ──────────────────────────────────────────────
echo "▶ Setting active GCP project to: ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}"

# ── Enable required APIs ──────────────────────────────────────────────────────
echo "▶ Enabling required Google Cloud APIs..."
gcloud services enable \
  run.googleapis.com \
  containerregistry.googleapis.com \
  aiplatform.googleapis.com \
  --project="${PROJECT_ID}"

# ── Build and push Docker image ───────────────────────────────────────────────
echo "▶ Building Docker image: ${IMAGE}"
gcloud builds submit \
  --tag "${IMAGE}" \
  --project="${PROJECT_ID}" \
  .

# ── Deploy to Cloud Run ───────────────────────────────────────────────────────
echo "▶ Deploying to Cloud Run service: ${SERVICE_NAME} in ${REGION}"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars "API_KEY=${API_KEY:-},GOOGLE_PROJECT_ID=${PROJECT_ID},GOOGLE_LOCATION=${REGION}" \
  --project="${PROJECT_ID}"

# ── Print service URL ─────────────────────────────────────────────────────────
echo ""
echo "✅ Deployment complete!"
gcloud run services describe "${SERVICE_NAME}" \
  --platform managed \
  --region "${REGION}" \
  --format "value(status.url)" \
  --project="${PROJECT_ID}"
