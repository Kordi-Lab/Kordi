#!/bin/sh
# Object-store smoke check for the behavior the Kordi server relies on:
# bucket creation, multipart upload, presigned downloads, and private buckets.
# Runs inside the kordi-minio-mc image (or anywhere with mc and curl). It works
# only in a temporary bucket and removes that bucket when it finishes.
#
#   S3_ENDPOINT        S3 API origin, for example http://minio:9000
#   S3_ACCESS_KEY      access key; defaults to MINIO_ROOT_USER
#   S3_SECRET_KEY      secret key; defaults to MINIO_ROOT_PASSWORD
#   REQUIRED_BUCKETS   space-separated buckets that must already exist
#                      (default: kordi-attachments)
set -eu

endpoint="${S3_ENDPOINT:?Set S3_ENDPOINT}"
access_key="${S3_ACCESS_KEY:-${MINIO_ROOT_USER:?Set S3_ACCESS_KEY}}"
secret_key="${S3_SECRET_KEY:-${MINIO_ROOT_PASSWORD:?Set S3_SECRET_KEY}}"
required_buckets="${REQUIRED_BUCKETS-kordi-attachments}"

fail() { echo "[object-store-smoke] $*" >&2; exit 1; }

work="$(mktemp -d)"
export MC_CONFIG_DIR="${work}/mc"
bucket="kordi-smoke-$(date +%s)-$$"
cleanup() {
  mc --quiet rb --force "smoke/${bucket}" >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT INT TERM

mc --quiet alias set smoke "${endpoint}" "${access_key}" "${secret_key}" >/dev/null

for required in ${required_buckets}; do
  mc --quiet stat "smoke/${required}" >/dev/null 2>&1 || fail "required bucket ${required} is missing"
done

mc --quiet mb "smoke/${bucket}" >/dev/null || fail "bucket creation failed"

# 24 MiB is above the client's 16 MiB part size, so mc uploads in parts.
dd if=/dev/urandom of="${work}/object" bs=1048576 count=24 2>/dev/null
mc --quiet cp "${work}/object" "smoke/${bucket}/object" >/dev/null || fail "multipart upload failed"
etag="$(mc --quiet stat --json "smoke/${bucket}/object" | sed -n 's/.*"etag":"\([^"]*\)".*/\1/p')"
case "${etag}" in
  *-[0-9]*) ;;
  *) fail "expected a multipart ETag, got '${etag}'" ;;
esac

share="$(mc --quiet --no-color share download --expire 5m "smoke/${bucket}/object" | sed -n 's/^Share: //p')"
[ -n "${share}" ] || fail "presigned download URL was not issued"
curl --fail --silent --show-error --max-time 60 --output "${work}/download" "${share}" \
  || fail "presigned download failed"
cmp -s "${work}/object" "${work}/download" || fail "presigned download returned different bytes"

anonymous="$(curl --silent --max-time 20 --output /dev/null --write-out '%{http_code}' "${endpoint%/}/${bucket}/object")"
[ "${anonymous}" = 403 ] || fail "unsigned read returned ${anonymous}; buckets must stay private"

echo "[object-store-smoke] bucket creation, multipart upload, presigned download, and private access passed"
