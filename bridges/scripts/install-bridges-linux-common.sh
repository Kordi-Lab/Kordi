#!/usr/bin/env bash

# Shared lifecycle for the supported Linux Bridges installers.
# The entrypoint owns proxy/TLS policy and sets the BRIDGES_* variables before
# calling these functions.

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

lookup_home_dir() {
  local user="$1" passwd_line home
  passwd_line="$(getent passwd "${user}" 2>/dev/null || grep -E "^${user}:" /etc/passwd 2>/dev/null || true)"
  home="$(printf '%s' "${passwd_line}" | cut -d: -f6)"
  if [[ -z "${home}" && "${user}" == "${USER}" ]]; then
    home="${HOME}"
  fi
  printf '%s' "${home}"
}

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

install_bridges_packages() {
  local pm="$1"
  local unsupported_message="$2"
  shift 2

  case "${pm}" in
    apt)
      run_root apt-get update
      if [[ $# -gt 0 ]]; then
        run_root apt-get install -y ca-certificates curl git tar gzip xz-utils pkg-config build-essential libssl-dev "$@"
      else
        run_root apt-get install -y ca-certificates curl git tar gzip xz-utils pkg-config build-essential libssl-dev
      fi
      ;;
    dnf)
      if [[ $# -gt 0 ]]; then
        run_root dnf install -y ca-certificates curl git tar gzip xz pkgconf-pkg-config gcc gcc-c++ make openssl-devel "$@"
      else
        run_root dnf install -y ca-certificates curl git tar gzip xz pkgconf-pkg-config gcc gcc-c++ make openssl-devel
      fi
      ;;
    yum)
      if [[ $# -gt 0 ]]; then
        run_root yum install -y ca-certificates curl git tar gzip xz pkgconfig gcc gcc-c++ make openssl-devel "$@"
      else
        run_root yum install -y ca-certificates curl git tar gzip xz pkgconfig gcc gcc-c++ make openssl-devel
      fi
      ;;
    pacman)
      if [[ $# -gt 0 ]]; then
        run_root pacman -Sy --noconfirm --needed ca-certificates curl git tar gzip xz pkgconf base-devel openssl "$@"
      else
        run_root pacman -Sy --noconfirm --needed ca-certificates curl git tar gzip xz pkgconf base-devel openssl
      fi
      ;;
    zypper)
      if [[ $# -gt 0 ]]; then
        run_root zypper --non-interactive install ca-certificates curl git tar gzip xz pkg-config gcc gcc-c++ make libopenssl-devel "$@"
      else
        run_root zypper --non-interactive install ca-certificates curl git tar gzip xz pkg-config gcc gcc-c++ make libopenssl-devel
      fi
      ;;
    *)
      fail "${unsupported_message}"
      ;;
  esac
}

initialize_bridges_installer() {
  BRIDGES_DATA_DIR="${BRIDGES_INSTALL_DIR}/data"
  BRIDGES_DB_PATH="${BRIDGES_DATA_DIR}/bridges-server.db"
  BUILD_USER="${SUDO_USER:-${USER}}"
  BUILD_HOME="$(lookup_home_dir "${BUILD_USER}")"
  [[ -n "${BUILD_HOME}" ]] || fail "Could not determine home directory for build user ${BUILD_USER}"
  load_os_release
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

enable_bridges_and_proxy_service() {
  local proxy_label="$1"
  local proxy_service="$2"
  log "Enabling Bridges and ${proxy_label} services"
  run_root systemctl daemon-reload
  run_root systemctl enable --now bridges
  run_root systemctl enable --now "${proxy_service}"
}

begin_bridges_health_checks() {
  BRIDGES_LOCAL_HEALTH_READY=0
  if [[ ${DRY_RUN} -eq 1 ]]; then
    log "Dry run enabled; skipping health checks"
    return 0
  fi

  log "Checking local Bridges health"
  sleep 2
  curl -fsSL "http://127.0.0.1:${BRIDGES_PORT}/health" >/dev/null
  BRIDGES_LOCAL_HEALTH_READY=1
}
