import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifestPath = 'bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner-deployment.yaml';
const deployScriptPath = 'bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh';
const dockerfilePath = 'bridges/cloud-agent-runner/Dockerfile.runtime';
const canaryScriptPath = 'bridges/cloud-agent-runner/scripts/k8s-runner-canary.sh';
const liveCanaryScriptPath = 'bridges/cloud-agent-runner/scripts/k8s-runner-live-fail-closed-canary.sh';
const realProviderCanaryScriptPath = 'bridges/cloud-agent-runner/scripts/k8s-runner-real-provider-canary.sh';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

test('runner manifest keeps one sandbox-capable worker online', () => {
  const manifest = read(manifestPath);
  assert.match(manifest, /replicas:\s*1/);
  assert.match(manifest, /serviceAccountName:\s*kordi-cloud-agent-runner/);
  assert.match(manifest, /kind:\s*ServiceAccount/);
  assert.match(manifest, /kind:\s*Role/);
  assert.match(manifest, /kind:\s*RoleBinding/);
  assert.doesNotMatch(manifest, /kind:\s*ClusterRole/);
  assert.match(manifest, /name:\s*KORDI_CLOUD_RUNNER_CANARY_IDLE\s+value:\s*"0"/s);
  assert.match(manifest, /name:\s*KORDI_CLOUD_SANDBOX_BACKEND\s+value:\s*"k8s"/s);
  assert.match(manifest, /name:\s*KORDI_CLOUD_SANDBOX_NAMESPACE\s+value:\s*"kordi-cloud"/s);
});

test('runner image deploy script leaves one active runner online', () => {
  assert.ok(fs.existsSync(deployScriptPath));
  const script = read(deployScriptPath);
  assert.match(script, /KORDI_CLOUD_GCP_PROJECT/);
  assert.match(script, /buildah bud/);
  assert.match(script, /smoke-testing the image entrypoint/);
  assert.match(script, /GLIBC_\[0-9\.\]\+\.\*not found/);
  assert.match(script, /test \\"\\\$status\\" -ne 126/);
  assert.match(script, /test \\"\\\$status\\" -ne 127/);
  assert.match(script, /k3s ctr images import/);
  assert.match(script, /cloud-agent-runner-deployment\.yaml/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_IDLE=0/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_RUN_ID-/);
  assert.match(script, /kubectl[^\n]+scale[^\n]+kordi-cloud-agent-runner[^\n]+--replicas=1/);
  assert.match(script, /wait[\s\S]+condition=Ready[\s\S]+kordi-cloud-agent-runner/);
  assert.match(script, /restartCount/);
});

