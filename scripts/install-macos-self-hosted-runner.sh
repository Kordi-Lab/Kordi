#!/usr/bin/env bash

set -euo pipefail

readonly RUNNER_ACCOUNT="kordi-ci"
readonly RUNNER_GROUP="kordi-ci"
readonly RUNNER_HOME="/Users/${RUNNER_ACCOUNT}"
readonly RUNNER_DIR="${RUNNER_HOME}/actions-runner"
readonly RUNNER_LABEL="io.kordi.github-actions-runner"
readonly RUNNER_PLIST="/Library/LaunchDaemons/${RUNNER_LABEL}.plist"
readonly REPOSITORY_URL="https://github.com/Kordi-Lab/Kordi"

archive=""
expected_sha256=""
token_file=""
runner_name=""

usage() {
  cat <<'USAGE'
Usage:
  sudo bash scripts/install-macos-self-hosted-runner.sh \
    --archive /absolute/path/actions-runner-osx-arm64-VERSION.tar.gz \
    --sha256 EXPECTED_SHA256 \
    --token-file /absolute/path/registration-token

The registration token file is deleted immediately after it is read.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      archive="${2:-}"
      shift 2
      ;;
    --sha256)
      expected_sha256="${2:-}"
      shift 2
      ;;
    --token-file)
      token_file="${2:-}"
      shift 2
      ;;
    --runner-name)
      runner_name="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root (for example, with sudo)." >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This installer supports Apple Silicon macOS hosts only." >&2
  exit 1
fi

if [[ -z "$archive" || -z "$expected_sha256" || -z "$token_file" ]]; then
  usage >&2
  exit 2
fi

