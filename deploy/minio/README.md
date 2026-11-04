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
The Go checksum database verifies the downloaded MinIO source. Building needs
access to the Go module proxy and the Alpine package mirror.

## Where the images are built

- **Development stack.** `deploy/dev/compose.yaml` builds both images, so
  `pnpm debug:cloud:up` works on a fresh machine. The first build takes a few
  minutes.
- **k3s product host.** `bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh`
  copies this directory to the host, then runs `build-k3s-images.sh` there to
  build with buildah and import into k3s containerd before applying
  `minio.yaml`. The manifests use `imagePullPolicy: Never`.
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

Update the `*_RELEASE` and `*_VERSION` arguments in the Dockerfile, then every
image reference listed by `scripts/minio-images.test.mjs`. A new server
release replaces the running MinIO on the next deploy; check MinIO's upgrade
notes first.
