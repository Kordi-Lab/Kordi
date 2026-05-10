#!/usr/bin/env bash
#
# uninstall.sh — RUN ON THE VM (or via gcloud compute ssh).
#
# Stops + disables + removes the kordi-cloud-server systemd unit.
# Leaves the deploy directory and data directory in place so a redeploy
# is just `bash install.sh`. To wipe data too, pass `--purge-data`.

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
	echo "uninstall.sh must be run as root (try: sudo bash $0)" >&2
	exit 1
fi

PURGE_DATA=false
for arg in "$@"; do
	case "${arg}" in
		--purge-data) PURGE_DATA=true ;;
		*) echo "unknown arg: ${arg}" >&2; exit 1 ;;
	esac
done

DEPLOY_USER="${KORDI_CLOUD_DEPLOY_USER:-shu_yang}"
DATA_DIR="/home/${DEPLOY_USER}/kordi-cloud-server-data"
UNIT_DEST="/etc/systemd/system/kordi-cloud-server.service"

echo "[uninstall] stopping + disabling kordi-cloud-server"
systemctl stop kordi-cloud-server 2>/dev/null || true
systemctl disable kordi-cloud-server 2>/dev/null || true
systemctl reset-failed kordi-cloud-server 2>/dev/null || true

if [[ -f "${UNIT_DEST}" ]]; then
	echo "[uninstall] removing ${UNIT_DEST}"
	rm -f "${UNIT_DEST}"
	systemctl daemon-reload
fi

if "${PURGE_DATA}"; then
	echo "[uninstall] --purge-data: removing ${DATA_DIR}"
	rm -rf "${DATA_DIR}"
else
	echo "[uninstall] keeping ${DATA_DIR} (pass --purge-data to wipe)"
fi

echo "[uninstall] done"
