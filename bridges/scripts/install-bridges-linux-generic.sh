#!/usr/bin/env bash
set -euo pipefail

# Linux-generic Bridges + Caddy bootstrap.
#
# Best-effort support target:
# - Ubuntu / Debian
# - Fedora / RHEL / Rocky / AlmaLinux
# - Arch
# - openSUSE
#
# This script expects a systemd-based VM.
# Preferred usage:
#   bash ./bridges/scripts/install-bridges-linux-generic.sh --domain bridge.example.com
#
# Environment variables still work as fallbacks, but CLI flags are preferred.

BRIDGES_DOMAIN="${BRIDGES_DOMAIN:-}"
BRIDGES_REPO_URL="${BRIDGES_REPO_URL:-https://github.com/Kordi-AI/Kordi.git}"
BRIDGES_REPO_REF="${BRIDGES_REPO_REF:-main}"
BRIDGES_INSTALL_DIR="${BRIDGES_INSTALL_DIR:-/opt/bridges}"
BRIDGES_PORT="${BRIDGES_PORT:-17080}"
CADDY_VERSION="${CADDY_VERSION:-latest}"
BRIDGES_BINARY_PATH="${BRIDGES_BINARY_PATH:-/usr/local/bin/bridges}"
CADDY_BINARY_PATH="${CADDY_BINARY_PATH:-/usr/local/bin/caddy}"
CADDY_CONFIG_PATH="${CADDY_CONFIG_PATH:-/etc/caddy/Caddyfile}"
CADDY_LOG_DIR="${CADDY_LOG_DIR:-/var/log/caddy}"
WORKDIR="${WORKDIR:-/tmp/bridges-bootstrap}"
DRY_RUN=0
SKIP_BUILD=0
OS_PRETTY_NAME="Linux"
PACKAGE_MANAGER="unknown"
FIREWALL_HINTS=""

INSTALLER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=install-bridges-linux-common.sh
source "${INSTALLER_DIR}/install-bridges-linux-common.sh"

