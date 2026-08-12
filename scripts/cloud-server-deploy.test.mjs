import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptPath = new URL('../bridges/cloud-server/deploy/sync-and-build.sh', import.meta.url);
const bootstrapScriptPath = new URL('../bridges/cloud-server/deploy/k3s/bootstrap-product-host.sh', import.meta.url);
const firewallScriptPath = new URL(
  '../bridges/cloud-server/deploy/k3s/configure-product-firewall.sh',
  import.meta.url,
);
const caddyfilePath = new URL('../bridges/cloud-server/deploy/Caddyfile.snippet', import.meta.url);
const portForwardServicePath = new URL(
  '../bridges/cloud-server/deploy/k3s/systemd/kordi-cloud-port-forward.service',
  import.meta.url,
);
const deployScriptPath = new URL('../bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh', import.meta.url);
const runnerDeployScriptPath = new URL('../bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh', import.meta.url);
const releaseCredentialsScriptPath = new URL('../bridges/cloud-server/deploy/k3s/create-release-credentials.sh', import.meta.url);
const cloudServerManifestPath = new URL('../bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml', import.meta.url);
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
  ].map((path) => readFile(path, 'utf8')));

  for (const script of scripts) {
    assert.match(script, /KORDI_CLOUD_GCP_PROJECT:\?Set KORDI_CLOUD_GCP_PROJECT/);
    assert.doesNotMatch(script, /KORDI_CLOUD_GCP_PROJECT:-/);
    assert.match(script, /--project/);
  }
});

test('cloud server image context includes the prebuilt release binary', async () => {
  const dockerignore = await readFile(dockerignorePath, 'utf8');

  assert.match(dockerignore, /^!target\/$/m);
  assert.match(dockerignore, /^!target\/release\/$/m);
  assert.match(dockerignore, /^!target\/release\/kordi-cloud-server$/m);
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

test('product firewall overrides broad shared-network ingress rules', async () => {
  const script = await readFile(firewallScriptPath, 'utf8');

  assert.match(script, /--rules=tcp:22,tcp:80,tcp:443/);
  assert.match(script, /--source-ranges=0\.0\.0\.0\/0/);
  assert.match(script, /--source-ranges="\$\{PRIVATE_SOURCE_RANGE\}"/);
  assert.match(script, /--priority=900[\s\S]*--action=DENY[\s\S]*--rules=all/);
  assert.match(script, /instances add-tags/);
  assert.match(script, /KORDI_CLOUD_GCP_PROJECT/);
  assert.doesNotMatch(script, /35\.\d+\.\d+\.\d+/);
});

test('cloud server manifest targets the hosted product public base', async () => {
  const manifest = await readFile(cloudServerManifestPath, 'utf8');

  assert.match(manifest, /KORDI_CLOUD_PUBLIC_BASE_URL[\s\S]*value: "https:\/\/kordi\.ai"/);
  assert.match(
    manifest,
    /KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST[\s\S]*https:\/\/kordi\.ai,https:\/\/coordinar\.io/,
  );
  for (const port of [1420, 1422, 1482, 1484, 1486]) {
    assert.match(manifest, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  }
  assert.doesNotMatch(manifest, /https:\/\/korde-product-cloud\.35\.188\.85\.31\.sslip\.io/);
});

test('product origin serves desktop compatibility routes without redirects', async () => {
  const caddyfile = await readFile(caddyfilePath, 'utf8');
  const portForwardService = await readFile(portForwardServicePath, 'utf8');
  const deploy = await readFile(deployScriptPath, 'utf8');

  assert.match(
    caddyfile,
    /@cloud_product_routes path \/v1\/cloud\/\* \/health \/updates\/\*/,
  );
  assert.ok(
    caddyfile.indexOf('handle @cloud_product_routes') < caddyfile.lastIndexOf('handle {'),
    'product routes must be handled before any catch-all response or redirect',
  );
  assert.match(caddyfile, /handle @cloud_product_routes[\s\S]*reverse_proxy/);
  assert.match(caddyfile, /root \* \/srv\/kordi-homepage\/current/);
  assert.match(caddyfile, /handle \/beta-api\/\*[\s\S]*reverse_proxy 127\.0\.0\.1:17181/);
  assert.match(caddyfile, /kordi\.ai, www\.kordi\.ai/);
  assert.match(
    caddyfile,
    /coordinar\.io, www\.coordinar\.io[\s\S]*@legacy_product_routes path \/v1\/cloud\/\* \/v2\/chat\/\* \/health \/updates\/\*/,
  );
  assert.ok(
    caddyfile.indexOf('handle @legacy_product_routes')
      < caddyfile.indexOf('redir https://kordi.ai{uri} 308'),
    'legacy product routes must be handled before the marketing redirect',
  );
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:17081/);
  assert.doesNotMatch(caddyfile, /reverse_proxy 10\.\d+\.\d+\.\d+:17081/);
  assert.match(portForwardService, /service\/kordi-cloud-server 17081:17081/);
  assert.match(portForwardService, /--address=127\.0\.0\.1/);
  assert.match(portForwardService, /Restart=always/);
  assert.match(portForwardService, /LimitNOFILE=65536/);
  assert.doesNotMatch(portForwardService, /LimitNOFILE=1024/);

  assert.match(deploy, /PUBLIC_ORIGIN=.*https:\/\/kordi\.ai/);
  assert.match(deploy, /LEGACY_ORIGIN=.*https:\/\/coordinar\.io/);
  assert.match(deploy, /verify_product_origin "\$\{PUBLIC_ORIGIN\}"/);
  assert.match(deploy, /verify_product_origin "\$\{LEGACY_ORIGIN\}"/);
  assert.match(deploy, /KORDI_VERIFY_RESOLVE_IP/);
  assert.match(deploy, /--resolve "\$\{origin_host\}:443:\$\{VERIFY_RESOLVE_IP\}"/);
  assert.match(deploy, /expected direct health status 200/);
  assert.match(deploy, /expected direct login preflight status 200/);
  assert.match(deploy, /Access-Control-Request-Method: POST/);
  assert.match(deploy, /access-control-allow-origin/);
  assert.match(deploy, /expected direct updater metadata status 200/);
});
