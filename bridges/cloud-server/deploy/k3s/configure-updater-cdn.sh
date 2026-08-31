#!/usr/bin/env bash
#
# Create the global application load balancer and Cloud CDN path for immutable
# desktop release assets. This stages infrastructure only: it does not change
# DNS or close the direct origin firewall path.

set -euo pipefail

PROJECT="${KORDI_CLOUD_GCP_PROJECT:?Set KORDI_CLOUD_GCP_PROJECT}"
ZONE="${KORDI_CLOUD_SSH_ZONE:?Set KORDI_CLOUD_SSH_ZONE}"
INSTANCE="${KORDI_CLOUD_SSH_TARGET:?Set KORDI_CLOUD_SSH_TARGET}"
CERTIFICATE="${KORDI_CLOUD_CDN_CERTIFICATE:?Set KORDI_CLOUD_CDN_CERTIFICATE to an ACTIVE global Certificate Manager certificate}"
NETWORK="${KORDI_CLOUD_GCP_NETWORK:-default}"
PREFIX="${KORDI_CLOUD_CDN_PREFIX:-kordi-product}"
ORIGIN_PORT=8080

if [[ ! "${PREFIX}" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]]; then
	echo "KORDI_CLOUD_CDN_PREFIX must be a valid GCP resource-name prefix" >&2
	exit 1
fi
if [[ ! "${INSTANCE}" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]]; then
	echo "KORDI_CLOUD_SSH_TARGET must be a bare GCE instance name" >&2
	exit 1
fi

NEG="${PREFIX}-origin"
HEALTH_CHECK="${PREFIX}-origin-health"
CORE_BACKEND="${PREFIX}-core"
RELEASE_BACKEND="${PREFIX}-release-cdn"
HTTPS_URL_MAP="${PREFIX}-https"
HTTP_URL_MAP="${PREFIX}-http-redirect"
HTTPS_PROXY="${PREFIX}-https-proxy"
HTTP_PROXY="${PREFIX}-http-proxy"
ADDRESS="${PREFIX}-edge-ip"
HTTPS_FORWARDING_RULE="${PREFIX}-https"
HTTP_FORWARDING_RULE="${PREFIX}-http"

CERTIFICATE_STATE="$(gcloud certificate-manager certificates describe "${CERTIFICATE}" \
	--location=global \
	--project="${PROJECT}" \
	--format='value(managed.state)')"
if [ -n "${CERTIFICATE_STATE}" ]; then
	if [ "${CERTIFICATE_STATE}" != "ACTIVE" ]; then
		echo "The managed Certificate Manager certificate must be ACTIVE before CDN staging" >&2
		exit 1
	fi
elif ! gcloud certificate-manager certificates describe "${CERTIFICATE}" \
	--location=global \
	--project="${PROJECT}" \
	--format='value(pemCertificate)' \
	| grep -q 'BEGIN CERTIFICATE'; then
	echo "KORDI_CLOUD_CDN_CERTIFICATE must identify a usable global certificate" >&2
	exit 1
fi

if ! gcloud compute network-endpoint-groups describe "${NEG}" \
	--zone="${ZONE}" \
	--project="${PROJECT}" >/dev/null 2>&1; then
	gcloud compute network-endpoint-groups create "${NEG}" \
		--network-endpoint-type=GCE_VM_IP_PORT \
		--default-port="${ORIGIN_PORT}" \
		--network="${NETWORK}" \
		--zone="${ZONE}" \
		--project="${PROJECT}" \
		--quiet >/dev/null
fi

if ! gcloud compute network-endpoint-groups list-network-endpoints "${NEG}" \
	--zone="${ZONE}" \
	--project="${PROJECT}" \
	--format='csv[no-heading](instance,port)' \
	| grep -Eq "/instances/${INSTANCE},${ORIGIN_PORT}$"; then
	gcloud compute network-endpoint-groups update "${NEG}" \
		--zone="${ZONE}" \
		--project="${PROJECT}" \
		--add-endpoint="instance=${INSTANCE},port=${ORIGIN_PORT}" \
		--quiet >/dev/null
