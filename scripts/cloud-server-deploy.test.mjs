import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptPath = new URL('../bridges/cloud-server/deploy/sync-and-build.sh', import.meta.url);
const bootstrapScriptPath = new URL('../bridges/cloud-server/deploy/k3s/bootstrap-product-host.sh', import.meta.url);
const installK3sScriptPath = new URL('../bridges/cloud-server/deploy/k3s/install-k3s.sh', import.meta.url);
const nodePortConfigPath = new URL(
  '../bridges/cloud-server/deploy/k3s/config/90-kordi-cloud-nodeport.yaml',
  import.meta.url,
);
const firewallScriptPath = new URL(
  '../bridges/cloud-server/deploy/k3s/configure-product-firewall.sh',
  import.meta.url,
);
const updaterCdnScriptPath = new URL(
  '../bridges/cloud-server/deploy/k3s/configure-updater-cdn.sh',
  import.meta.url,
);
const caddyfilePath = new URL('../bridges/cloud-server/deploy/Caddyfile.snippet', import.meta.url);
const portForwardServicePath = new URL(
  '../bridges/cloud-server/deploy/k3s/systemd/kordi-cloud-port-forward.service',
  import.meta.url,
);
const deployScriptPath = new URL('../bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh', import.meta.url);
const cloudServerDockerfilePath = new URL('../bridges/cloud-server/Dockerfile.runtime', import.meta.url);
const runnerDeployScriptPath = new URL('../bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh', import.meta.url);
const releaseCredentialsScriptPath = new URL('../bridges/cloud-server/deploy/k3s/create-release-credentials.sh', import.meta.url);
const cloudServerManifestPath = new URL('../bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml', import.meta.url);
const livekitManifestPath = new URL('../bridges/cloud-server/deploy/k3s/manifests/livekit.yaml', import.meta.url);
const legacyInstallScriptPath = new URL('../bridges/cloud-server/deploy/install.sh', import.meta.url);
const legacyServicePath = new URL('../bridges/cloud-server/deploy/kordi-cloud-server.service', import.meta.url);
const dockerignorePath = new URL('../.dockerignore', import.meta.url);

