#!/usr/bin/env bash
set -euo pipefail

# Linux-generic Bridges + Nginx bootstrap.
#
# Best-effort support target:
# - Ubuntu / Debian
# - Fedora / RHEL / Rocky / AlmaLinux
# - Arch
# - openSUSE
#
# This script expects a systemd-based VM and a real DNS hostname.
# Preferred usage:
#   bash ./bridges/scripts/install-bridges-linux-generic-nginx.sh \
#     --domain bridge.example.com \
#     --email admin@example.com

BRIDGES_DOMAIN="${BRIDGES_DOMAIN:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
BRIDGES_REPO_URL="${BRIDGES_REPO_URL:-https://github.com/Kordi-AI/Kordi.git}"
BRIDGES_REPO_REF="${BRIDGES_REPO_REF:-main}"
BRIDGES_INSTALL_DIR="${BRIDGES_INSTALL_DIR:-/opt/bridges}"
BRIDGES_PORT="${BRIDGES_PORT:-17080}"
BRIDGES_BINARY_PATH="${BRIDGES_BINARY_PATH:-/usr/local/bin/bridges}"
NGINX_CONFIG_PATH="${NGINX_CONFIG_PATH:-/etc/nginx/conf.d/bridges.conf}"
ACME_WEBROOT="${ACME_WEBROOT:-/var/www/certbot}"
WORKDIR="${WORKDIR:-/tmp/bridges-bootstrap-nginx}"
DRY_RUN=0
SKIP_BUILD=0
SKIP_CERT=0
OS_PRETTY_NAME="Linux"
PACKAGE_MANAGER="unknown"
FIREWALL_HINTS=""
USED_EXISTING_CERT=0
HTTPS_READY=0

usage() {
  cat <<'EOF'
Linux-generic Bridges + Nginx bootstrap

Usage:
  install-bridges-linux-generic-nginx.sh --domain <hostname> [options]

Required:
  --domain <hostname>         Public HTTPS hostname, e.g. bridge.example.com

Optional:
  --email <email>             Email for Let's Encrypt registration (required unless --skip-cert)
  --repo-ref <ref>            Git branch or tag to build from (default: main)
  --repo-url <url>            Git repo URL (default: https://github.com/Kordi-AI/Kordi.git)
  --install-dir <path>        Install root (default: /opt/bridges)
  --port <port>               Bridges backend port behind the proxy (default: 17080)
  --skip-build                Reuse an already-installed Bridges binary instead of cloning/building
  --skip-cert                 Skip certbot provisioning; reuse existing certs if present or leave HTTP bootstrap config in place
  --dry-run                   Print planned actions without changing the machine
  --help                      Show this help

Examples:
  bash ./bridges/scripts/install-bridges-linux-generic-nginx.sh --domain bridge.example.com --email admin@example.com
  bash ./bridges/scripts/install-bridges-linux-generic-nginx.sh --domain bridge.example.com --repo-ref main --skip-build
  bash ./bridges/scripts/install-bridges-linux-generic-nginx.sh --domain bridge.example.com --skip-cert --dry-run
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
      --email)
        [[ $# -ge 2 ]] || fail "--email requires a value"
        CERTBOT_EMAIL="$2"
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
      --skip-build)
        SKIP_BUILD=1
        shift
        ;;
      --skip-cert)
        SKIP_CERT=1
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

if [[ ${SKIP_CERT} -eq 0 && -z "${CERTBOT_EMAIL}" ]]; then
  usage
  fail "Pass --email <address> unless you are using --skip-cert"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  fail "This bootstrap currently expects a systemd-based Linux VM."
fi

BRIDGES_DATA_DIR="${BRIDGES_INSTALL_DIR}/data"
BRIDGES_DB_PATH="${BRIDGES_DATA_DIR}/bridges-server.db"
CERT_PATH="/etc/letsencrypt/live/${BRIDGES_DOMAIN}/fullchain.pem"
KEY_PATH="/etc/letsencrypt/live/${BRIDGES_DOMAIN}/privkey.pem"

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
      if [[ ${SKIP_CERT} -eq 1 ]]; then
        run_root apt-get install -y ca-certificates curl git tar gzip xz-utils pkg-config build-essential libssl-dev nginx
      else
        run_root apt-get install -y ca-certificates curl git tar gzip xz-utils pkg-config build-essential libssl-dev nginx certbot
      fi
      ;;
    dnf)
      if [[ ${SKIP_CERT} -eq 1 ]]; then
        run_root dnf install -y ca-certificates curl git tar gzip xz pkgconf-pkg-config gcc gcc-c++ make openssl-devel nginx
      else
        run_root dnf install -y ca-certificates curl git tar gzip xz pkgconf-pkg-config gcc gcc-c++ make openssl-devel nginx certbot
      fi
      ;;
    yum)
      if [[ ${SKIP_CERT} -eq 1 ]]; then
        run_root yum install -y ca-certificates curl git tar gzip xz pkgconfig gcc gcc-c++ make openssl-devel nginx
      else
        run_root yum install -y ca-certificates curl git tar gzip xz pkgconfig gcc gcc-c++ make openssl-devel nginx certbot
      fi
      ;;
    pacman)
      if [[ ${SKIP_CERT} -eq 1 ]]; then
        run_root pacman -Sy --noconfirm --needed ca-certificates curl git tar gzip xz pkgconf base-devel openssl nginx
      else
        run_root pacman -Sy --noconfirm --needed ca-certificates curl git tar gzip xz pkgconf base-devel openssl nginx certbot
      fi
      ;;
    zypper)
      if [[ ${SKIP_CERT} -eq 1 ]]; then
        run_root zypper --non-interactive install ca-certificates curl git tar gzip xz pkg-config gcc gcc-c++ make libopenssl-devel nginx
      else
        run_root zypper --non-interactive install ca-certificates curl git tar gzip xz pkg-config gcc gcc-c++ make libopenssl-devel nginx certbot
      fi
      ;;
    *)
      fail "Unsupported package manager. Install curl, git, tar, a C toolchain, pkg-config, OpenSSL development headers, nginx, and optionally certbot manually."
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

