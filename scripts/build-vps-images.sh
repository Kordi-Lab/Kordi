#!/usr/bin/env bash
# Run on a builder with Docker; transfer archives to the chosen VPS using SSH.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
output="${1:?Pass an image output directory outside the repository}"
cd "$root"
sha="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo 'Build from a clean checkout so the image tag identifies its source.' >&2
  exit 1
fi
mkdir -p "$output"
output="$(cd "$output" && pwd)"
case "$output/" in "$root/"*) echo 'Store image archives outside the repository.' >&2; exit 1 ;; esac
for service in cloud-server cloud-agent-runner omp-route-worker; do
  dockerfile="bridges/$service/Dockerfile.runtime"
  if [ "$service" = omp-route-worker ]; then dockerfile=experiments/omp-provider-routing/Dockerfile; fi
  docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
    --label "org.opencontainers.image.revision=$sha" \
    --tag "docker.io/library/kordi-$service:$sha" \
    --output "type=oci,dest=$output/$service.oci.tar" --file "$dockerfile" .
done
python3 - "$output" "$sha" <<'PY'
import hashlib, json, pathlib, sys
root, sha = pathlib.Path(sys.argv[1]), sys.argv[2]
images = {service: f"docker.io/library/kordi-{service}:{sha}"
          for service in ("cloud-server", "cloud-agent-runner", "omp-route-worker")}
checksums = {}
for service in images:
    path = root / f"{service}.oci.tar"
    with path.open("rb") as stream:
        checksums[path.name] = hashlib.file_digest(stream, "sha256").hexdigest()
(root / "images.json").write_text(json.dumps(images, indent=2) + "\n")
(root / "SHA256SUMS").write_text("".join(f"{digest}  {name}\n" for name, digest in checksums.items()))
PY
echo 'Built Linux amd64 image archives, images.json, and SHA256SUMS.'
