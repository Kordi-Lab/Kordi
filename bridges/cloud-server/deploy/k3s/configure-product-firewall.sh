#!/usr/bin/env bash
#
# Restrict a public Kordi product VM to SSH, HTTP, HTTPS, and private VPC
# traffic. This overrides broad legacy rules on a shared GCP network without
# changing those rules for unrelated instances.

set -euo pipefail

SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:?Set KORDI_CLOUD_SSH_TARGET}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:?Set KORDI_CLOUD_SSH_ZONE}"
GCP_PROJECT="${KORDI_CLOUD_GCP_PROJECT:?Set KORDI_CLOUD_GCP_PROJECT}"
NETWORK="${KORDI_CLOUD_GCP_NETWORK:-default}"
TARGET_TAG="${KORDI_CLOUD_GCP_FIREWALL_TAG:-kordi-product-edge}"
RULE_PREFIX="${KORDI_CLOUD_GCP_FIREWALL_PREFIX:-kordi-prod-edge}"
PRIVATE_SOURCE_RANGE="${KORDI_CLOUD_GCP_PRIVATE_SOURCE_RANGE:-10.128.0.0/9}"

ensure_rule() {
	local name="$1"
	shift
	if ! gcloud compute firewall-rules describe "${name}" \
		--project="${GCP_PROJECT}" >/dev/null 2>&1; then
		gcloud compute firewall-rules create "${name}" \
			--project="${GCP_PROJECT}" \
			"$@" \
			--quiet >/dev/null
	fi
}

ensure_rule "${RULE_PREFIX}-public-ingress" \
	--network="${NETWORK}" \
	--direction=INGRESS \
	--priority=700 \
	--action=ALLOW \
	--rules=tcp:22,tcp:80,tcp:443 \
	--source-ranges=0.0.0.0/0 \
	--target-tags="${TARGET_TAG}" \
	--description="Kordi product edge: public SSH and HTTPS entry points only"

ensure_rule "${RULE_PREFIX}-internal-ingress" \
	--network="${NETWORK}" \
	--direction=INGRESS \
	--priority=710 \
	--action=ALLOW \
	--rules=all \
	--source-ranges="${PRIVATE_SOURCE_RANGE}" \
	--target-tags="${TARGET_TAG}" \
	--description="Kordi product edge: preserve private VPC administration traffic"

ensure_rule "${RULE_PREFIX}-deny-other-ingress" \
	--network="${NETWORK}" \
	--direction=INGRESS \
	--priority=900 \
	--action=DENY \
	--rules=all \
	--source-ranges=0.0.0.0/0 \
	--target-tags="${TARGET_TAG}" \
	--description="Kordi product edge: deny every non-approved public ingress port"

gcloud compute instances add-tags "${SSH_TARGET}" \
	--zone="${SSH_ZONE}" \
	--project="${GCP_PROJECT}" \
	--tags="${TARGET_TAG}" \
	--quiet >/dev/null

gcloud compute ssh "${SSH_TARGET}" \
	--zone="${SSH_ZONE}" \
	--project="${GCP_PROJECT}" \
	--quiet \
	--command="echo kordi-product-firewall-ready"