fi

if gcloud compute health-checks describe "${HEALTH_CHECK}" \
	--project="${PROJECT}" >/dev/null 2>&1; then
	gcloud compute health-checks update http "${HEALTH_CHECK}" \
		--use-serving-port \
		--request-path=/health \
		--check-interval=10s \
		--timeout=5s \
		--healthy-threshold=2 \
		--unhealthy-threshold=2 \
		--project="${PROJECT}" \
		--quiet >/dev/null
else
	gcloud compute health-checks create http "${HEALTH_CHECK}" \
		--use-serving-port \
		--request-path=/health \
		--check-interval=10s \
		--timeout=5s \
		--healthy-threshold=2 \
		--unhealthy-threshold=2 \
		--project="${PROJECT}" \
		--quiet >/dev/null
fi

ensure_backend() {
	local name="$1"
	shift
	if gcloud compute backend-services describe "${name}" \
		--global \
		--project="${PROJECT}" >/dev/null 2>&1; then
		gcloud compute backend-services update "${name}" \
			--load-balancing-scheme=EXTERNAL_MANAGED \
			--protocol=HTTP \
			--health-checks="${HEALTH_CHECK}" \
			--global \
			--project="${PROJECT}" \
			"$@" \
			--quiet >/dev/null
	else
		gcloud compute backend-services create "${name}" \
			--load-balancing-scheme=EXTERNAL_MANAGED \
			--protocol=HTTP \
			--health-checks="${HEALTH_CHECK}" \
			--global \
			--project="${PROJECT}" \
			"$@" \
			--quiet >/dev/null
	fi
}

ensure_backend "${CORE_BACKEND}" \
	--no-enable-cdn \
	--timeout=86400s
ensure_backend "${RELEASE_BACKEND}" \
	--enable-cdn \
	--cache-mode=USE_ORIGIN_HEADERS \
	--no-cache-key-include-query-string \
	--compression-mode=DISABLED \
	--no-negative-caching \
	--request-coalescing \
	--timeout=300s \
	--custom-response-header='X-Kordi-CDN-Cache:{cdn_cache_status}'

NEG_URL="$(gcloud compute network-endpoint-groups describe "${NEG}" \
	--zone="${ZONE}" \
	--project="${PROJECT}" \
	--format='value(selfLink)')"
for backend in "${CORE_BACKEND}" "${RELEASE_BACKEND}"; do
	if ! gcloud compute backend-services describe "${backend}" \
		--global \
		--project="${PROJECT}" \
		--format='value(backends[].group)' \
		| tr ';' '\n' \
		| grep -Fxq "${NEG_URL}"; then
		gcloud compute backend-services add-backend "${backend}" \
			--network-endpoint-group="${NEG}" \
			--network-endpoint-group-zone="${ZONE}" \
			--balancing-mode=RATE \
			--max-rate-per-endpoint=1000 \
			--global \
			--project="${PROJECT}" \
			--quiet >/dev/null
	fi
done

CORE_BACKEND_URL="https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/backendServices/${CORE_BACKEND}"
RELEASE_BACKEND_URL="https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/backendServices/${RELEASE_BACKEND}"
HTTPS_MAP_CONFIG="$(mktemp)"
HTTP_MAP_CONFIG="$(mktemp)"
trap 'rm -f "${HTTPS_MAP_CONFIG}" "${HTTP_MAP_CONFIG}"' EXIT

cat >"${HTTPS_MAP_CONFIG}" <<YAML
kind: compute#urlMap
name: ${HTTPS_URL_MAP}
defaultService: ${CORE_BACKEND_URL}
hostRules:
- hosts:
  - kordi.ai
  - www.kordi.ai
  pathMatcher: product
