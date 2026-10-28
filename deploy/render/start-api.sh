#!/bin/sh
# Never enable shell tracing: this process receives deployment credentials.
set -eu
: "${DATABASE_URL:?Set the private Postgres connection string}"
: "${REDIS_URL:?Set the private Key Value connection string}"
: "${KORDI_NATS_HOSTPORT:?Link the private NATS service}"
: "${KORDI_NATS_TOKEN:?Link the generated NATS token}"
: "${KORDI_OMP_HOSTPORT:?Link the private provider worker}"
: "${KORDI_OMP_ROUTE_WORKER_TOKEN:?Link the generated worker token}"
: "${KORDI_CHAT_SYNC_CURSOR_SECRET:?Set a persistent cursor secret}"
: "${KORDI_AUTH_EMAIL_CODE_SECRET:?Set a persistent email code secret}"
: "${KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY:?Set a persistent provider encryption key}"
: "${S3_ENDPOINT:?Configure an HTTPS S3 endpoint}"
: "${S3_BUCKET:?Configure a private attachment bucket}"
: "${S3_REGION:?Configure the bucket region}"
: "${S3_ACCESS_KEY:?Configure bucket-scoped access}"
: "${S3_SECRET_KEY:?Configure bucket-scoped access}"
: "${KORDI_AUTH_SMTP_HOST:?Configure signup email delivery}"
: "${KORDI_AUTH_SMTP_USERNAME:?Configure SMTP authentication}"
: "${KORDI_AUTH_SMTP_PASSWORD:?Configure SMTP authentication}"
: "${KORDI_AUTH_SMTP_FROM:?Configure the verified sender}"
case "$S3_ENDPOINT" in https://*) ;; *) echo 'S3_ENDPOINT must use HTTPS' >&2; exit 1;; esac
case "$KORDI_NATS_TOKEN" in *[!a-zA-Z0-9]*) echo 'NATS token must be alphanumeric' >&2; exit 1;; esac
if [ -n "${KORDI_AUTH_LEGACY_SIGNUP_UNTIL:-}" ]; then
  echo 'Legacy signup bypass is not supported by this deployment' >&2
  exit 1
fi
export NATS_URL="nats://$KORDI_NATS_TOKEN@$KORDI_NATS_HOSTPORT"
export KORDI_OMP_ROUTE_WORKER_URL="http://$KORDI_OMP_HOSTPORT"
export KORDI_CLOUD_PUBLIC_BASE_URL="${KORDI_CLOUD_PUBLIC_BASE_URL:-${RENDER_EXTERNAL_URL:-}}"
: "${KORDI_CLOUD_PUBLIC_BASE_URL:?Set the public HTTPS API origin}"
case "$KORDI_CLOUD_PUBLIC_BASE_URL" in https://*) ;; *) echo 'Public API origin must use HTTPS' >&2; exit 1;; esac
export KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST="${KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST:-$KORDI_CLOUD_PUBLIC_BASE_URL,http://127.0.0.1:,http://localhost:,kordi://oauth/callback}"
export KORDI_CHAT_REALTIME_ALLOWED_ORIGINS="${KORDI_CHAT_REALTIME_ALLOWED_ORIGINS:-$KORDI_CLOUD_PUBLIC_BASE_URL,tauri://localhost,http://tauri.localhost}"
export KORDI_REQUIRE_CORE_SERVICES=true
kordi-cloud-server initialize-event-stream
exec kordi-cloud-server serve --port "${PORT:-10000}"