test('runner runtime Dockerfile builds and runs against one glibc baseline', () => {
  assert.ok(fs.existsSync(dockerfilePath));
  const dockerfile = read(dockerfilePath);
  assert.match(dockerfile, /^FROM docker\.io\/library\/rust:[^\s]+-bookworm AS builder/m);
  assert.match(dockerfile, /RUN cargo build --release -p kordi-cloud-agent-runner/);
  assert.match(dockerfile, /^FROM docker\.io\/library\/debian:bookworm-slim AS runtime/m);
  assert.match(dockerfile, /COPY --from=builder \/workspace\/target\/release\/kordi-cloud-agent-runner/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/kordi-cloud-agent-runner"\]/);
});

test('runner canary script is explicit-confirmation gated and cleans up', () => {
  assert.ok(fs.existsSync(canaryScriptPath));
  const script = read(canaryScriptPath);
  assert.match(script, /CONFIRM_KORDI_RUNNER_CANARY/);
  assert.match(script, /k8s-sandbox-smoke\.sh/);
  assert.match(script, /trap .*cleanup/);
  assert.match(script, /scale "deployment\/\$\{deployment\}" --replicas=1/);
  assert.match(script, /canary idle mode enabled/);
  assert.match(script, /scale "deployment\/\$\{deployment\}" --replicas=0/);
  assert.match(script, /waiting for runner pods to terminate/);
  assert.match(script, /No runner pods remain/);
});

test('live fail-closed canary script is gated and restores safe state', () => {
  assert.ok(fs.existsSync(liveCanaryScriptPath));
  const script = read(liveCanaryScriptPath);
  assert.match(script, /CONFIRM_KORDI_RUNNER_LIVE_CANARY/);
  assert.match(script, /active fallback runs/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_IDLE=0/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_RUN_ID/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_IDLE=1/);
  assert.match(script, /missing_provider_auth/);
  assert.match(script, /response_message_id/);
  assert.match(script, /cloud_agent_run_artifacts/);
  assert.match(script, /status = 'cancelled'/);
  assert.match(script, /scale "deployment\/\$\{deployment\}" --replicas=1/);
  assert.match(script, /scale "deployment\/\$\{deployment\}" --replicas=0/);
  assert.match(script, /No runner pods remain/);
});

test('real-provider canary script uses local auth and restores safe state', () => {
  assert.ok(fs.existsSync(realProviderCanaryScriptPath));
  const script = read(realProviderCanaryScriptPath);
  assert.match(script, /CONFIRM_KORDI_RUNNER_REAL_PROVIDER_CANARY/);
  assert.match(script, /KORDI_CLOUD_GCP_PROJECT:\?Set KORDI_CLOUD_GCP_PROJECT/);
  assert.match(script, /--project "\$gcp_project"/);
  assert.match(script, /cloud-provider-auth-snapshot-payload/);
  assert.match(script, /agent-provider-auth\/snapshots/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_RUN_ID/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_IDLE=0/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_IDLE=1/);
  assert.match(script, /status=completed/);
  assert.match(script, /response_message_id/);
  assert.match(script, /No runner pods remain/);
});

const sandboxPolicyPath = 'bridges/cloud-server/deploy/k3s/manifests/agent-sandbox-network-policy.yaml';
const sandboxJobSpecPath = 'bridges/cloud-agent-runner/src/k8s_sandbox/job_spec.rs';

test('hosted runner never enables the development-only local sandbox', () => {
  const manifest = read(manifestPath);
  assert.doesNotMatch(manifest, /KORDI_CLOUD_SANDBOX_ALLOW_LOCAL/);
  assert.doesNotMatch(manifest, /KORDI_CLOUD_ALLOW_PRIVATE_PROVIDER_ENDPOINTS/);
  assert.doesNotMatch(manifest, /name:\s*KORDI_CLOUD_SANDBOX_BACKEND\s+value:\s*"?local/s);
});

test('agent sandbox pods accept no ingress and reach only DNS and public addresses', () => {
  const policy = read(sandboxPolicyPath);
  assert.match(policy, /^kind:\s*NetworkPolicy$/m);
  assert.match(policy, /^\s+namespace:\s*kordi-cloud$/m);
  assert.match(
    policy,
    /podSelector:\n\s+matchLabels:\n\s+app\.kubernetes\.io\/component:\s*agent-sandbox\n/,
  );
  assert.match(policy, /policyTypes:\n\s+- Ingress\n\s+- Egress\n/);
  assert.match(policy, /^\s+ingress:\s*\[\]$/m);
  assert.match(policy, /kubernetes\.io\/metadata\.name:\s*kube-system[\s\S]+k8s-app:\s*kube-dns/);
  assert.match(policy, /protocol:\s*UDP\n\s+port:\s*53/);
  assert.match(policy, /protocol:\s*TCP\n\s+port:\s*53/);
  assert.match(policy, /cidr:\s*0\.0\.0\.0\/0\n\s+except:/);
  for (const cidr of [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '100.64.0.0/10',
    '169.254.0.0/16',
    '127.0.0.0/8',
  ]) {
    assert.match(policy, new RegExp(`^\\s+- ${cidr.replaceAll('.', '\\.')}$`, 'm'), cidr);
  }

  const jobSpec = read(sandboxJobSpecPath);
  assert.match(jobSpec, /SANDBOX_COMPONENT_LABEL: &str = "app\.kubernetes\.io\/component"/);
  assert.match(jobSpec, /SANDBOX_COMPONENT_VALUE: &str = "agent-sandbox"/);
});

test('operator canary runs use the only run ids a lease request may select', () => {
  for (const path of [liveCanaryScriptPath, realProviderCanaryScriptPath]) {
    assert.match(read(path), /^run_id="car_canary_[a-z_]+\$\{suffix\}"$/m, path);
  }
  const leases = read('bridges/cloud-server/src/cloud_agent_runtime/runs/leases.rs');
  assert.match(leases, /CANARY_RUN_PREFIX: &str = "car_canary_"/);
  const serverManifest = read('bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml');
  assert.doesNotMatch(serverManifest, /KORDI_CLOUD_RUNNER_CANARY_LEASES/);
});

test('local sandbox commands have an unprivileged user in the runner image', () => {
  const dockerfile = read(dockerfilePath);
  assert.match(dockerfile, /useradd --system --uid 10001 --gid 10001/);
  assert.doesNotMatch(dockerfile, /^USER /m);
  const sandbox = read('bridges/cloud-agent-runner/src/sandbox_client.rs');
  assert.match(sandbox, /DEFAULT_LOCAL_SANDBOX_ID: u32 = 10001/);
});

test('sandbox smoke check proves the egress policy with controls', () => {
  const smoke = read('bridges/cloud-agent-runner/scripts/k8s-sandbox-smoke.sh');
  assert.match(smoke, /run_job "\$control_job" "\$egress_probes" agent-sandbox-smoke-control/);
  assert.match(
    smoke,
    /expect_lines control[^\n]*\\\n[^\n]*dns=resolved service=reachable server-pod=reachable postgres-pod=reachable/,
  );
  for (const line of [
    'dns=resolved',
    'public=reachable',
    'service=blocked',
    'server-pod=blocked',
    'postgres-pod=blocked',
    'node-kubelet=blocked',
    'metadata=blocked',
  ]) {
    assert.match(smoke, new RegExp(`expect_lines sandbox[\\s\\S]*${line}`), line);
  }
});

test('runner deploy script applies the sandbox NetworkPolicy before the runner', () => {
  const script = read(deployScriptPath);
  assert.match(script, /manifests\/agent-sandbox-network-policy\.yaml/);
  const policyApply = script.indexOf('kubectl apply -f agent-sandbox-network-policy.yaml');
  const runnerApply = script.indexOf('cloud-agent-runner-deployment.yaml | kubectl apply -f -');
  assert.ok(policyApply > 0, 'policy apply step is missing');
  assert.ok(runnerApply > policyApply, 'policy must be applied before the runner');
});