pathMatchers:
- name: product
  defaultService: ${CORE_BACKEND_URL}
  pathRules:
  - paths:
    - /updates/releases/*
    service: ${RELEASE_BACKEND_URL}
YAML
gcloud compute url-maps import "${HTTPS_URL_MAP}" \
	--source="${HTTPS_MAP_CONFIG}" \
	--global \
	--project="${PROJECT}" \
	--quiet >/dev/null

cat >"${HTTP_MAP_CONFIG}" <<YAML
kind: compute#urlMap
name: ${HTTP_URL_MAP}
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: PERMANENT_REDIRECT
YAML
gcloud compute url-maps import "${HTTP_URL_MAP}" \
	--source="${HTTP_MAP_CONFIG}" \
	--global \
	--project="${PROJECT}" \
	--quiet >/dev/null

if gcloud compute target-https-proxies describe "${HTTPS_PROXY}" \
	--global \
	--project="${PROJECT}" >/dev/null 2>&1; then
	gcloud compute target-https-proxies update "${HTTPS_PROXY}" \
		--url-map="${HTTPS_URL_MAP}" \
		--certificate-manager-certificates="${CERTIFICATE}" \
		--global \
		--project="${PROJECT}" \
		--quiet >/dev/null
else
	gcloud compute target-https-proxies create "${HTTPS_PROXY}" \
		--url-map="${HTTPS_URL_MAP}" \
		--certificate-manager-certificates="${CERTIFICATE}" \
		--global \
		--project="${PROJECT}" \
		--quiet >/dev/null
fi

if gcloud compute target-http-proxies describe "${HTTP_PROXY}" \
	--global \
	--project="${PROJECT}" >/dev/null 2>&1; then
	gcloud compute target-http-proxies update "${HTTP_PROXY}" \
		--url-map="${HTTP_URL_MAP}" \
		--global \
		--project="${PROJECT}" \
		--quiet >/dev/null
else
	gcloud compute target-http-proxies create "${HTTP_PROXY}" \
		--url-map="${HTTP_URL_MAP}" \
		--global \
		--project="${PROJECT}" \
		--quiet >/dev/null
fi

if ! gcloud compute addresses describe "${ADDRESS}" \
	--global \
	--project="${PROJECT}" >/dev/null 2>&1; then
	gcloud compute addresses create "${ADDRESS}" \
		--ip-version=IPV4 \
		--network-tier=PREMIUM \
		--global \
		--project="${PROJECT}" \
		--quiet >/dev/null
fi

ensure_forwarding_rule() {
	local name="$1"
	local port="$2"
	local proxy_flag="$3"
	local proxy="$4"
	if gcloud compute forwarding-rules describe "${name}" \
		--global \
		--project="${PROJECT}" >/dev/null 2>&1; then
		local current_target
		current_target="$(gcloud compute forwarding-rules describe "${name}" \
			--global \
			--project="${PROJECT}" \
			--format='value(target.basename())')"
		if [ "${current_target}" != "${proxy}" ]; then
			echo "Forwarding rule ${name} already targets ${current_target}; refusing to replace it" >&2
			exit 1
		fi
		return
	fi
	gcloud compute forwarding-rules create "${name}" \
		--load-balancing-scheme=EXTERNAL_MANAGED \
		--network-tier=PREMIUM \
		--address="${ADDRESS}" \
		--global \
		"${proxy_flag}=${proxy}" \
		--ports="${port}" \
		--project="${PROJECT}" \
		--quiet >/dev/null
}

ensure_forwarding_rule "${HTTPS_FORWARDING_RULE}" 443 --target-https-proxy "${HTTPS_PROXY}"
ensure_forwarding_rule "${HTTP_FORWARDING_RULE}" 80 --target-http-proxy "${HTTP_PROXY}"

EDGE_IP="$(gcloud compute addresses describe "${ADDRESS}" \
	--global \
	--project="${PROJECT}" \
	--format='value(address)')"

echo "[cdn] staged edge IP ${EDGE_IP}"
echo "[cdn] verify Caddy port ${ORIGIN_PORT}, backend health, and the complete product route matrix before DNS cutover"
echo "[cdn] after DNS and CDN verification, rerun configure-product-firewall.sh with KORDI_CLOUD_CDN_ENABLED=true"
