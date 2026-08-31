#!/usr/bin/env bash
#
# Restrict a Kordi product VM to SSH, the CDN origin, media, and private VPC
# traffic. Direct HTTP/HTTPS remains available only until the CDN cutover.

set -euo pipefail

SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:?Set KORDI_CLOUD_SSH_TARGET}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:?Set KORDI_CLOUD_SSH_ZONE}"
GCP_PROJECT="${KORDI_CLOUD_GCP_PROJECT:?Set KORDI_CLOUD_GCP_PROJECT}"
NETWORK="${KORDI_CLOUD_GCP_NETWORK:-default}"
TARGET_TAG="${KORDI_CLOUD_GCP_FIREWALL_TAG:-kordi-product-edge}"
RULE_PREFIX="${KORDI_CLOUD_GCP_FIREWALL_PREFIX:-kordi-prod-edge}"
PRIVATE_SOURCE_RANGE="${KORDI_CLOUD_GCP_PRIVATE_SOURCE_RANGE:-10.128.0.0/9}"
CDN_ENABLED="${KORDI_CLOUD_CDN_ENABLED:-false}"
CDN_SOURCE_RANGES="130.211.0.0/22,35.191.0.0/16"

if [[ "${CDN_ENABLED}" != "true" && "${CDN_ENABLED}" != "false" ]]; then
	echo "KORDI_CLOUD_CDN_ENABLED must be true or false" >&2
	exit 1
fi

ensure_rule() {
	local name="$1"
	local priority="$2"
	local action="$3"
	local rules="$4"
	local source_ranges="$5"
	local description="$6"
	if gcloud compute firewall-rules describe "${name}" \
		--project="${GCP_PROJECT}" >/dev/null 2>&1; then
		gcloud compute firewall-rules update "${name}" \
			--project="${GCP_PROJECT}" \
			--priority="${priority}" \
			--rules="${rules}" \
			--source-ranges="${source_ranges}" \
			--target-tags="${TARGET_TAG}" \
			--description="${description}" \
			--quiet >/dev/null
	else
		gcloud compute firewall-rules create "${name}" \
			--project="${GCP_PROJECT}" \
			--network="${NETWORK}" \
			--direction=INGRESS \
			--priority="${priority}" \
			--action="${action}" \
			--rules="${rules}" \
			--source-ranges="${source_ranges}" \
			--target-tags="${TARGET_TAG}" \
			--description="${description}" \
			--quiet >/dev/null
	fi
}

PUBLIC_PORTS="tcp:22,tcp:80,tcp:443"
PUBLIC_DESCRIPTION="Kordi product edge: direct SSH, HTTP, and HTTPS during CDN staging"
if [ "${CDN_ENABLED}" = "true" ]; then
	PUBLIC_PORTS="tcp:22"
	PUBLIC_DESCRIPTION="Kordi product edge: direct SSH only after CDN cutover"
fi

ensure_rule "${RULE_PREFIX}-public-ingress" 700 ALLOW \
	"${PUBLIC_PORTS}" 0.0.0.0/0 "${PUBLIC_DESCRIPTION}"

ensure_rule "${RULE_PREFIX}-cdn-origin-ingress" 702 ALLOW \
	tcp:8080 "${CDN_SOURCE_RANGES}" \
	"Kordi private HTTP origin for the global application load balancer"

ensure_rule "${RULE_PREFIX}-media-ingress" 705 ALLOW \
	tcp:7881,udp:3478,udp:7882,udp:30000-30100 0.0.0.0/0 \
	"Kordi product media: encrypted WebRTC and TURN/UDP"

ensure_rule "${RULE_PREFIX}-internal-ingress" 710 ALLOW \
	all "${PRIVATE_SOURCE_RANGE}" \
	"Kordi product edge: preserve private VPC administration traffic"

ensure_rule "${RULE_PREFIX}-deny-other-ingress" 900 DENY \
	all 0.0.0.0/0 \
	"Kordi product edge: deny every non-approved public ingress port"

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
