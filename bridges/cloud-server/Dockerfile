# Multi-stage build for kordi-cloud-server.
#
# Stage 1 builds the release binary against the workspace; stage 2 is a slim
# runtime image with only the binary, certs, and a non-root user. The build
# expects the full repo as build context so the workspace deps resolve.
#
#   docker build -t kordi-cloud-server:dev -f bridges/cloud-server/Dockerfile .
#
# This image initially talks to a SQLite file mounted at
# /var/lib/kordi-cloud/kordi-cloud.db. Once the sqlx + Postgres migration
# lands (session 4 of the k3s rollout), the same image is reused with
# DATABASE_URL pointing at the in-cluster Postgres service.

# ---------- builder ----------
# Keep this at or above the highest rust-version in Cargo.lock;
# scripts/ci/check-docker-rust-toolchains.mjs enforces it in CI.
FROM docker.io/library/rust:1.97-slim-bookworm AS builder

# rusqlite uses the bundled SQLite, which still needs a C toolchain at link time.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        pkg-config \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY agent ./agent
COPY app ./app
COPY bridges ./bridges
COPY shared ./shared
COPY simulations ./simulations

# The development Compose stack passes KORDI_DEVELOPMENT_BUILD=1 to compile in
# development-only options such as plaintext SMTP to a local mail catcher.
# Hosted release images leave it empty, so those options stay refused.
ARG KORDI_DEVELOPMENT_BUILD=
RUN KORDI_DEVELOPMENT_BUILD="$KORDI_DEVELOPMENT_BUILD" cargo build --release -p kordi-cloud-server \
    && strip target/release/kordi-cloud-server

# ---------- runtime ----------
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1000 kordi \
    && useradd --system --uid 1000 --gid kordi --home /var/lib/kordi-cloud --shell /usr/sbin/nologin kordi \
    && install -d -o kordi -g kordi /var/lib/kordi-cloud

COPY legal/distribution /usr/local/share/kordi/licenses
COPY --from=builder /workspace/target/release/kordi-cloud-server /usr/local/bin/kordi-cloud-server
COPY --from=builder /workspace/shared/blob-emoji/assets /usr/local/share/kordi/blob-emoji

ENV KORDI_BLOB_EMOJI_DIR=/usr/local/share/kordi/blob-emoji

USER kordi
WORKDIR /var/lib/kordi-cloud

EXPOSE 17081

# tini reaps zombies and forwards SIGTERM cleanly so kubelet rolling-updates
# don't leave orphaned children.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kordi-cloud-server"]
CMD ["serve", "--port", "17081", "--db", "/var/lib/kordi-cloud/kordi-cloud.db"]
