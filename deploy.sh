#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}"
ENV_FILE="${PROJECT_ROOT}/.env"

PROJECT_ID="${PROJECT_ID:-}"
PROJECT_NAME="${PROJECT_NAME:-Janus}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-janus-backend}"
ARTIFACT_REPO="${ARTIFACT_REPO:-janus}"
IMAGE=""

BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"

FIRESTORE_DATABASE="${FIRESTORE_DATABASE:-(default)}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"

RUNTIME_SERVICE_ACCOUNT_NAME="${RUNTIME_SERVICE_ACCOUNT_NAME:-janus-backend}"
RUNTIME_SERVICE_ACCOUNT_DISPLAY_NAME="${RUNTIME_SERVICE_ACCOUNT_DISPLAY_NAME:-Janus Cloud Run Runtime}"

YOUTUBE_API_KEY_SECRET_NAME="${YOUTUBE_API_KEY_SECRET_NAME:-janus-youtube-api-key}"
YOUTUBE_API_KEY_ID="${YOUTUBE_API_KEY_ID:-janus-youtube-runtime}"
YOUTUBE_API_KEY_DISPLAY_NAME="${YOUTUBE_API_KEY_DISPLAY_NAME:-Janus YouTube Runtime}"

CLOUD_RUN_TIMEOUT="${CLOUD_RUN_TIMEOUT:-3600}"
CLOUD_RUN_MEMORY="${CLOUD_RUN_MEMORY:-2Gi}"
CLOUD_RUN_CPU="${CLOUD_RUN_CPU:-2}"
ALLOW_UNAUTHENTICATED="${ALLOW_UNAUTHENTICATED:-true}"

log() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Error: required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

csv_join() {
  local IFS=,
  printf '%s' "$*"
}

generate_default_project_id() {
  local account_prefix
  account_prefix="$(gcloud config get-value account 2>/dev/null || true)"
  account_prefix="${account_prefix%@*}"
  account_prefix="$(printf '%s' "${account_prefix}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')"
  account_prefix="${account_prefix#-}"
  account_prefix="${account_prefix%-}"
  account_prefix="${account_prefix:0:8}"

  if [[ -z "${account_prefix}" ]]; then
    account_prefix="user"
  fi

  printf 'janus-%s-%s' "${account_prefix}" "$(date +%y%m%d%H%M%S)"
}

refresh_derived_config() {
  IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${SERVICE_NAME}"
}

