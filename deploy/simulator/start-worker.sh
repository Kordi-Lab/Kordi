#!/usr/bin/env bash
set -euo pipefail

usage() {
    printf 'Usage: %s [--dry-run]\n' "$0" >&2
}

mode="apply"
if [[ $# -gt 1 ]]; then
    usage
    exit 2
fi
if [[ $# -eq 1 ]]; then
    if [[ "$1" != "--dry-run" ]]; then
        usage
        exit 2
    fi
    mode="dry-run"
fi

required_vars=(
    KUBECONFIG
    SIMULATOR_KUBE_CONTEXT
    SIMULATOR_NAMESPACE
    SIMULATOR_JOB_NAME
    SIMULATOR_IMAGE
    SIMULATOR_ACTOR_ID
    SIMULATOR_WORKER_SECRET
    SIMULATOR_ACCOUNT_SECRET
)
for name in "${required_vars[@]}"; do
    if [[ -z "${!name:-}" ]]; then
        printf 'Required environment variable is missing: %s\n' "$name" >&2
        exit 2
    fi
done

if [[ ! -f "$KUBECONFIG" || ! -r "$KUBECONFIG" ]]; then
    printf 'KUBECONFIG must name a readable regular file.\n' >&2
    exit 2
fi

template_path="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/k3s-worker.yaml"
manifest_path="$(mktemp "${TMPDIR:-/tmp}/human-simulator-worker.XXXXXX")"
trap 'rm -f -- "$manifest_path"' EXIT

python3 - "$template_path" "$manifest_path" <<'PY'
import os
import re
import sys
from string import Template

template_path, output_path = sys.argv[1:]
allowed = {
    "SIMULATOR_NAMESPACE",
    "SIMULATOR_JOB_NAME",
    "SIMULATOR_IMAGE",
    "SIMULATOR_ACTOR_ID",
    "SIMULATOR_WORKER_SECRET",
    "SIMULATOR_ACCOUNT_SECRET",
}
values = {name: os.environ[name] for name in allowed}

dns_label = re.compile(r"^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$")
for name in (
    "SIMULATOR_NAMESPACE",
    "SIMULATOR_JOB_NAME",
    "SIMULATOR_WORKER_SECRET",
    "SIMULATOR_ACCOUNT_SECRET",
):
    value = values[name]
    if len(value) > 63 or not dns_label.fullmatch(value):
        raise SystemExit(f"{name} must be a DNS-safe lowercase name of 1 to 63 characters")

actor_id = values["SIMULATOR_ACTOR_ID"]
if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", actor_id):
    raise SystemExit("SIMULATOR_ACTOR_ID must be 1 to 64 ASCII letters, digits, hyphens, or underscores")

image = values["SIMULATOR_IMAGE"]
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*", image):
    raise SystemExit("SIMULATOR_IMAGE must be a valid image-reference character sequence")

with open(template_path, encoding="utf-8") as source:
    template_text = source.read()
found = {
    match.group("named") or match.group("braced")
    for match in Template.pattern.finditer(template_text)
    if match.group("named") or match.group("braced")
}
unknown = found - allowed
if unknown:
    raise SystemExit("Template contains a placeholder outside the approved allowlist")

try:
    rendered = Template(template_text).substitute(values)
except (KeyError, ValueError):
    raise SystemExit("Template contains an unresolved or invalid placeholder")
if re.search(r"\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*", rendered):
    raise SystemExit("Rendered manifest contains an unresolved placeholder")

with open(output_path, "w", encoding="utf-8") as output:
    output.write(rendered)
PY

if [[ "$mode" == "dry-run" ]]; then
    cat -- "$manifest_path"
    exit 0
fi

kubectl --kubeconfig "$KUBECONFIG" --context "$SIMULATOR_KUBE_CONTEXT" \
    --namespace "$SIMULATOR_NAMESPACE" get namespace "$SIMULATOR_NAMESPACE" \
    >/dev/null 2>&1 || {
        printf 'Could not access the requested namespace in the selected cluster.\n' >&2
        exit 1
    }
for secret_name in "$SIMULATOR_WORKER_SECRET" "$SIMULATOR_ACCOUNT_SECRET"; do
    kubectl --kubeconfig "$KUBECONFIG" --context "$SIMULATOR_KUBE_CONTEXT" \
        --namespace "$SIMULATOR_NAMESPACE" get secret "$secret_name" \
        >/dev/null 2>&1 || {
            printf 'A referenced simulator Secret is missing or unavailable.\n' >&2
            exit 1
        }
done

kubectl --kubeconfig "$KUBECONFIG" --context "$SIMULATOR_KUBE_CONTEXT" \
    --namespace "$SIMULATOR_NAMESPACE" apply --dry-run=client -f "$manifest_path" \
    >/dev/null 2>&1 || {
        printf 'Client-side manifest validation failed.\n' >&2
        exit 1
    }
kubectl --kubeconfig "$KUBECONFIG" --context "$SIMULATOR_KUBE_CONTEXT" \
    --namespace "$SIMULATOR_NAMESPACE" apply -f "$manifest_path"
