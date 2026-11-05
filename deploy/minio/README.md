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

## Storage backends

The Cloud server reaches object storage through one interface with two
backends. `KORDI_OBJECT_STORAGE_BACKEND` selects it:

- `s3` (default): an S3-compatible store such as the MinIO images above,
  configured with `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, optional
  `S3_REGION`, and the release reader's `KORDI_RELEASE_S3_*` values.
- `gcs`: Google Cloud Storage through its JSON API. The server takes an OAuth
  access token for the machine's own service account from the instance
  metadata server, caches it until shortly before it expires, and never logs
  it. No service account key or HMAC key is involved, so this works where key
  creation is disabled by policy.

| Variable | Meaning |
| --- | --- |
| `KORDI_OBJECT_STORAGE_BACKEND` | `s3` (default) or `gcs`. |
| `KORDI_OBJECT_STORAGE_ATTACHMENTS_BUCKET` | Bucket for attachments, avatars, agent artifacts, and shared documents. Required for `gcs`; for `s3` it overrides `S3_BUCKET`. |
| `KORDI_OBJECT_STORAGE_RELEASES_BUCKET` | Private desktop release bucket. For `s3` it overrides `KORDI_RELEASE_S3_BUCKET`, and the default stays `kordi-releases`. For `gcs` it must be set to serve releases, because bucket names are global. |
| `KORDI_OBJECT_STORAGE_GCS_ENDPOINT` | JSON API origin. Default `https://storage.googleapis.com`. |
| `KORDI_OBJECT_STORAGE_GCS_TOKEN_URL` | Token endpoint. Default is the metadata server; tests point it at a local stand-in. |

On `gcs`, the machine's service account needs object read and write access on
both buckets and permission to read bucket metadata, which the readiness
check uses. Both buckets stay private.

Behavior is the same on both backends: every transfer goes through the
authenticated Cloud API, which enforces the per-file limits. Multipart
attachment uploads keep their resumable part contract. On `gcs` each part is
a temporary object under `multipart-uploads/`, and completion composes the
parts into the final object pinned to the generations recorded for them, then
removes the temporary objects. Two compatibility endpoints return links: the
`uploadUrl` from `POST /v1/cloud/attachments/initiate` and the `downloadUrl`
from `GET /v1/cloud/attachments/:id/download-url`. On `s3` they are presigned
URLs as before; on `gcs` they are the server's own `/upload` and `/content`
routes, so no signing key is needed.

`bridges/cloud-server/tests/gcs_object_store.rs` covers the `gcs` backend
against a local stand-in of the token endpoint and JSON API.

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
