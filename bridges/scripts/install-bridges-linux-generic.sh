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

log() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf '\n[warn] %s\n' "$*" >&2
}

fail() {
  printf '\n[error] %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

print_cmd() {
  printf '[dry-run] '
  printf '%q ' "$@"
  printf '\n'
}

run_logged() {
  if [[ ${DRY_RUN} -eq 1 ]]; then
    print_cmd "$@"
  else
    "$@"
  fi
}

run_root() {
  if [[ ${EUID} -eq 0 ]]; then
    run_logged "$@"
  else
    need_cmd sudo
    run_logged sudo "$@"
  fi
}

run_as_build_user() {
  local command="$1"
  if [[ ${DRY_RUN} -eq 1 ]]; then
    if [[ ${EUID} -eq 0 && "${BUILD_USER}" != "root" ]]; then
      print_cmd sudo -u "${BUILD_USER}" -H bash -lc "${command}"
    else
      print_cmd bash -lc "${command}"
    fi
    return
  fi

  if [[ ${EUID} -eq 0 && "${BUILD_USER}" != "root" ]]; then
    sudo -u "${BUILD_USER}" -H bash -lc "${command}"
  else
    bash -lc "${command}"
  fi
}

write_root_file() {
  local path="$1"
  local content="$2"

  if [[ ${DRY_RUN} -eq 1 ]]; then
    printf '[dry-run] write file %s <<EOF\n%s\nEOF\n' "${path}" "${content}"
    return
  fi

  run_root mkdir -p "$(dirname "${path}")"
  if [[ ${EUID} -eq 0 ]]; then
    printf '%s\n' "${content}" > "${path}"
  else
    printf '%s\n' "${content}" | sudo tee "${path}" >/dev/null
  fi
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

BRIDGES_DATA_DIR="${BRIDGES_INSTALL_DIR}/data"
BRIDGES_DB_PATH="${BRIDGES_DATA_DIR}/bridges-server.db"

lookup_home_dir() {
  local user="$1" passwd_line home
  passwd_line="$(getent passwd "${user}" 2>/dev/null || grep -E "^${user}:" /etc/passwd 2>/dev/null || true)"
  home="$(printf '%s' "${passwd_line}" | cut -d: -f6)"
  if [[ -z "${home}" && "${user}" == "${USER}" ]]; then
    home="${HOME}"
  fi
  printf '%s' "${home}"
}

BUILD_USER="${SUDO_USER:-${USER}}"
BUILD_HOME="$(lookup_home_dir "${BUILD_USER}")"
[[ -n "${BUILD_HOME}" ]] || fail "Could not determine home directory for build user ${BUILD_USER}"

build_user_has_cmd() {
  local cmd="$1"
  if [[ ${EUID} -eq 0 && "${BUILD_USER}" != "root" ]]; then
    sudo -u "${BUILD_USER}" -H bash -lc "command -v ${cmd} >/dev/null 2>&1"
  else
    bash -lc "command -v ${cmd} >/dev/null 2>&1"
  fi
}

load_os_release() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    OS_PRETTY_NAME="${PRETTY_NAME:-Linux}"
  fi
}

load_os_release

detect_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    echo apt
  elif command -v dnf >/dev/null 2>&1; then
    echo dnf
  elif command -v yum >/dev/null 2>&1; then
    echo yum
  elif command -v pacman >/dev/null 2>&1; then
    echo pacman
  elif command -v zypper >/dev/null 2>&1; then
    echo zypper
  else
    echo unknown
  fi
}

install_packages() {
  local pm="$1"
  case "${pm}" in
    apt)
      run_root apt-get update
      run_root apt-get install -y ca-certificates curl git tar gzip xz-utils pkg-config build-essential libssl-dev
      ;;
    dnf)
      run_root dnf install -y ca-certificates curl git tar gzip xz pkgconf-pkg-config gcc gcc-c++ make openssl-devel
      ;;
    yum)
      run_root yum install -y ca-certificates curl git tar gzip xz pkgconfig gcc gcc-c++ make openssl-devel
      ;;
    pacman)
      run_root pacman -Sy --noconfirm --needed ca-certificates curl git tar gzip xz pkgconf base-devel openssl
      ;;
    zypper)
      run_root zypper --non-interactive install ca-certificates curl git tar gzip xz pkg-config gcc gcc-c++ make libopenssl-devel
      ;;
    *)
      fail "Unsupported package manager. Install curl, git, tar, a C toolchain, pkg-config, and OpenSSL development headers manually."
      ;;
  esac
}