read_env_value() {
  local key="$1"
  local line value

  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return 0
  fi

  if [[ ! -f "${ENV_FILE}" ]]; then
    return 1
  fi

  line="$(grep -m 1 -E "^${key}=" "${ENV_FILE}" || true)"
  if [[ -z "${line}" ]]; then
    return 1
  fi

  value="${line#*=}"
  value="${value%$'\r'}"

  if [[ "${value}" =~ ^\".*\"$ ]]; then
    value="${value:1:-1}"
  elif [[ "${value}" =~ ^\'.*\'$ ]]; then
    value="${value:1:-1}"
  fi

  printf '%s' "${value}"
}

ensure_service_enabled() {
  local service="$1"
  gcloud services enable "${service}" --project="${PROJECT_ID}" >/dev/null
}

project_exists() {
  gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1
}

ensure_project() {
  if project_exists; then
    printf 'Project %s already exists.\n' "${PROJECT_ID}"
    return
  fi

  gcloud projects create "${PROJECT_ID}" \
    --name="${PROJECT_NAME}" >/dev/null
}

detect_billing_account() {
  if [[ -n "${BILLING_ACCOUNT}" ]]; then
    printf '%s' "${BILLING_ACCOUNT}"
    return 0
  fi

  local billing_name
  billing_name="$(gcloud billing accounts list \
    --filter='open=true' \
    --format='value(name)' | grep -m 1 . || true)"

  if [[ -z "${billing_name}" ]]; then
    return 1
  fi

  printf '%s' "${billing_name##*/}"
}

ensure_project_billing() {
  local current_billing_account
  local selected_billing_account

  current_billing_account="$(gcloud billing projects describe "${PROJECT_ID}" \
    --format='value(billingAccountName)' 2>/dev/null || true)"

  if [[ -n "${current_billing_account}" ]]; then
    printf 'Project %s already linked to billing account %s.\n' \
      "${PROJECT_ID}" "${current_billing_account##*/}"
    return
  fi

  selected_billing_account="$(detect_billing_account || true)"
  if [[ -z "${selected_billing_account}" ]]; then
    printf 'Error: no open billing account found. Set BILLING_ACCOUNT and rerun.\n' >&2
    exit 1
  fi

  gcloud billing projects link "${PROJECT_ID}" \
    --billing-account="${selected_billing_account}" >/dev/null
}

ensure_project_role() {
  local member="$1"
  local role="$2"

  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="${member}" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
}

ensure_artifact_repo() {
  if gcloud artifacts repositories describe "${ARTIFACT_REPO}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1; then
    printf 'Artifact Registry repo %s already exists.\n' "${ARTIFACT_REPO}"
    return
  fi

  gcloud artifacts repositories create "${ARTIFACT_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Janus container images" \
    --project="${PROJECT_ID}"
}

ensure_service_account() {
  local service_account_email="$1"

  if gcloud iam service-accounts describe "${service_account_email}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1; then
    printf 'Service account %s already exists.\n' "${service_account_email}"
    return
  fi

  gcloud iam service-accounts create "${RUNTIME_SERVICE_ACCOUNT_NAME}" \
    --display-name="${RUNTIME_SERVICE_ACCOUNT_DISPLAY_NAME}" \
    --project="${PROJECT_ID}"
}

service_account_exists() {
  local service_account_email="$1"
  gcloud iam service-accounts describe "${service_account_email}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1
}

ensure_firestore_database() {
  if gcloud firestore databases describe \
    --database="${FIRESTORE_DATABASE}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1; then
    printf 'Firestore database %s already exists.\n' "${FIRESTORE_DATABASE}"
    return
  fi

  gcloud firestore databases create \
    --database="${FIRESTORE_DATABASE}" \
    --location="${FIRESTORE_LOCATION}" \
    --type=firestore-native \
    --project="${PROJECT_ID}" \
    --quiet
}

secret_exists() {
  local secret_name="$1"
  gcloud secrets describe "${secret_name}" --project="${PROJECT_ID}" >/dev/null 2>&1
}

ensure_secret_value() {
  local secret_name="$1"
  local secret_value="$2"

  if ! secret_exists "${secret_name}"; then
    gcloud secrets create "${secret_name}" \
      --replication-policy="automatic" \
      --project="${PROJECT_ID}" >/dev/null
  fi

  printf '%s' "${secret_value}" | gcloud secrets versions add "${secret_name}" \
    --data-file=- \
    --project="${PROJECT_ID}" >/dev/null
}

api_key_exists() {
  local key_resource="$1"
  gcloud services api-keys describe "${key_resource}" \
    --project="${PROJECT_ID}" >/dev/null 2>&1
}

ensure_youtube_api_key() {
  local project_number="$1"
  local key_resource="projects/${project_number}/locations/global/keys/${YOUTUBE_API_KEY_ID}"

  if ! api_key_exists "${key_resource}"; then
    gcloud services api-keys create \
      --project="${PROJECT_ID}" \
      --display-name="${YOUTUBE_API_KEY_DISPLAY_NAME}" \
      --key-id="${YOUTUBE_API_KEY_ID}" \
      --api-target="service=youtube.googleapis.com" >/dev/null
  fi

  gcloud services api-keys get-key-string "${key_resource}" \
    --project="${PROJECT_ID}" \
    --format='value(keyString)'
}

main() {
  require_command gcloud
  require_command grep

  if [[ -z "${PROJECT_ID}" ]]; then
    PROJECT_ID="$(generate_default_project_id)"
    log "No PROJECT_ID provided; using generated project ${PROJECT_ID}"
  fi

  refresh_derived_config

  local project_number
  local runtime_service_account_email
  local cloud_build_service_account
  local compute_service_account
  local youtube_api_key_value=""
  local -a env_vars
  local -a secret_bindings
  local -a deploy_cmd

  log "Ensuring Google Cloud project exists"
  ensure_project

  log "Ensuring project billing is linked"
  ensure_project_billing

  log "Setting active gcloud project to ${PROJECT_ID}"
  gcloud config set project "${PROJECT_ID}" >/dev/null

  log "Enabling required Google Cloud APIs"
  ensure_service_enabled run.googleapis.com
  ensure_service_enabled cloudbuild.googleapis.com
  ensure_service_enabled artifactregistry.googleapis.com
  ensure_service_enabled aiplatform.googleapis.com
  ensure_service_enabled firestore.googleapis.com
  ensure_service_enabled secretmanager.googleapis.com
  ensure_service_enabled apikeys.googleapis.com
  ensure_service_enabled youtube.googleapis.com
  ensure_service_enabled cloudbilling.googleapis.com
  ensure_service_enabled cloudresourcemanager.googleapis.com
  ensure_service_enabled iam.googleapis.com

  project_number="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  runtime_service_account_email="${RUNTIME_SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  cloud_build_service_account="${project_number}@cloudbuild.gserviceaccount.com"
  compute_service_account="${project_number}-compute@developer.gserviceaccount.com"

  log "Ensuring Artifact Registry repository exists"
  ensure_artifact_repo

  log "Ensuring Firestore database exists"
  ensure_firestore_database

  log "Ensuring Cloud Run runtime service account exists"
  ensure_service_account "${runtime_service_account_email}"

  log "Granting runtime IAM roles"
  ensure_project_role "serviceAccount:${runtime_service_account_email}" "roles/aiplatform.user"
  ensure_project_role "serviceAccount:${runtime_service_account_email}" "roles/datastore.user"
  ensure_project_role "serviceAccount:${runtime_service_account_email}" "roles/secretmanager.secretAccessor"

  log "Granting build account Artifact Registry access"
  if service_account_exists "${cloud_build_service_account}"; then
    ensure_project_role "serviceAccount:${cloud_build_service_account}" "roles/artifactregistry.writer"
  else
    warn "Cloud Build service account ${cloud_build_service_account} was not found; skipping Artifact Registry writer grant."
  fi

  if service_account_exists "${compute_service_account}"; then
    ensure_project_role "serviceAccount:${compute_service_account}" "roles/artifactregistry.writer"
  else
    warn "Compute default service account ${compute_service_account} was not found; skipping Artifact Registry writer grant."
  fi

  youtube_api_key_value="$(read_env_value YOUTUBE_API_KEY || true)"

  secret_bindings=()

  if [[ -n "${youtube_api_key_value}" ]]; then
    log "Syncing YouTube API key to Secret Manager"
    ensure_secret_value "${YOUTUBE_API_KEY_SECRET_NAME}" "${youtube_api_key_value}"
    secret_bindings+=("YOUTUBE_API_KEY=${YOUTUBE_API_KEY_SECRET_NAME}:latest")
  else
    log "Creating or reusing a project YouTube API key"
    youtube_api_key_value="$(ensure_youtube_api_key "${project_number}")"
    ensure_secret_value "${YOUTUBE_API_KEY_SECRET_NAME}" "${youtube_api_key_value}"
    secret_bindings+=("YOUTUBE_API_KEY=${YOUTUBE_API_KEY_SECRET_NAME}:latest")
  fi

  env_vars=(
    "NODE_ENV=production"
    "USE_VERTEX=1"
    "GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"
    "GOOGLE_CLOUD_LOCATION=${REGION}"
  )

  log "Building container image ${IMAGE}"
  gcloud builds submit "${PROJECT_ROOT}" \
    --tag "${IMAGE}" \
    --project="${PROJECT_ID}"

  deploy_cmd=(
    gcloud run deploy "${SERVICE_NAME}"
    --image "${IMAGE}"
    --project="${PROJECT_ID}"
    --region "${REGION}"
    --platform managed
    --port 8080
    --service-account "${runtime_service_account_email}"
    --memory "${CLOUD_RUN_MEMORY}"
    --cpu "${CLOUD_RUN_CPU}"
    --timeout "${CLOUD_RUN_TIMEOUT}"
    --update-env-vars "$(csv_join "${env_vars[@]}")"
  )

  if [[ "${ALLOW_UNAUTHENTICATED}" == "true" ]]; then
    deploy_cmd+=(--allow-unauthenticated)
  else
    deploy_cmd+=(--no-allow-unauthenticated)
  fi

  if (( ${#secret_bindings[@]} > 0 )); then
    deploy_cmd+=(--update-secrets "$(csv_join "${secret_bindings[@]}")")
  fi

  log "Deploying ${SERVICE_NAME} to Cloud Run"
  "${deploy_cmd[@]}"

  log "Deployment complete"
  gcloud run services describe "${SERVICE_NAME}" \
    --platform managed \
    --region "${REGION}" \
    --format='value(status.url)' \
    --project="${PROJECT_ID}"
}

main "$@"