usage() {
  cat <<'EOF'
Linux-generic Bridges + Caddy bootstrap

Usage:
  install-bridges-linux-generic.sh --domain <hostname> [options]

Required:
  --domain <hostname>         Public or private HTTPS hostname, e.g. bridge.example.com

Optional:
  --repo-ref <ref>            Git branch or tag to build from (default: main)
  --repo-url <url>            Git repo URL (default: https://github.com/Kordi-AI/Kordi.git)
  --install-dir <path>        Install root (default: /opt/bridges)
  --port <port>               Bridges backend port behind the proxy (default: 17080)
  --caddy-version <version>   Caddy version or 'latest' (default: latest)
  --skip-build                Reuse an already-installed Bridges binary instead of cloning/building
  --dry-run                   Print planned actions without changing the machine
  --help                      Show this help

Examples:
  bash ./bridges/scripts/install-bridges-linux-generic.sh --domain bridge.example.com
  bash ./bridges/scripts/install-bridges-linux-generic.sh --domain bridge.lab.example.edu --repo-ref main
  bash ./bridges/scripts/install-bridges-linux-generic.sh --domain bridge.example.com --skip-build --dry-run
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain)
        [[ $# -ge 2 ]] || fail "--domain requires a value"
        BRIDGES_DOMAIN="$2"
        shift 2
        ;;
      --repo-ref)
        [[ $# -ge 2 ]] || fail "--repo-ref requires a value"
        BRIDGES_REPO_REF="$2"
        shift 2
        ;;
      --repo-url)
        [[ $# -ge 2 ]] || fail "--repo-url requires a value"
        BRIDGES_REPO_URL="$2"
        shift 2
        ;;
      --install-dir)
        [[ $# -ge 2 ]] || fail "--install-dir requires a value"
        BRIDGES_INSTALL_DIR="$2"
        shift 2
        ;;
      --port)
        [[ $# -ge 2 ]] || fail "--port requires a value"
        BRIDGES_PORT="$2"
        shift 2
        ;;
      --caddy-version)
        [[ $# -ge 2 ]] || fail "--caddy-version requires a value"
        CADDY_VERSION="$2"
        shift 2
        ;;
      --skip-build)
        SKIP_BUILD=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
  done
}

parse_args "$@"

if [[ -z "${BRIDGES_DOMAIN}" ]]; then
  usage
  fail "Pass --domain <hostname>"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  fail "This bootstrap currently expects a systemd-based Linux VM."
fi

initialize_bridges_installer

install_packages() {
  local pm="$1"
  install_bridges_packages \
    "${pm}" \
    "Unsupported package manager. Install curl, git, tar, a C toolchain, pkg-config, and OpenSSL development headers manually."
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    armv7l) echo armv7 ;;
    armv6l) echo armv6 ;;
    i386|i686) echo 386 ;;
    *) fail "Unsupported CPU architecture for automated Caddy install: $(uname -m)" ;;
  esac
}

fetch_latest_caddy_version() {
  local version
  version="$({ curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest || true; } | sed -n 's/.*"tag_name": "v\([^"]*\)".*/\1/p' | head -n1)"
  [[ -n "${version}" ]] || fail "Could not determine latest Caddy version from GitHub API"
  echo "${version}"
}

install_caddy_binary() {
  local arch version archive url tmpdir
  arch="$(detect_arch)"
  version="${CADDY_VERSION}"
  if [[ "${version}" == "latest" && ${DRY_RUN} -eq 0 ]]; then
    version="$(fetch_latest_caddy_version)"
  fi

  archive="caddy_${version}_linux_${arch}.tar.gz"
  url="https://github.com/caddyserver/caddy/releases/download/v${version}/${archive}"

  if [[ ${DRY_RUN} -eq 1 ]]; then
    log "Would install Caddy ${version}"
    print_cmd curl -fsSL -o "/tmp/${archive}" "${url}"
    print_cmd tar -xzf "/tmp/${archive}" -C /tmp
    print_cmd install -m 0755 /tmp/caddy "${CADDY_BINARY_PATH}"
    return
  fi

  tmpdir="$(mktemp -d)"
  log "Installing Caddy ${version}"
  curl -fsSL -o "${tmpdir}/${archive}" "${url}"
  tar -xzf "${tmpdir}/${archive}" -C "${tmpdir}"
  run_root install -m 0755 "${tmpdir}/caddy" "${CADDY_BINARY_PATH}"
  rm -rf "${tmpdir}"
}

write_caddy_config() {
  local config_content
  config_content="${BRIDGES_DOMAIN} {
  encode zstd gzip

  reverse_proxy 127.0.0.1:${BRIDGES_PORT} {
    header_up X-Forwarded-Proto {scheme}
    header_up X-Forwarded-Host {host}
    header_up X-Forwarded-For {remote_host}
  }

  log {
    output file ${CADDY_LOG_DIR}/bridge-access.log
    format console
  }
}"

  log "Writing Caddy config"
  run_root mkdir -p "${CADDY_LOG_DIR}"
  write_root_file "${CADDY_CONFIG_PATH}" "${config_content}"
  if [[ ${DRY_RUN} -eq 0 ]]; then
    run_root "${CADDY_BINARY_PATH}" validate --config "${CADDY_CONFIG_PATH}" --adapter caddyfile
  fi
}

write_caddy_service() {
  local service_content
  service_content="[Unit]
Description=Caddy web server
After=network.target bridges.service

[Service]
Type=simple
ExecStart=${CADDY_BINARY_PATH} run --config ${CADDY_CONFIG_PATH} --adapter caddyfile
ExecReload=${CADDY_BINARY_PATH} reload --config ${CADDY_CONFIG_PATH} --adapter caddyfile --force
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target"
  log "Writing Caddy systemd service"
  write_root_file /etc/systemd/system/caddy.service "${service_content}"
}

enable_services() {
  enable_bridges_and_proxy_service Caddy caddy
}

health_checks() {
  begin_bridges_health_checks
  if [[ ${BRIDGES_LOCAL_HEALTH_READY} -eq 0 ]]; then
    return 0
  fi

  if getent hosts "${BRIDGES_DOMAIN}" >/dev/null 2>&1; then
    log "Checking HTTPS health on ${BRIDGES_DOMAIN}"
    if ! curl -fsSL "https://${BRIDGES_DOMAIN}/health" >/dev/null; then
      warn "HTTPS health check did not succeed yet. DNS, certificate issuance, or firewall configuration may still be converging."
    fi
  else
    warn "${BRIDGES_DOMAIN} does not resolve yet from this machine. Configure DNS, then verify with: curl https://${BRIDGES_DOMAIN}/health"
  fi
}

main() {
  PACKAGE_MANAGER="$(detect_package_manager)"
  [[ "${PACKAGE_MANAGER}" != unknown ]] || fail "Could not detect a supported package manager"

  log "Detected OS: ${OS_PRETTY_NAME}"
  log "Detected package manager: ${PACKAGE_MANAGER}"
  [[ ${DRY_RUN} -eq 0 ]] || warn "Dry run mode enabled. No changes will be made."

  install_packages "${PACKAGE_MANAGER}"
  install_rustup_if_needed
  build_and_install_bridges
  install_caddy_binary
  write_bridges_service
  write_caddy_config
  write_caddy_service
  build_firewall_hints
  enable_services
  health_checks

  if [[ ${DRY_RUN} -eq 1 ]]; then
    STATUS_WORD="preview complete"
  else
    STATUS_WORD="bootstrap complete"
  fi

  cat <<EOF

Bridges ${STATUS_WORD}.

Next checks:
  sudo systemctl status bridges
  sudo systemctl status caddy
  curl http://127.0.0.1:${BRIDGES_PORT}/health
  curl https://${BRIDGES_DOMAIN}/health

Give this URL to Kordi Desktop users:
  https://${BRIDGES_DOMAIN}

Firewall hints for ${OS_PRETTY_NAME}:
$(printf '%b' "${FIREWALL_HINTS}")
Cloud / VM firewall reminder:
  open TCP 80 and 443 publicly
  keep TCP ${BRIDGES_PORT} closed publicly unless you intentionally want to expose it
EOF
}

main
