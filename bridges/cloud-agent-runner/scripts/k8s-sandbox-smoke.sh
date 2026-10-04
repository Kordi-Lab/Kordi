#!/usr/bin/env bash
set -euo pipefail

namespace="${KORDI_CLOUD_SANDBOX_NAMESPACE:-kordi-cloud}"
sandbox_id="${KORDI_CLOUD_SANDBOX_ID:-cas-smoke-$(date +%s)}"
image="${KORDI_CLOUD_SANDBOX_IMAGE:-alpine:3.20}"
storage="${KORDI_CLOUD_SANDBOX_STORAGE_REQUEST:-512Mi}"
cpu_request="${KORDI_CLOUD_SANDBOX_CPU_REQUEST:-100m}"
cpu_limit="${KORDI_CLOUD_SANDBOX_CPU_LIMIT:-1}"
memory_request="${KORDI_CLOUD_SANDBOX_MEMORY_REQUEST:-128Mi}"
memory_limit="${KORDI_CLOUD_SANDBOX_MEMORY_LIMIT:-1Gi}"
keep="${KEEP_KORDI_SANDBOX_SMOKE:-0}"
# Must be reachable from a sandbox pod. Use a public address outside this
# deployment.
public_url="${KORDI_SANDBOX_SMOKE_PUBLIC_URL:-https://example.com/}"

safe_name() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-48
}

safe_id="$(safe_name "$sandbox_id")"
if [[ -z "$safe_id" ]]; then
  safe_id="sandbox"
fi
pvc="kordi-cloud-sandbox-${safe_id}"
write_job="kordi-sandbox-smoke-write-${safe_id}"
read_job="kordi-sandbox-smoke-read-${safe_id}"
bash_job="kordi-sandbox-smoke-bash-${safe_id}"
egress_job="kordi-sandbox-smoke-egress-${safe_id}"
control_job="kordi-sandbox-smoke-control-${safe_id}"
expected="hello from k8s sandbox"

