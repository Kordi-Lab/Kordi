#!/usr/bin/env bash
#
# Bootstrap an empty Ubuntu GCE host with the packages required to build and
# run the single-node Kordi Cloud k3s stack. This script installs no secrets,
# does not change DNS, and leaves Caddy stopped until its production config is
# installed.

set -euo pipefail

SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:?Set KORDI_CLOUD_SSH_TARGET}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:?Set KORDI_CLOUD_SSH_ZONE}"
SSH_PROJECT="${KORDI_CLOUD_GCP_PROJECT:-}"

GCLOUD_SSH=(gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}")
if [ -n "${SSH_PROJECT}" ]; then
	GCLOUD_SSH+=(--project "${SSH_PROJECT}")
fi

read -r -d '' REMOTE_SCRIPT <<'REMOTE' || true
set -euo pipefail

. /etc/os-release
if [ "${ID}" != "ubuntu" ]; then
	echo "Kordi product hosts require Ubuntu; found ${ID}" >&2
	exit 1
fi
case "${VERSION_ID}" in
	24.04 | 26.04) ;;
	*)
		echo "Unsupported Ubuntu version ${VERSION_ID}; expected 24.04 or 26.04" >&2
		exit 1
		;;
esac

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
	acl \
	build-essential \
	buildah \
	caddy \
	ca-certificates \
	curl \
	file \
	fuse-overlayfs \
	git \
	jq \
	libssl-dev \
	pkg-config \
	postgresql-client \
	redis-tools \
	rsync \
	slirp4netns \
	uidmap \
	unattended-upgrades \
	unzip \
	zstd

sudo systemctl enable --now unattended-upgrades

if [ ! -x "${HOME}/.cargo/bin/rustc" ]; then
	curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
		| sh -s -- -y --profile minimal --default-toolchain stable
fi

# Caddy must not expose its package default page. The cutover procedure writes
# the reviewed Caddyfile and starts it only after the green stack is healthy.
sudo systemctl disable --now caddy

"${HOME}/.cargo/bin/rustc" --version
"${HOME}/.cargo/bin/cargo" --version
buildah --version
systemctl is-active unattended-upgrades
systemctl is-active google-cloud-ops-agent
echo bootstrap-product-host-ready
REMOTE

"${GCLOUD_SSH[@]}" --command "${REMOTE_SCRIPT}"