write_initial_nginx_config() {
  local config_content
  config_content="server {
    listen 80;
    server_name ${BRIDGES_DOMAIN};

    location /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
    }

    location / {
        proxy_pass http://127.0.0.1:${BRIDGES_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host \$host;
    }
}"

  log "Writing initial Nginx config for ACME/bootstrap"
  run_root mkdir -p "${ACME_WEBROOT}"
  write_root_file "${NGINX_CONFIG_PATH}" "${config_content}"
  if [[ ${DRY_RUN} -eq 0 ]]; then
    run_root nginx -t
  fi
}

write_final_nginx_config() {
  local config_content
  config_content="server {
    listen 80;
    server_name ${BRIDGES_DOMAIN};

    location /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ${BRIDGES_DOMAIN};

    ssl_certificate ${CERT_PATH};
    ssl_certificate_key ${KEY_PATH};

    location / {
        proxy_pass http://127.0.0.1:${BRIDGES_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host \$host;
    }
}"

  log "Writing final HTTPS Nginx config"
  write_root_file "${NGINX_CONFIG_PATH}" "${config_content}"
  if [[ ${DRY_RUN} -eq 0 ]]; then
    run_root nginx -t
  fi
}

cert_files_exist() {
  [[ -f "${CERT_PATH}" && -f "${KEY_PATH}" ]]
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

enable_base_services() {
  log "Enabling Bridges and Nginx services"
  run_root systemctl daemon-reload
  run_root systemctl enable --now bridges
  run_root systemctl enable --now nginx
}

maybe_enable_certbot_timer() {
  if [[ ${DRY_RUN} -eq 1 ]]; then
    print_cmd systemctl enable --now certbot.timer
    return
  fi

  if systemctl list-unit-files | grep -q '^certbot\.timer'; then
    log "Enabling certbot.timer"
    run_root systemctl enable --now certbot.timer
  fi
}

obtain_certificate() {
  log "Requesting Let's Encrypt certificate for ${BRIDGES_DOMAIN}"
  if run_root certbot certonly --webroot -w "${ACME_WEBROOT}" -d "${BRIDGES_DOMAIN}" --non-interactive --agree-tos -m "${CERTBOT_EMAIL}" --keep-until-expiring; then
    HTTPS_READY=1
    return
  fi

  warn "Certbot failed. Common causes: DNS not pointing at this VM yet, ports 80/443 still blocked, or another proxy already owns the hostname."
  printf '\nFirewall hints for %s:\n%b\n' "${OS_PRETTY_NAME}" "${FIREWALL_HINTS}" >&2
  fail "Certificate provisioning failed for ${BRIDGES_DOMAIN}"
}

configure_https_if_possible() {
  if [[ ${SKIP_CERT} -eq 1 ]]; then
    if [[ ${DRY_RUN} -eq 1 ]]; then
      warn "--skip-cert set in dry-run mode. HTTPS will only be ready if cert files already exist at ${CERT_PATH} and ${KEY_PATH}."
      return
    fi

    if cert_files_exist; then
      log "Existing certificate files found; configuring HTTPS Nginx server"
      USED_EXISTING_CERT=1
      HTTPS_READY=1
      write_final_nginx_config
      run_root systemctl reload nginx
    else
      warn "--skip-cert set and no existing cert files found. Leaving Nginx on the HTTP bootstrap config. Configure certificates manually before using this as a finished Kordi host URL."
    fi
    return
  fi

  obtain_certificate
  write_final_nginx_config
  run_root systemctl reload nginx
  maybe_enable_certbot_timer
}

health_checks() {
  if [[ ${DRY_RUN} -eq 1 ]]; then
    log "Dry run enabled; skipping health checks"
    return
  fi

  log "Checking local Bridges health"
  sleep 2
  curl -fsSL "http://127.0.0.1:${BRIDGES_PORT}/health" >/dev/null

  if [[ ${HTTPS_READY} -eq 1 ]]; then
    if getent hosts "${BRIDGES_DOMAIN}" >/dev/null 2>&1; then
      log "Checking HTTPS health on ${BRIDGES_DOMAIN}"
      curl -fsSL "https://${BRIDGES_DOMAIN}/health" >/dev/null
    else
      warn "${BRIDGES_DOMAIN} does not resolve yet from this machine. External DNS may still be propagating."
    fi
  else
    warn "HTTPS was not configured by this run. Only the HTTP bootstrap config is in place right now."
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
  write_bridges_service
  write_initial_nginx_config
  build_firewall_hints
  enable_base_services
  configure_https_if_possible
  health_checks

  if [[ ${DRY_RUN} -eq 1 ]]; then
    STATUS_WORD="preview complete"
  else
    STATUS_WORD="bootstrap complete"
  fi

  cat <<EOF

Bridges + Nginx ${STATUS_WORD}.

Next checks:
  sudo systemctl status bridges
  sudo systemctl status nginx
  curl http://127.0.0.1:${BRIDGES_PORT}/health
  curl https://${BRIDGES_DOMAIN}/health
  sudo certbot renew --dry-run

Give this URL to Kordi Desktop users when HTTPS is ready:
  https://${BRIDGES_DOMAIN}

Firewall hints for ${OS_PRETTY_NAME}:
$(printf '%b' "${FIREWALL_HINTS}")
Cloud / VM firewall reminder:
  open TCP 80 and 443 publicly
  keep TCP ${BRIDGES_PORT} closed publicly unless you intentionally want to expose it
EOF

  if [[ ${SKIP_CERT} -eq 1 && ${USED_EXISTING_CERT} -eq 0 ]]; then
    warn "Because --skip-cert was used without existing cert files, this machine is still on the HTTP bootstrap config. Finish TLS setup before using it as a remote Kordi host."
  fi
}

main