cleanup() {
  kubectl -n "$namespace" delete job "$write_job" "$read_job" "$bash_job" "$egress_job" "$control_job" --ignore-not-found=true >/dev/null 2>&1 || true
  if [[ "$keep" != "1" ]]; then
    kubectl -n "$namespace" delete pvc "$pvc" --ignore-not-found=true >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

apply_pvc() {
  kubectl -n "$namespace" apply -f - <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${pvc}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: kordi-cloud-sandbox-workspace
    kordi.ai/sandbox-id: ${sandbox_id}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: ${storage}
YAML
}

run_job() {
  local job="$1"
  local command="$2"
  # Sandbox pods carry the component label that the NetworkPolicy selects;
  # the egress control pod carries another one.
  local component="${3:-agent-sandbox}"
  local indented_command
  indented_command="$(printf '%s\n' "$command" | sed 's/^/              /')"
  kubectl -n "$namespace" delete job "$job" --ignore-not-found=true >/dev/null 2>&1 || true
  kubectl -n "$namespace" apply -f - <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: ${job}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: kordi-cloud-sandbox-executor
    app.kubernetes.io/component: ${component}
    kordi.ai/sandbox-id: ${sandbox_id}
spec:
  ttlSecondsAfterFinished: 300
  backoffLimit: 0
  template:
    metadata:
      labels:
        app.kubernetes.io/name: kordi-cloud-sandbox-executor
        app.kubernetes.io/component: ${component}
        kordi.ai/sandbox-id: ${sandbox_id}
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
        - name: sandbox-op
          image: ${image}
          workingDir: /workspace
          command: ["/bin/sh", "-lc"]
          args:
            - |
${indented_command}
          securityContext:
            allowPrivilegeEscalation: false
            privileged: false
            runAsNonRoot: true
            readOnlyRootFilesystem: false
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: "${cpu_request}"
              memory: "${memory_request}"
            limits:
              cpu: "${cpu_limit}"
              memory: "${memory_limit}"
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      volumes:
        - name: workspace
          persistentVolumeClaim:
            claimName: ${pvc}
YAML
  kubectl -n "$namespace" wait --for=condition=complete "job/${job}" --timeout=90s >/dev/null
}

assert_restricted_job() {
  local job="$1"
  local json
  json="$(kubectl -n "$namespace" get job "$job" -o json)"
  if grep -q 'hostPath' <<<"$json"; then
    echo "[smoke] job $job unexpectedly contains hostPath" >&2
    exit 1
  fi
  if ! grep -Eq '"automountServiceAccountToken":[[:space:]]*false' <<<"$json"; then
    echo "[smoke] job $job is missing automountServiceAccountToken=false" >&2
    exit 1
  fi
  if ! grep -Eq '"privileged":[[:space:]]*false' <<<"$json"; then
    echo "[smoke] job $job is missing privileged=false" >&2
    exit 1
  fi
  if ! grep -Eq '"memory":[[:space:]]*"'"${memory_limit}"'"' <<<"$json"; then
    echo "[smoke] job $job is missing its memory limit" >&2
    exit 1
  fi
}

echo "[smoke] namespace=$namespace sandbox_id=$sandbox_id pvc=$pvc image=$image"
apply_pvc >/dev/null
kubectl -n "$namespace" get "pvc/${pvc}" >/dev/null

run_job "$write_job" "mkdir -p smoke && printf '$expected' > smoke/hello.txt"
assert_restricted_job "$write_job"

run_job "$read_job" "cat smoke/hello.txt"
assert_restricted_job "$read_job"
read_output="$(kubectl -n "$namespace" logs "job/${read_job}")"
if [[ "$read_output" != "$expected" ]]; then
  echo "[smoke] unexpected read output: '$read_output'" >&2
  exit 1
fi

run_job "$bash_job" "[ \"\$(cat smoke/hello.txt)\" = '$expected' ] && printf bash-ok"
assert_restricted_job "$bash_job"
bash_output="$(kubectl -n "$namespace" logs "job/${bash_job}")"
if [[ "$bash_output" != "bash-ok" ]]; then
  echo "[smoke] unexpected bash output: '$bash_output'" >&2
  exit 1
fi

if ! kubectl -n "$namespace" get networkpolicy kordi-cloud-agent-sandbox >/dev/null 2>&1; then
  echo "[smoke] agent sandbox NetworkPolicy kordi-cloud-agent-sandbox is missing" >&2
  exit 1
fi

first_ip() {
  kubectl -n "$namespace" get pods -l "$1" --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || true
}

service_host="kordi-cloud-server.${namespace}.svc.cluster.local"
server_ip="$(first_ip app.kubernetes.io/name=kordi-cloud-server)"
postgres_ip="$(first_ip app.kubernetes.io/name=postgres)"
node_ip="$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)"
for value in server_ip postgres_ip node_ip; do
  if [[ -z "${!value}" ]]; then
    echo "[smoke] could not find the ${value%_ip} address to probe" >&2
    exit 1
  fi
done

# Each probe prints name=reachable, name=blocked, or name=unresolved. Any
# reply, including an HTTP error or a dropped non-HTTP connection, means the
# destination was reachable; only a refused or timed-out connection counts as
# blocked. The control pod shows that every internal destination is reachable
# when the policy does not apply, so a blocked result is the policy's doing.
egress_probes="probe() {
  out=\$(timeout 8 wget -q -T 5 -O /dev/null \"\$2\" 2>&1); rc=\$?
  if [ \$rc -eq 0 ]; then state=reachable
  elif printf '%s' \"\$out\" | grep -q 'bad address'; then state=unresolved
  elif [ -z \"\$out\" ] || printf '%s' \"\$out\" | grep -Eqi \"can't connect|timed out|refused|unreachable|no route\"; then state=blocked
  else state=reachable
  fi
  echo \"\$1=\$state\"
}
if nslookup ${service_host} >/dev/null 2>&1; then echo dns=resolved; else echo dns=unresolved; fi
probe service http://${service_host}:17081/health
probe server-pod http://${server_ip}:17081/health
probe postgres-pod http://${postgres_ip}:5432/
probe node-kubelet http://${node_ip}:10250/
probe metadata http://169.254.169.254/
probe public ${public_url}"

expect_lines() {
  local label="$1"
  local output="$2"
  shift 2
  local line
  for line in "$@"; do
    if ! grep -qx "$line" <<<"$output"; then
      echo "[smoke] ${label} egress expected '${line}', got:" >&2
      printf '%s\n' "$output" >&2
      exit 1
    fi
  done
}

run_job "$control_job" "$egress_probes" agent-sandbox-smoke-control
control_output="$(kubectl -n "$namespace" logs "job/${control_job}")"
expect_lines control "$control_output" \
  dns=resolved service=reachable server-pod=reachable postgres-pod=reachable \
  node-kubelet=reachable public=reachable

run_job "$egress_job" "$egress_probes"
assert_restricted_job "$egress_job"
egress_output="$(kubectl -n "$namespace" logs "job/${egress_job}")"
expect_lines sandbox "$egress_output" \
  dns=resolved public=reachable service=blocked server-pod=blocked \
  postgres-pod=blocked node-kubelet=blocked metadata=blocked

echo "[smoke] ok"
