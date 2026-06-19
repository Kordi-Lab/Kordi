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
FROM rust:1.88-slim-bookworm AS builder

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

RUN cargo build --release -p kordi-cloud-server \
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

COPY --from=builder /workspace/target/release/kordi-cloud-server /usr/local/bin/kordi-cloud-server

USER kordi
WORKDIR /var/lib/kordi-cloud

EXPOSE 17081

# tini reaps zombies and forwards SIGTERM cleanly so kubelet rolling-updates
# don't leave orphaned children.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kordi-cloud-server"]
CMD ["serve", "--port", "17081", "--db", "/var/lib/kordi-cloud/kordi-cloud.db"]
