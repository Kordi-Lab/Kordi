#!/usr/bin/env bash
#
# install.sh — RUN ON AN OPERATOR-PROVIDED HOST.
#
# Installs the kordi-cloud-server systemd unit, asks before stopping
# whatever is currently bound to port 17081, then enables + starts the new
# service. Idempotent: safe to re-run after a `sync-and-build.sh` rebuild.
#
# Usage on the host:
#   sudo KORDI_CLOUD_DEPLOY_USER=<operator-user> KORDI_CLOUD_DEPLOY_GROUP=<operator-group> \
#     bash /path/to/kordi/bridges/cloud-server/deploy/install.sh

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
	echo "install.sh must be run as root (try: sudo bash $0)" >&2
	exit 1
fi

DEPLOY_USER="${KORDI_CLOUD_DEPLOY_USER:?Set KORDI_CLOUD_DEPLOY_USER to the operator deploy user}"
DEPLOY_GROUP="${KORDI_CLOUD_DEPLOY_GROUP:?Set KORDI_CLOUD_DEPLOY_GROUP to the operator deploy group}"
if [[ ! "${DEPLOY_USER}" =~ ^[a-z_][a-z0-9_-]*\$?$ ]]; then
	echo "KORDI_CLOUD_DEPLOY_USER must be a valid local account name" >&2
	exit 1
fi
if [[ ! "${DEPLOY_GROUP}" =~ ^[a-z_][a-z0-9_-]*\$?$ ]]; then
	echo "KORDI_CLOUD_DEPLOY_GROUP must be a valid local group name" >&2
	exit 1
fi
DEPLOY_DIR="/home/${DEPLOY_USER}/kordi-cloud-server-deploy"
DATA_DIR="/home/${DEPLOY_USER}/kordi-cloud-server-data"
BINARY="${DEPLOY_DIR}/target/release/kordi-cloud-server"
UNIT_SOURCE="${DEPLOY_DIR}/bridges/cloud-server/deploy/kordi-cloud-server.service"
UNIT_DEST="/etc/systemd/system/kordi-cloud-server.service"
PORT=17081

echo "[install] deploy dir:  ${DEPLOY_DIR}"
echo "[install] data dir:    ${DATA_DIR}"
echo "[install] binary:      ${BINARY}"
echo "[install] systemd unit: ${UNIT_DEST}"
echo "[install] port:        ${PORT}"

if [[ ! -x "${BINARY}" ]]; then
	echo "[install] missing binary at ${BINARY}; run sync-and-build.sh first" >&2
	exit 1
fi
if [[ ! -f "${UNIT_SOURCE}" ]]; then
	echo "[install] missing unit template at ${UNIT_SOURCE}" >&2
	exit 1
fi

# Step 1 — make sure the data dir exists with the right owner.
install -d -m 0750 -o "${DEPLOY_USER}" -g "${DEPLOY_GROUP}" "${DATA_DIR}"

# Step 2 — see what's currently on port 17081 and ask before touching it.
echo
echo "[install] === port ${PORT} occupants ==="
PORT_ROW="$(ss -ltnp 2>/dev/null | awk -v p=":${PORT}\$" '$4 ~ p' || true)"
if [[ -n "${PORT_ROW}" ]]; then
	echo "${PORT_ROW}"
	OWNER_PID="$(echo "${PORT_ROW}" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
	if [[ -n "${OWNER_PID:-}" ]]; then
		echo "[install] owner process tree:"
		ps -o pid,ppid,user,cmd -p "${OWNER_PID}" 2>/dev/null || true
	fi

	# Detect if it's already a systemd unit we can manage cleanly.
	OWNED_UNIT="$(systemctl list-units --type=service --state=active --no-legend 2>/dev/null \
		| awk '{print $1}' \
		| while read -r u; do
			if systemctl status "$u" 2>/dev/null | grep -qE "(^|[/ ])\<:?${PORT}\>"; then
				echo "$u"
			fi
		done | head -1 || true)"
	if [[ -n "${OWNED_UNIT}" ]]; then
		echo "[install] looks like systemd unit: ${OWNED_UNIT}"
	fi

	read -r -p "[install] stop this service so the new kordi-cloud-server can take ${PORT}? [y/N] " ANSWER
	if [[ "${ANSWER:-N}" =~ ^[Yy]$ ]]; then
		if [[ -n "${OWNED_UNIT}" ]]; then
			echo "[install] systemctl stop ${OWNED_UNIT}"
			systemctl stop "${OWNED_UNIT}" || true
			systemctl disable "${OWNED_UNIT}" 2>/dev/null || true
		elif [[ -n "${OWNER_PID:-}" ]]; then
			echo "[install] kill -TERM ${OWNER_PID}"
			kill -TERM "${OWNER_PID}" || true
			sleep 2
			# Force-kill only if still running. Avoids zombies.
			if kill -0 "${OWNER_PID}" 2>/dev/null; then
				echo "[install] kill -KILL ${OWNER_PID}"
				kill -KILL "${OWNER_PID}" || true
			fi
		fi
	else
		echo "[install] not stopping. install will continue but the new service will fail to bind ${PORT}." >&2
		echo "          re-run after stopping the old service manually." >&2
		exit 2
	fi
else
	echo "[install] port ${PORT} is free."
fi

# Step 3 — render and install the systemd unit. Replace any prior copy.
echo
echo "[install] writing ${UNIT_DEST}"
UNIT_RENDERED="$(mktemp)"
trap 'rm -f "${UNIT_RENDERED}"' EXIT
sed \
	-e "s|@KORDI_CLOUD_DEPLOY_USER@|${DEPLOY_USER}|g" \
	-e "s|@KORDI_CLOUD_DEPLOY_GROUP@|${DEPLOY_GROUP}|g" \
	"${UNIT_SOURCE}" >"${UNIT_RENDERED}"
if grep -q '@KORDI_CLOUD_DEPLOY_' "${UNIT_RENDERED}"; then
	echo "[install] unresolved systemd unit template variable" >&2
	exit 1
fi
install -m 0644 "${UNIT_RENDERED}" "${UNIT_DEST}"
systemctl daemon-reload

# Step 4 — enable and start.
echo "[install] systemctl enable --now kordi-cloud-server"
systemctl enable --now kordi-cloud-server

# Step 5 — short verification.
sleep 1
echo
echo "[install] === unit status ==="
systemctl --no-pager --full status kordi-cloud-server || true
echo
echo "[install] === health check ==="
if curl -sf "http://127.0.0.1:${PORT}/health"; then
	echo
	echo "[install] OK — kordi-cloud-server is up on port ${PORT}."
else
	echo "[install] /health did not respond. Tail the journal:" >&2
	echo "          journalctl -u kordi-cloud-server -n 80 --no-pager" >&2
	exit 3
fi
