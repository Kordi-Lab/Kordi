#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sha="${1:?Pass the tested full revision}"
output="${2:?Pass the output directory}"
run_id="${3:?Pass the workflow run ID}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
[ "$(git rev-parse HEAD)" = "$sha" ] || { echo 'Source revision mismatch' >&2; exit 1; }
mkdir -p "$output"
for service in cloud-server cloud-agent-runner; do
  docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
    --label "org.opencontainers.image.revision=$sha" \
    --tag "docker.io/library/kordi-$service:$sha" \
    --cache-from "type=gha,scope=backend-$service" \
    --cache-to "type=gha,scope=backend-$service,mode=max" \
    --output "type=docker,dest=$output/$service.docker.tar" \
    --output "type=oci,dest=$output/$service.oci.tar" \
    --file "bridges/$service/Dockerfile.runtime" .
done
python3 "$root/scripts/backend_artifact.py" create --directory "$output" --sha "$sha" --run-id "$run_id"