install_rustup_if_needed() {
  if [[ ${DRY_RUN} -eq 0 ]] && build_user_has_cmd cargo; then
    log "Rust toolchain already installed for ${BUILD_USER}"
    return
  fi

  log "Installing Rust toolchain for ${BUILD_USER}"
  run_as_build_user 'curl https://sh.rustup.rs -sSf | sh -s -- -y'
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

build_and_install_bridges() {
  run_root mkdir -p "${BRIDGES_INSTALL_DIR}" "${BRIDGES_DATA_DIR}"

  if [[ ${SKIP_BUILD} -eq 1 ]]; then
    log "Skipping Bridges build; expecting an existing binary at ${BRIDGES_BINARY_PATH}"
    if [[ ${DRY_RUN} -eq 0 && ! -x "${BRIDGES_BINARY_PATH}" ]]; then
      fail "--skip-build was set but ${BRIDGES_BINARY_PATH} does not exist or is not executable"
    fi
    return
  fi

  log "Cloning Kordi source"
  run_as_build_user "rm -rf '${WORKDIR}' && git clone --depth 1 --branch '${BRIDGES_REPO_REF}' '${BRIDGES_REPO_URL}' '${WORKDIR}'"

  log "Building Bridges"
  run_as_build_user "source '${BUILD_HOME}/.cargo/env' && cargo build --release --manifest-path '${WORKDIR}/bridges/cli/Cargo.toml'"

  run_root install -m 0755 "${WORKDIR}/target/release/bridges" "${BRIDGES_BINARY_PATH}"
}

write_bridges_service() {
  local service_content
  service_content="[Unit]
Description=Bridges coordination server
After=network.target

[Service]
Type=simple
WorkingDirectory=${BRIDGES_INSTALL_DIR}
ExecStart=${BRIDGES_BINARY_PATH} serve --port ${BRIDGES_PORT} --db ${BRIDGES_DB_PATH}
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target"
  log "Writing Bridges systemd service"
  write_root_file /etc/systemd/system/bridges.service "${service_content}"
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

build_firewall_hints() {
  local lines=""
  if command -v ufw >/dev/null 2>&1; then
    lines+="  sudo ufw allow 80/tcp\n"
    lines+="  sudo ufw allow 443/tcp\n"
  elif command -v firewall-cmd >/dev/null 2>&1; then
    lines+="  sudo firewall-cmd --permanent --add-service=http\n"
    lines+="  sudo firewall-cmd --permanent --add-service=https\n"
    lines+="  sudo firewall-cmd --reload\n"
  else
    case "${PACKAGE_MANAGER}" in
      apt)
        lines+="  sudo apt-get install -y ufw\n"
        lines+="  sudo ufw allow 80/tcp\n"
        lines+="  sudo ufw allow 443/tcp\n"
        ;;
      dnf|yum|zypper)
        lines+="  sudo systemctl enable --now firewalld\n"
        lines+="  sudo firewall-cmd --permanent --add-service=http\n"
        lines+="  sudo firewall-cmd --permanent --add-service=https\n"
        lines+="  sudo firewall-cmd --reload\n"
        ;;
      pacman)
        lines+="  sudo pacman -Sy --noconfirm ufw\n"
        lines+="  sudo systemctl enable --now ufw\n"
        lines+="  sudo ufw allow 80/tcp\n"
        lines+="  sudo ufw allow 443/tcp\n"
        ;;
      *)
        lines+="  Open TCP 80 and 443 with your distro's firewall tool.\n"
        ;;
    esac
  fi
  FIREWALL_HINTS="${lines}"
}

enable_services() {
  log "Enabling Bridges and Caddy services"
  run_root systemctl daemon-reload
  run_root systemctl enable --now bridges
  run_root systemctl enable --now caddy
}

health_checks() {
  if [[ ${DRY_RUN} -eq 1 ]]; then
    log "Dry run enabled; skipping health checks"
    return
  fi

  log "Checking local Bridges health"
  sleep 2
  curl -fsSL "http://127.0.0.1:${BRIDGES_PORT}/health" >/dev/null

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
