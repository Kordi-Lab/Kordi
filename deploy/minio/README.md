# MinIO images built from source

Kordi stores attachments and private desktop releases in MinIO. MinIO no longer
publishes its release images to a public registry, so a machine that has not
cached them cannot pull them. Kordi builds the same pinned releases from
MinIO's public source instead:

| Image | Source | Dockerfile |
| --- | --- | --- |
| `docker.io/library/kordi-minio:RELEASE.2024-12-18T13-15-44Z` | `github.com/minio/minio` at that release | `Dockerfile.server` |
| `docker.io/library/kordi-minio-mc:RELEASE.2024-11-21T17-21-54Z` | `github.com/minio/mc` at that release | `Dockerfile.client` |

The `docker.io/library/` namespace belongs to Docker's official images, so no
third party can publish an image under these names. Nothing pulls them: each
environment builds them locally.

The builds use a pinned Go toolchain and Alpine base (by version and digest).
Each Dockerfile installs MinIO's source by the Go pseudo-version of the commit
its release tag points to (`*_MODULE`), so a moved tag cannot change the
source, and the Go checksum database verifies the download. Building needs
access to the Go module proxy and the Alpine package mirror.

MinIO and mc are licensed under the GNU AGPL v3 or later. Each image carries
the upstream `LICENSE`, `NOTICE`, and `CREDITS` (dependency notices) plus the Go
license under `/usr/share/licenses/minio` or `/usr/share/licenses/mc`, and
`legal/catalog.json` records the exact source commit of each build.

## Where the images are built

- **Development stack.** `deploy/dev/compose.yaml` builds both images, so
  `pnpm debug:cloud:up` works on a fresh machine. The first build takes a few
  minutes.
- **k3s product host.** `bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh`
  copies this directory to the host, then runs `build-k3s-images.sh` there to
  build with buildah and import into k3s containerd before applying
  `minio.yaml`. The manifests use `imagePullPolicy: Never`.

  Building off the host is preferred: compiling MinIO competes with the
  running services for memory and disk. Build the archives elsewhere with
  `scripts/build-vps-images.sh`, copy `minio.oci.tar` and `minio-mc.oci.tar`
  to the host, and import them with
  `sudo k3s ctr --namespace k8s.io images import <archive>`.
  `build-k3s-images.sh` skips an image that containerd already has under its
  pinned tag. When it does build, it first requires 8 GiB of free disk and
  2 GiB of available memory (`KORDI_MINIO_BUILD_MIN_DISK_MIB`,
  `KORDI_MINIO_BUILD_MIN_MEMORY_MIB`), and it prunes its build layers and
  caches from buildah storage when it exits.
- **Self-hosted VPS.** `scripts/build-vps-images.sh` writes `minio.oci.tar` and
  `minio-mc.oci.tar` next to the application archives. `scripts/vps-deploy.py
  apply` stops before changing anything if they are not imported.

## Checks

- `scripts/minio-images.test.mjs` fails if any file references the registries
  that no longer serve MinIO, or if an image reference drifts from the pinned
  releases.
- `object-store-smoke.sh` checks bucket creation, a multipart upload, a
  presigned download, and that unsigned reads are refused, all in a temporary
  bucket. `pnpm debug:cloud:smoke` runs it in the development stack.
- `bridges/cloud-server/tests/object_store_contract.rs` sends the attachment
  routes' own presigned requests (PUT, HEAD, GET, multipart create, part,
  complete, abort) to a live endpoint. It is ignored by default:

  ```bash
  S3_ENDPOINT=http://127.0.0.1:19000 S3_BUCKET=kordi-attachments \
  S3_ACCESS_KEY=<user> S3_SECRET_KEY=<password> \
  cargo test -p kordi-cloud-server --test object_store_contract -- --ignored
  ```

  Read the development values from the ignored `deploy/dev/.env`, and never
  paste them anywhere.

## Changing a release

Update the `*_RELEASE`, `*_VERSION`, and `*_MODULE` arguments in the
Dockerfile, then every image reference listed by
`scripts/minio-images.test.mjs`. The module is the release commit's Go
pseudo-version, which `go list -m github.com/minio/minio@<release tag>` (or
`github.com/minio/mc@<release tag>`) prints.
Then run `pnpm licenses:refresh` and review the updated MinIO entries in
`legal/catalog.json`. A new server release replaces the running MinIO on the
next deploy; check MinIO's upgrade notes first.

The k3s builder skips images that are already imported under the same tag. If
a Dockerfile changes without a new release, set `KORDI_MINIO_IMAGES_REBUILD=1`
for the next deploy.
