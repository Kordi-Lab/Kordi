#!/usr/bin/env bash
# Exercise the real exporters with tiny synthetic images; never use live service data.
set -euo pipefail
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
printf 'synthetic backend exporter fixture\n' > "$fixture/fixture.txt"
printf 'FROM scratch\nCOPY fixture.txt /fixture.txt\n' > "$fixture/Dockerfile"
sha="${GITHUB_SHA:?Run this fixture in CI}"
run_id="${GITHUB_RUN_ID:?Run this fixture in CI}"
for service in cloud-server cloud-agent-runner; do
  docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
    --label "org.opencontainers.image.revision=$sha" \
    --tag "docker.io/library/kordi-$service:$sha" \
    --output "type=docker,dest=$fixture/$service.docker.tar" \
    --output "type=oci,dest=$fixture/$service.oci.tar" "$fixture"
done
python3 scripts/backend_artifact.py create --directory "$fixture" --sha "$sha" --run-id "$run_id"
python3 scripts/backend_artifact.py verify --directory "$fixture" --sha "$sha" --run-id "$run_id"