if [[ "$archive" != /* || ! -f "$archive" ]]; then
  echo "--archive must point to an existing absolute file path." >&2
  exit 2
fi

if [[ ! "$expected_sha256" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "--sha256 must be a 64-character hexadecimal digest." >&2
  exit 2
fi

if [[ "$token_file" != /* || ! -f "$token_file" || -L "$token_file" ]]; then
  echo "--token-file must point to an existing, non-symlink absolute file path." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_plist="${script_dir}/../deploy/ci/${RUNNER_LABEL}.plist"
if [[ ! -f "$source_plist" ]]; then
  echo "Missing LaunchDaemon template: $source_plist" >&2
  exit 1
fi

actual_sha256="$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')"
normalized_expected_sha256="$(printf '%s' "$expected_sha256" | /usr/bin/tr '[:upper:]' '[:lower:]')"
if [[ "$actual_sha256" != "$normalized_expected_sha256" ]]; then
  echo "Runner archive checksum mismatch." >&2
  exit 1
fi

registration_token="$(/usr/bin/tr -d '\r\n' < "$token_file")"
/bin/rm -f "$token_file"
trap 'registration_token=""' EXIT
if [[ -z "$registration_token" ]]; then
  echo "The registration token file was empty." >&2
  exit 1
fi

if ! /usr/bin/id "$RUNNER_ACCOUNT" >/dev/null 2>&1; then
  service_password="$(/usr/bin/openssl rand -base64 48 | /usr/bin/tr -d '\r\n')"
  /usr/sbin/sysadminctl -addUser "$RUNNER_ACCOUNT" \
    -fullName "Kordi CI Runner" \
    -home "$RUNNER_HOME" \
    -shell /bin/zsh \
    -password "$service_password"
  service_password=""
fi

if ! /usr/bin/dscl . -read "/Groups/${RUNNER_GROUP}" >/dev/null 2>&1; then
  runner_gid=500
  while /usr/bin/dscl . -search /Groups PrimaryGroupID "$runner_gid" 2>/dev/null | /usr/bin/grep -q .; do
    runner_gid=$((runner_gid + 1))
  done
  /usr/bin/dscl . -create "/Groups/${RUNNER_GROUP}"
  /usr/bin/dscl . -create "/Groups/${RUNNER_GROUP}" RealName "Kordi CI Runner"
  /usr/bin/dscl . -create "/Groups/${RUNNER_GROUP}" PrimaryGroupID "$runner_gid"
fi
runner_gid="$(/usr/bin/dscl . -read "/Groups/${RUNNER_GROUP}" PrimaryGroupID | /usr/bin/awk '{print $2}')"
/usr/bin/dscl . -create "/Users/${RUNNER_ACCOUNT}" PrimaryGroupID "$runner_gid"
/usr/sbin/dseditgroup -o edit -a "$RUNNER_ACCOUNT" -t user "$RUNNER_GROUP"
/usr/bin/dscl . -create "/Users/${RUNNER_ACCOUNT}" IsHidden 1
if /usr/sbin/dseditgroup -o checkmember -m "$RUNNER_ACCOUNT" admin | /usr/bin/grep -q '^yes'; then
  /usr/sbin/dseditgroup -o edit -d "$RUNNER_ACCOUNT" -t user admin
fi

/usr/sbin/createhomedir -c -u "$RUNNER_ACCOUNT" >/dev/null
/bin/chmod 700 "$RUNNER_HOME"
/usr/bin/install -d -o "$RUNNER_ACCOUNT" -g "$RUNNER_GROUP" -m 700 \
  "$RUNNER_HOME/Library/Logs/KordiCI" \
  "$RUNNER_HOME/Library/Caches/kordi-ci"

/bin/launchctl bootout "system/${RUNNER_LABEL}" >/dev/null 2>&1 || true
/usr/bin/pkill -u "$RUNNER_ACCOUNT" -f 'Runner.Listener' >/dev/null 2>&1 || true
/bin/rm -rf "$RUNNER_DIR"
/usr/bin/install -d -o "$RUNNER_ACCOUNT" -g "$RUNNER_GROUP" -m 700 "$RUNNER_DIR"
/usr/bin/tar -xzf "$archive" -C "$RUNNER_DIR"
/usr/sbin/chown -R "${RUNNER_ACCOUNT}:${RUNNER_GROUP}" "$RUNNER_DIR"

if [[ -z "$runner_name" ]]; then
  runner_name="$(/usr/sbin/scutil --get LocalHostName 2>/dev/null || /bin/hostname -s)-kordi-ci"
fi
runner_name="$(printf '%s' "$runner_name" | /usr/bin/tr -c 'A-Za-z0-9._-' '-')"

(
  cd "$RUNNER_DIR"
  /usr/bin/sudo -H -u "$RUNNER_ACCOUNT" /usr/bin/env \
    HOME="$RUNNER_HOME" \
    PATH="${RUNNER_HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    ./config.sh \
      --unattended \
      --replace \
      --url "$REPOSITORY_URL" \
      --token "$registration_token" \
      --name "$runner_name" \
      --labels kordi-ci \
      --work _work
)

/usr/bin/install -o "$RUNNER_ACCOUNT" -g "$RUNNER_GROUP" -m 755 \
  "$RUNNER_DIR/bin/runsvc.sh" "$RUNNER_DIR/runsvc.sh"
printf '%s\n' "$RUNNER_PLIST" > "$RUNNER_DIR/.service"
/usr/sbin/chown "${RUNNER_ACCOUNT}:${RUNNER_GROUP}" "$RUNNER_DIR/.service"
/usr/bin/dscl . -create "/Users/${RUNNER_ACCOUNT}" UserShell /usr/bin/false

/usr/bin/install -o root -g wheel -m 644 "$source_plist" "$RUNNER_PLIST"
/usr/bin/plutil -lint "$RUNNER_PLIST"
/bin/launchctl bootstrap system "$RUNNER_PLIST"
/bin/launchctl enable "system/${RUNNER_LABEL}"
/bin/launchctl kickstart -k "system/${RUNNER_LABEL}"

echo "Installed ${runner_name} as isolated account ${RUNNER_ACCOUNT}."
