import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifestPath = 'bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner-deployment.yaml';
const deployScriptPath = 'bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh';
const dockerfilePath = 'bridges/cloud-agent-runner/Dockerfile.runtime';
const canaryScriptPath = 'bridges/cloud-agent-runner/scripts/k8s-runner-canary.sh';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

test('runner manifest is canary-only and namespace-scoped', () => {
  const manifest = read(manifestPath);
  assert.match(manifest, /replicas:\s*0/);
  assert.match(manifest, /serviceAccountName:\s*kordi-cloud-agent-runner/);
  assert.match(manifest, /kind:\s*ServiceAccount/);
  assert.match(manifest, /kind:\s*Role/);
  assert.match(manifest, /kind:\s*RoleBinding/);
  assert.doesNotMatch(manifest, /kind:\s*ClusterRole/);
  assert.match(manifest, /name:\s*KORDI_CLOUD_RUNNER_CANARY_IDLE\s+value:\s*"1"/s);
  assert.match(manifest, /name:\s*KORDI_CLOUD_SANDBOX_BACKEND\s+value:\s*"k8s"/s);
  assert.match(manifest, /name:\s*KORDI_CLOUD_SANDBOX_NAMESPACE\s+value:\s*"kordi-cloud"/s);
});

test('runner image deploy script keeps deployment scaled to zero', () => {
  assert.ok(fs.existsSync(deployScriptPath));
  const script = read(deployScriptPath);
  assert.match(script, /cargo build --release -p kordi-cloud-agent-runner/);
  assert.match(script, /buildah bud/);
  assert.match(script, /k3s ctr images import/);
  assert.match(script, /cloud-agent-runner-deployment\.yaml/);
  assert.match(script, /kubectl[^\n]+scale[^\n]+kordi-cloud-agent-runner[^\n]+--replicas=0/);
});

test('runner runtime Dockerfile copies runner binary', () => {
  assert.ok(fs.existsSync(dockerfilePath));
  const dockerfile = read(dockerfilePath);
  assert.match(dockerfile, /target\/release\/kordi-cloud-agent-runner/);
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
