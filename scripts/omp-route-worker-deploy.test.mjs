import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const k3s = '../bridges/cloud-server/deploy/k3s/';
const read = (path) => readFile(new URL(k3s + path, import.meta.url), 'utf8');

function documents(manifest) {
  return manifest.split(/^---$/m);
}

function documentOfKind(manifest, kind) {
  const found = documents(manifest).filter((document) => new RegExp(`^kind: ${kind}$`, 'm').test(document));
  assert.equal(found.length, 1, `exactly one ${kind}`);
  return found[0];
}

test('route worker runs one hardened replica behind a cluster-internal Service', async () => {
  const manifest = await read('manifests/omp-route-worker-deployment.yaml');
  const service = documentOfKind(manifest, 'Service');
  const deployment = documentOfKind(manifest, 'Deployment');

  assert.match(service, /name: kordi-omp-route-worker\n  namespace: kordi-cloud/);
  assert.match(service, /type: ClusterIP/);
  assert.match(service, /port: 17331/);
  assert.doesNotMatch(service, /nodePort|NodePort|LoadBalancer/);

  assert.match(deployment, /name: kordi-omp-route-worker\n  namespace: kordi-cloud/);
  assert.match(deployment, /replicas: 1\n/);
  assert.match(deployment, /maxUnavailable: 0/);
  assert.match(deployment, /- name: worker\n {10}image: kordi-omp-route-worker:dev\n(?: {10}#[^\n]*\n)* {10}imagePullPolicy: IfNotPresent/);
  assert.match(deployment, /automountServiceAccountToken: false/);
  assert.match(deployment, /enableServiceLinks: false/);
  assert.match(deployment, /runAsNonRoot: true\n {8}runAsUser: 1000/);
  assert.match(deployment, /seccompProfile:\n {10}type: RuntimeDefault/);
  assert.match(deployment, /allowPrivilegeEscalation: false/);
  assert.match(deployment, /drop: \["ALL"\]/);
  assert.match(deployment, /readOnlyRootFilesystem: true/);
  assert.match(deployment, /mountPath: \/home\/bun[\s\S]*mountPath: \/tmp/);
  assert.match(deployment, /emptyDir:\n {12}sizeLimit:/);
  assert.match(deployment, /readinessProbe:\n {12}httpGet:\n {14}path: \/health/);
  assert.match(deployment, /livenessProbe:\n {12}httpGet:\n {14}path: \/health/);
  assert.match(deployment, /limits:\n {14}cpu: "[^"]+"\n {14}memory: "[^"]+"/);
  assert.match(deployment, /name: KORDI_OMP_ROUTE_WORKER_HOST\n {14}value: "0\.0\.0\.0"/);

  // The worker refuses to start without its bearer, so the reference is required.
  const token = deployment.slice(deployment.indexOf('name: KORDI_OMP_ROUTE_WORKER_TOKEN'));
  assert.match(token, /^name: KORDI_OMP_ROUTE_WORKER_TOKEN\n {14}valueFrom:\n {16}secretKeyRef:\n {18}name: kordi-omp-route-worker\n {18}key: token\n/);
  assert.doesNotMatch(token.slice(0, token.indexOf('- name: HOME')), /optional/);
});

test('only the Cloud server reaches the route worker, which reaches only DNS and public addresses', async () => {
  const policy = documentOfKind(await read('manifests/omp-route-worker-deployment.yaml'), 'NetworkPolicy');

  assert.match(policy, /podSelector:\n {4}matchLabels:\n {6}app\.kubernetes\.io\/name: kordi-omp-route-worker/);
  assert.match(policy, /policyTypes:\n {4}- Ingress\n {4}- Egress/);
  const ingress = policy.slice(policy.indexOf('ingress:'), policy.indexOf('egress:'));
  assert.equal(ingress.match(/podSelector:/g)?.length, 1);
  assert.match(ingress, /app\.kubernetes\.io\/name: kordi-cloud-server/);
  assert.doesNotMatch(ingress, /namespaceSelector|ipBlock/);
  assert.match(ingress, /port: 17331/);

  const egress = policy.slice(policy.indexOf('egress:'));
  assert.match(egress, /kubernetes\.io\/metadata\.name: kube-system[\s\S]*k8s-app: kube-dns[\s\S]*port: 53/);
  assert.match(egress, /cidr: 0\.0\.0\.0\/0/);
  for (const range of ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16']) {
    assert.ok(egress.includes(`- ${range}\n`), `egress excludes ${range}`);
  }
});

test('Cloud server reaches the worker by Service name and still starts without its Secret', async () => {
  const manifest = await read('manifests/cloud-server-deployment.yaml');

  assert.match(manifest, /name: KORDI_OMP_ROUTE_WORKER_URL\n {14}value: "http:\/\/kordi-omp-route-worker:17331"/);
  assert.match(
    manifest,
    /name: KORDI_OMP_ROUTE_WORKER_TOKEN\n {14}valueFrom:\n {16}secretKeyRef:\n {18}name: kordi-omp-route-worker\n {18}key: token\n {18}optional: true/,
  );
});

test('route worker bootstrap pins the approved digest and never prints the token', async () => {
  const script = await read('deploy-omp-route-worker.sh');

  assert.match(script, /scripts\/backend_artifact\.py" verify/);
  assert.match(script, /KORDI_BACKEND_LOCK_DIR:\?/);
  assert.match(script, /sudo flock --wait 1800 .*host-wide\.lock.* bash -s/);
  assert.match(script, /host-wide\.lock/);
  assert.match(script, /k3s ctr --namespace k8s\.io/);
  assert.match(script, /images import/);
  assert.match(script, /differs from its approved digest/);
  assert.match(script, /reference="docker\.io\/library\/kordi-omp-route-worker@\$\{digest\}"/);
  assert.match(script, /s\|image: kordi-omp-route-worker:dev\|image: \$\{reference\}\|/);
  assert.match(script, /openssl rand -hex 32 \| tr -d '\\n' \\\n\s+\| "\$\{kubectl\[@\]\}" create secret generic kordi-omp-route-worker --from-file=token=\/dev\/stdin >\/dev\/null/);
  assert.match(script, /if ! "\$\{kubectl\[@\]\}" get secret kordi-omp-route-worker/);
  assert.doesNotMatch(script, /jsonpath='\{\.data\.token\}'(?! \| grep -q \.)/);
  assert.doesNotMatch(script, /base64 (?:-d|--decode)/);
  assert.match(script, /rollout status deployment\/kordi-omp-route-worker/);
  assert.match(script, /login\.status === 401/);
  assert.match(script, /patch deployment kordi-cloud-server --type=strategic/);
  assert.match(script, /"key": "token", "optional": true/);
  assert.match(script, /rollout status deployment\/kordi-cloud-server/);
  assert.match(script, /\/v1\/cloud\/agent-provider-auth\/catalog/);
  assert.ok(
    script.indexOf('rollout status deployment/kordi-omp-route-worker') < script.indexOf('patch deployment kordi-cloud-server'),
    'the server is wired only after the worker is healthy',
  );
});