test('cloud server sync preserves remote Cargo target while deleting stale source files', async () => {
  const script = await readFile(scriptPath, 'utf8');

  assert.match(script, /rsync[\s\S]*--delete/);
  assert.match(script, /--exclude=['"]target\/['"]/);
  assert.match(script, /--exclude=['"]\.git\/['"]/);
  assert.match(script, /command -v rsync/);
  assert.match(script, /apt-get install -y rsync/);
  assert.match(script, /RSYNC_REMOTE=/);
  assert.match(script, /--rsh="\$\{RSYNC_RSH\}"/);
  assert.match(script, /"\$\{RSYNC_REMOTE\}:\$\{REMOTE_DIR\}\/"/);
  assert.match(script, /KORDI_CLOUD_GCP_PROJECT:\?Set KORDI_CLOUD_GCP_PROJECT/);
  assert.match(script, /--project "\$\{SSH_PROJECT\}"/);
  assert.doesNotMatch(script, /gcloud compute scp/);
  assert.doesNotMatch(script, /rm -rf \$\{REMOTE_DIR\}\.old|mv \$\{REMOTE_DIR\} \$\{REMOTE_DIR\}\.old/);
});

test('all remote deployment helpers require an explicit GCP project', async () => {
  const scripts = await Promise.all([
    scriptPath,
    bootstrapScriptPath,
    deployScriptPath,
    runnerDeployScriptPath,
    releaseCredentialsScriptPath,
    updaterCdnScriptPath,
  ].map((path) => readFile(path, 'utf8')));

  for (const script of scripts) {
    assert.match(script, /KORDI_CLOUD_GCP_PROJECT:\?Set KORDI_CLOUD_GCP_PROJECT/);
    assert.doesNotMatch(script, /KORDI_CLOUD_GCP_PROJECT:-/);
    assert.match(script, /--project/);
  }
});

test('legacy systemd deployment renders operator-provided account names', async () => {
  const [installScript, service] = await Promise.all([
    readFile(legacyInstallScriptPath, 'utf8'),
    readFile(legacyServicePath, 'utf8'),
  ]);

  assert.match(installScript, /KORDI_CLOUD_DEPLOY_USER:\?Set KORDI_CLOUD_DEPLOY_USER/);
  assert.match(installScript, /KORDI_CLOUD_DEPLOY_GROUP:\?Set KORDI_CLOUD_DEPLOY_GROUP/);
  assert.match(installScript, /s\|@KORDI_CLOUD_DEPLOY_USER@\|\$\{DEPLOY_USER\}\|g/);
  assert.match(installScript, /s\|@KORDI_CLOUD_DEPLOY_GROUP@\|\$\{DEPLOY_GROUP\}\|g/);
  assert.match(service, /User=@KORDI_CLOUD_DEPLOY_USER@/);
  assert.match(service, /Group=@KORDI_CLOUD_DEPLOY_GROUP@/);
  assert.doesNotMatch(service, /User=(?!@)|Group=(?!@)/);
});

test('cloud server image builds and runs against one glibc baseline', async () => {
  const [dockerfile, dockerignore, syncScript, deployScript] = await Promise.all([
    readFile(cloudServerDockerfilePath, 'utf8'),
    readFile(dockerignorePath, 'utf8'),
    readFile(scriptPath, 'utf8'),
    readFile(deployScriptPath, 'utf8'),
  ]);

  assert.match(dockerfile, /^FROM docker\.io\/library\/rust:[^\s]+-bookworm AS builder/m);
  assert.match(dockerfile, /RUN cargo build --release -p kordi-cloud-server/);
  assert.match(dockerfile, /^FROM --platform=linux\/amd64 debian:bookworm-slim AS runtime/m);
  assert.match(dockerfile, /COPY --from=builder \/workspace\/target\/release\/kordi-cloud-server/);
  assert.match(dockerfile, /COPY --from=builder \/workspace\/shared\/blob-emoji\/assets \/usr\/local\/share\/kordi\/blob-emoji/);
  assert.match(dockerfile, /KORDI_BLOB_EMOJI_DIR=\/usr\/local\/share\/kordi\/blob-emoji/);
  assert.match(dockerignore, /^target$/m);
  assert.doesNotMatch(dockerignore, /^!target/m);
  assert.match(syncScript, /cargo build --release -p kordi-cloud-server/);
  assert.match(deployScript, /smoke-testing the image entrypoint/);
  assert.match(deployScript, /GLIBC_\[0-9\.\]\+\.\*not found/);
});

test('product host bootstrap is idempotent and leaves the default proxy stopped', async () => {
  const script = await readFile(bootstrapScriptPath, 'utf8');

  assert.match(script, /VERSION_ID/);
  assert.match(script, /24\.04 \| 26\.04/);
  assert.match(script, /unattended-upgrades/);
  assert.match(script, /google-cloud-ops-agent/);
  assert.match(script, /systemctl disable --now caddy/);
  assert.match(script, /KORDI_CLOUD_GCP_PROJECT/);
  assert.doesNotMatch(script, /CLIENT_SECRET|DATABASE_URL|MINIO_ROOT_PASSWORD/);
});

test('product firewall stages the CDN origin and closes direct web ingress after cutover', async () => {
  const script = await readFile(firewallScriptPath, 'utf8');

  assert.match(script, /KORDI_CLOUD_CDN_ENABLED:-false/);
  assert.match(script, /PUBLIC_PORTS="tcp:22,tcp:80,tcp:443"/);
  assert.match(script, /PUBLIC_PORTS="tcp:22"/);
  assert.match(script, /ensure_rule "\$\{RULE_PREFIX\}-cdn-origin-ingress" 702 ALLOW[\s\S]*tcp:8080/);
  assert.match(script, /ensure_rule "\$\{RULE_PREFIX\}-media-ingress" 705 ALLOW[\s\S]*tcp:7881,udp:3478,udp:7882,udp:30000-30100/);
  assert.match(script, /ensure_rule "\$\{RULE_PREFIX\}-public-ingress" 700 ALLOW/);
  assert.match(script, /130\.211\.0\.0\/22,35\.191\.0\.0\/16/);
  assert.match(script, /ensure_rule "\$\{RULE_PREFIX\}-internal-ingress" 710 ALLOW[\s\S]*PRIVATE_SOURCE_RANGE/);
  assert.match(script, /ensure_rule "\$\{RULE_PREFIX\}-deny-other-ingress" 900 DENY[\s\S]*all 0\.0\.0\.0\/0/);
  assert.match(script, /firewall-rules update/);
  assert.match(script, /instances add-tags/);
  assert.match(script, /KORDI_CLOUD_GCP_PROJECT/);
  assert.doesNotMatch(script, /tcp:30081/);
});

test('global updater edge caches only release paths through a private VM endpoint', async () => {
  const script = await readFile(updaterCdnScriptPath, 'utf8');

  assert.match(script, /KORDI_CLOUD_GCP_PROJECT:\?Set KORDI_CLOUD_GCP_PROJECT/);
  assert.match(script, /KORDI_CLOUD_SSH_ZONE:\?Set KORDI_CLOUD_SSH_ZONE/);
  assert.match(script, /KORDI_CLOUD_SSH_TARGET:\?Set KORDI_CLOUD_SSH_TARGET/);
  assert.match(script, /managed\.state[\s\S]*ACTIVE/);
  assert.match(script, /value\(pemCertificate\)[\s\S]*BEGIN CERTIFICATE/);
  assert.match(script, /KORDI_CLOUD_CDN_WWW_CERTIFICATE:-\$\{CERTIFICATE\}/);
  assert.match(script, /GCE_VM_IP_PORT/);
  assert.match(script, /ORIGIN_PORT=8080/);
  assert.match(script, /--load-balancing-scheme=EXTERNAL_MANAGED/);
  assert.match(script, /--enable-cdn/);
  assert.match(script, /--cache-mode=USE_ORIGIN_HEADERS/);
  assert.match(script, /--compression-mode=DISABLED/);
  assert.match(script, /--no-negative-caching/);
  assert.match(script, /X-Kordi-CDN-Cache:\{cdn_cache_status\}/);
  assert.match(script, /\/updates\/releases\/\*/);
  assert.match(script, /certificate-manager maps create/);
  assert.match(script, /maps entries create[\s\S]*--hostname/);
  assert.match(script, /maps entries update[\s\S]*--certificates/);
  assert.match(script, /--certificate-map/);
  assert.doesNotMatch(script, /--certificate-manager-certificates/);
  assert.match(script, /KORDI_CLOUD_CDN_ENABLED=true/);
  assert.doesNotMatch(script, /dns record-sets|gcloud config set/i);
});

test('k3s exposes the Cloud NodePort only on loopback', async () => {
  const [installScript, nodePortConfig] = await Promise.all([
    readFile(installK3sScriptPath, 'utf8'),
    readFile(nodePortConfigPath, 'utf8'),
  ]);

  assert.match(nodePortConfig, /kube-proxy-arg\+:/);
  assert.match(nodePortConfig, /proxy-mode=iptables/);
  assert.match(nodePortConfig, /nodeport-addresses=127\.0\.0\.0\/8/);
  assert.match(installScript, /90-kordi-cloud-nodeport\.yaml/);
  assert.match(installScript, /existing installation is missing the reviewed loopback NodePort config/);
});

test('cloud server manifest targets the hosted product public base', async () => {
  const manifest = await readFile(cloudServerManifestPath, 'utf8');

  assert.match(manifest, /KORDI_CLOUD_PUBLIC_BASE_URL[\s\S]*value: "https:\/\/kordi\.ai"/);
  assert.match(
    manifest,
    /KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST[\s\S]*https:\/\/kordi\.ai,kordi:\/\/oauth\/callback/,
  );
  for (const port of [1420, 1422, 1482, 1484, 1486]) {
    assert.match(manifest, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  }
  assert.doesNotMatch(manifest, /https:\/\/korde-product-cloud\.35\.188\.85\.31\.sslip\.io/);
  assert.match(manifest, /KORDI_LIVEKIT_URL[\s\S]*name: kordi-livekit[\s\S]*key: url/);
  for (const name of [
    'KORDI_APNS_ENVIRONMENT',
    'KORDI_APNS_KEY_ID',
    'KORDI_APNS_TEAM_ID',
    'KORDI_APNS_PRIVATE_KEY_BASE64',
    'KORDI_APNS_BUNDLE_ID',
  ]) {
    assert.match(
      manifest,
      new RegExp(`${name}[\\s\\S]*name: kordi-apns[\\s\\S]*key: ${name}[\\s\\S]*optional: true`),
    );
  }
  assert.match(manifest, /KORDI_SUPPORT_OPENAI_API_KEY[\s\S]*name: kordi-support-openai/);
});

test('product media uses pinned host networking and secret-backed credentials', async () => {
  const manifest = await readFile(livekitManifestPath, 'utf8');

  assert.match(manifest, /image: livekit\/livekit-server:v1\.12\.0/);
  assert.match(manifest, /hostNetwork: true/);
  assert.match(manifest, /enableServiceLinks: false/);
  assert.match(manifest, /tcp_port: 7881/);
  assert.match(manifest, /udp_port: 7882/);
  assert.match(manifest, /udp_port: 3478/);
  assert.match(manifest, /relay_range_start: 30000/);
  assert.match(manifest, /relay_range_end: 30100/);
  assert.match(manifest, /name: kordi-livekit[\s\S]*key: keys/);
  assert.doesNotMatch(manifest, /api-secret:|api-key:/);
});

test('product origin serves desktop routes without redirects', async () => {
  const caddyfile = await readFile(caddyfilePath, 'utf8');
  const deploy = await readFile(deployScriptPath, 'utf8');
  const manifest = await readFile(cloudServerManifestPath, 'utf8');

  await assert.rejects(readFile(portForwardServicePath, 'utf8'), { code: 'ENOENT' });

  assert.match(
    caddyfile,
    /@cloud_product_routes path \/v1\/cloud\/\* \/assets\/blob-emoji\/\* \/health \/updates\/\*/,
  );
  assert.ok(
    caddyfile.indexOf('handle @cloud_product_routes') < caddyfile.lastIndexOf('handle {'),
    'product routes must be handled before any catch-all response or redirect',
  );
  assert.match(caddyfile, /handle @cloud_product_routes[\s\S]*reverse_proxy/);
  assert.match(caddyfile, /\(kordi_product_site\)/);
  assert.match(caddyfile, /:8080 \{[\s\S]*import kordi_product_site/);
  assert.match(caddyfile, /root \* \/srv\/kordi-homepage\/current/);
  assert.match(caddyfile, /handle \/beta-api\/\*[\s\S]*reverse_proxy 127\.0\.0\.1:17181/);
  assert.match(caddyfile, /kordi\.ai, www\.kordi\.ai/);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:30081/);
  assert.doesNotMatch(caddyfile, /reverse_proxy 127\.0\.0\.1:17081/);
  assert.equal(caddyfile.match(/keepalive off/g)?.length, 2);
  assert.equal(caddyfile.match(/lb_try_duration 5s/g)?.length, 2);
  assert.equal(caddyfile.match(/lb_try_interval 100ms/g)?.length, 2);
  assert.match(caddyfile, /@call_media path \/rtc \/rtc\/\*[\s\S]*reverse_proxy 127\.0\.0\.1:7880/);
  assert.doesNotMatch(caddyfile, /reverse_proxy 10\.\d+\.\d+\.\d+:17081/);
  assert.match(manifest, /nodePort: 30081/);
  assert.match(manifest, /type: NodePort/);
  assert.match(manifest, /terminationGracePeriodSeconds: 10/);
  assert.match(manifest, /livenessProbe:[\s\S]*periodSeconds: 5[\s\S]*failureThreshold: 2/);

  assert.match(deploy, /PUBLIC_ORIGIN=.*https:\/\/kordi\.ai/);
  assert.match(deploy, /verify_product_origin "\$\{PUBLIC_ORIGIN\}"/);
  assert.match(deploy, /KORDI_VERIFY_RESOLVE_IP/);
  assert.match(deploy, /--resolve "\$\{origin_host\}:443:\$\{VERIFY_RESOLVE_IP\}"/);
  assert.match(deploy, /expected direct health status 200/);
  assert.match(deploy, /expected direct login preflight status 200/);
  assert.match(deploy, /Access-Control-Request-Method: POST/);
  assert.match(deploy, /access-control-allow-origin/);
  assert.match(deploy, /expected direct updater metadata status 200/);
  assert.match(deploy, /http:\/\/127\.0\.0\.1:30081\/health/);
  assert.match(deploy, /kubectl apply -f .*manifests\/livekit\.yaml/);
  assert.match(deploy, /rollout status deployment\/livekit/);
});
