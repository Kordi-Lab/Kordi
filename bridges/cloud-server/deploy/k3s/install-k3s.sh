#!/usr/bin/env bash
#
# install-k3s.sh — RUN ON THE VM.
#
# Bootstraps a single-node k3s cluster on an operator-provided host for the
# Kordi Cloud stack. Designed to coexist with existing services on the host:
#   - Caddy stays on 80/443; k3s gets `--disable traefik` so we don't fight.
#   - existing kordi-* deployments on the host are untouched.
#   - cluster pod CIDR uses the k3s default 10.42.0.0/16; service CIDR
#     10.43.0.0/16. Probe earlier showed nothing on either subnet.
#
# Idempotent: re-running with k3s already installed is a no-op.
#
# Usage on the operator-provided host:
#   sudo bash /path/to/kordi/bridges/cloud-server/deploy/k3s/install-k3s.sh
#
# Or from your laptop:
#   ssh <operator-host> 'sudo bash /path/to/kordi/bridges/cloud-server/deploy/k3s/install-k3s.sh'

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
	echo "install-k3s.sh must be run as root (try: sudo bash $0)" >&2
	exit 1
fi

KUBE_USER="${KORDI_KUBE_USER:?Set KORDI_KUBE_USER to the non-root operator user that should own kubeconfig}"
KUBECONFIG_TARGET="/home/${KUBE_USER}/.kube/config"

if command -v k3s >/dev/null 2>&1; then
	echo "[k3s] already installed: $(k3s --version | head -1)"
	echo "[k3s] skipping installer; ensure server is running."
else
	echo "[k3s] downloading + installing k3s server (single-node)"
	# --disable traefik:                Caddy is the public TLS terminator.
	# --disable servicelb:              we don't need klipper-lb on a single node.
	# --write-kubeconfig-mode 644:      so non-root kubectl works.
	# INSTALL_K3S_EXEC env carries the args because the installer respects it.
	export INSTALL_K3S_EXEC="server --disable traefik --disable servicelb --write-kubeconfig-mode 644"
	curl -sfL https://get.k3s.io | sh -
fi

echo "[k3s] waiting for kubeconfig at /etc/rancher/k3s/k3s.yaml"
for i in $(seq 1 30); do
	if [[ -r /etc/rancher/k3s/k3s.yaml ]]; then
		break
	fi
	sleep 1
done

# Make kubectl usable from the deploying user's shell.
install -d -m 0700 -o "${KUBE_USER}" -g "${KUBE_USER}" "/home/${KUBE_USER}/.kube"
install -m 0600 -o "${KUBE_USER}" -g "${KUBE_USER}" /etc/rancher/k3s/k3s.yaml "${KUBECONFIG_TARGET}"
echo "[k3s] kubeconfig installed at ${KUBECONFIG_TARGET}"

echo "[k3s] === node ==="
k3s kubectl get nodes -o wide

echo "[k3s] === existing namespaces ==="
k3s kubectl get namespaces

echo
echo "[k3s] OK. Next steps in this PR sequence:"
echo "  1. (Caddy) reverse-proxy kordi-cloud.<your-domain> → cluster NodePort or ClusterIP via local route."
echo "  2. apply manifests/namespace.yaml to create the kordi-cloud namespace."
echo "  3. session 3: deploy Postgres (CloudNativePG or bitnami chart)."
echo "  4. session 4: migrate kordi-cloud-server to sqlx + Postgres."
echo "  5. session 5: deploy kordi-cloud-server in cluster."
