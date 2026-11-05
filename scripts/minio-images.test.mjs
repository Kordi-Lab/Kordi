// MinIO no longer publishes its release images, so Kordi builds the pinned
// releases from source (deploy/minio). These checks keep every environment on
// those images and stop references to the unavailable registries from
// returning.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import { read, repoRoot } from './local-debug-stack-helpers.mjs';

const YAML = createRequire(new URL('../app/desktop/package.json', import.meta.url))('yaml');

function pinnedRelease(dockerfile, name, modulePath) {
  const text = read(dockerfile);
  const release = text.match(new RegExp(`^ARG ${name}_RELEASE=(RELEASE\\.[0-9TZ-]+)$`, 'm'))?.[1];
  const version = text.match(new RegExp(`^ARG ${name}_VERSION=(\\S+)$`, 'm'))?.[1];
  const module = text.match(new RegExp(`^ARG ${name}_MODULE=(v0\\.0\\.0-(\\d{14})-([0-9a-f]{12}))$`, 'm'));
  assert.ok(release, `${dockerfile} pins a ${name} release`);
  // RELEASE.2024-12-18T13-15-44Z is version 2024-12-18T13:15:44Z.
  const [date, time] = release.slice('RELEASE.'.length).split('T');
  assert.equal(version, `${date}T${time.replace(/-/g, ':')}`, `${dockerfile} version matches its release`);
  // The module is the release commit's pseudo-version, never a movable tag;
  // its timestamp is the release time.
  assert.ok(module, `${dockerfile} installs ${name} by Go pseudo-version`);
  assert.equal(module[2], `${date}${time}`.replace(/[-Z]/g, ''), `${dockerfile} module matches its release`);
  assert.match(text, new RegExp(`go install \\\\\\n[^\\n]*\\n\\s+"${modulePath.replace(/\./g, '\\.')}@\\$\\{${name}_MODULE\\}"`));
  assert.doesNotMatch(text, /apk add[^\n]*\bgit\b/, `${dockerfile} needs no git`);
  // The image carries the upstream AGPL license, notices, and dependency credits.
  assert.match(text, /for file in LICENSE NOTICE CREDITS;/);
  assert.match(text, /^COPY --from=build \/licenses \/usr\/share\/licenses\/\w+$/m);
  return { release, module: module[1], revision: module[3] };
}

const server = pinnedRelease('deploy/minio/Dockerfile.server', 'MINIO', 'github.com/minio/minio');
const client = pinnedRelease('deploy/minio/Dockerfile.client', 'MC', 'github.com/minio/mc');
const serverRelease = server.release;
const clientRelease = client.release;
const serverImage = `docker.io/library/kordi-minio:${serverRelease}`;
const clientImage = `docker.io/library/kordi-minio-mc:${clientRelease}`;

function trackedTextFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .flatMap((path) => {
      let contents;
      try {
        contents = readFileSync(join(repoRoot, path));
      } catch {
        return [];
      }
      if (contents.length > 4 * 1024 * 1024 || contents.includes(0)) return [];
      return [{ path, text: contents.toString('utf8') }];
    });
}

function podContainers(document) {
  const pod = document?.spec?.template?.spec ?? {};
  return [...(pod.initContainers ?? []), ...(pod.containers ?? [])];
}

test('no file references a registry that no longer serves MinIO images', () => {
  const unavailable = [
    /quay\.io\/minio\//,
    // Docker Hub repositories, written bare or with a registry prefix. Go
    // module paths such as github.com/minio/mc are preceded by a slash.
    /(?<![\w./-])(?:(?:index\.)?docker\.io\/)?(?:minio|bitnami)\/(?:minio|mc|minio-client)(?=[:@\s"'`]|$)/m,
  ];
  const offenders = trackedTextFiles()
    .filter(({ path }) => path !== 'scripts/minio-images.test.mjs')
    .filter(({ text }) => unavailable.some((pattern) => pattern.test(text)))
    .map(({ path }) => path);
  assert.deepEqual(offenders, [], 'build MinIO from source with deploy/minio instead');
});

test('every from-source MinIO image reference uses the pinned release', () => {
  const tags = { 'kordi-minio': serverRelease, 'kordi-minio-mc': clientRelease };
  const mismatches = [];
  for (const { path, text } of trackedTextFiles()) {
    for (const match of text.matchAll(/\bkordi-minio(-mc)?:([A-Za-z0-9._-]+)/g)) {
      const name = `kordi-minio${match[1] ?? ''}`;
      if (match[2] !== tags[name]) mismatches.push(`${path}: ${match[0]}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

test('the development stack builds both MinIO images and keeps loopback ports', () => {
  const compose = YAML.parse(read('deploy/dev/compose.yaml'));
  const expected = {
    minio: [serverImage, 'Dockerfile.server'],
    'minio-init': [clientImage, 'Dockerfile.client'],
  };
  for (const [service, [image, dockerfile]] of Object.entries(expected)) {
    const definition = compose.services[service];
    assert.equal(`docker.io/library/${definition.image}`, image, service);
    assert.deepEqual(definition.build, { context: '../minio', dockerfile }, service);
    assert.equal(definition.pull_policy, 'build', `${service} never pulls its image`);
  }
  for (const port of compose.services.minio.ports) {
    assert.match(port, /^127\.0\.0\.1:/);
  }
  const smoke = read('scripts/dev-cloud-smoke.sh');
  assert.match(smoke, /run --rm --no-deps -T --entrypoint \/bin\/sh/);
  assert.match(smoke, /minio-init -s <"\$repo_root\/deploy\/minio\/object-store-smoke\.sh"/);
});

test('k3s workloads run only imported MinIO images', () => {
  const documents = YAML.parseAllDocuments(read('bridges/cloud-server/deploy/k3s/manifests/minio.yaml')).map((document) =>
    document.toJSON(),
  );
  const images = documents.flatMap(podContainers).map(({ image, imagePullPolicy }) => [image, imagePullPolicy]);
  assert.deepEqual(images, [
    [serverImage, 'Never'],
    [clientImage, 'Never'],
  ]);

  for (const path of [
    'bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh',
    'bridges/cloud-server/deploy/k3s/create-release-credentials.sh',
  ]) {
    const script = read(path);
    const reference = script.indexOf(`image: ${clientImage}\n`);
    assert.notEqual(reference, -1, `${path} runs the from-source mc image`);
    assert.match(script.slice(reference), /^image: \S+\n\s+imagePullPolicy: Never\n/, path);
  }

  const builder = read('deploy/minio/build-k3s-images.sh');
  assert.match(builder, new RegExp(`^MINIO_IMAGE=${serverImage.replace(/\./g, '\\.')}$`, 'm'));
  assert.match(builder, new RegExp(`^MC_IMAGE=${clientImage.replace(/\./g, '\\.')}$`, 'm'));
  assert.match(builder, /k3s ctr --namespace k8s\.io/);
  // The product host builds only with enough disk and memory, and prunes after.
  assert.match(builder, /KORDI_MINIO_BUILD_MIN_DISK_MIB/);
  assert.match(builder, /MemAvailable/);
  assert.match(builder, /trap cleanup EXIT/);
  assert.match(builder, /buildah rmi --prune/);
  assert.ok(builder.indexOf('MemAvailable') < builder.indexOf('buildah bud'), 'checks run before building');

  const deploy = read('bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh');
  for (const file of ['Dockerfile.server', 'Dockerfile.client', 'build-k3s-images.sh']) {
    assert.match(deploy, new RegExp(`deploy/minio/${file.replace(/\./g, '\\.')} \\\\\\n`));
  }
  const build = deploy.indexOf('bash deploy/minio/build-k3s-images.sh');
  assert.notEqual(build, -1);
  assert.ok(build < deploy.indexOf('kubectl apply -f minio.yaml'), 'images are imported before minio.yaml is applied');

  const credentials = read('bridges/cloud-server/deploy/k3s/create-release-credentials.sh');
  assert.ok(
    credentials.indexOf("grep -qxF '${MC_IMAGE}'") < credentials.indexOf('remote_secret_state'),
    'release identities stop before any change when mc is not imported',
  );

  const vps = read('scripts/build-vps-images.sh');
  assert.match(vps, /minio\.oci\.tar.*deploy\/minio\/Dockerfile\.server deploy\/minio/);
  assert.match(vps, /minio-mc\.oci\.tar.*deploy\/minio\/Dockerfile\.client deploy\/minio/);
  assert.match(read('docs/vps-deployment.md'), /omp-route-worker minio minio-mc; do/);
});

test('the license catalog records the exact source of both images', () => {
  const catalog = JSON.parse(read('legal/catalog.json'));
  const entries = catalog.packages.filter(({ ecosystem }) => ecosystem === 'container');
  const expected = [
    ['github.com/minio/mc', client, 'deploy/minio/Dockerfile.client'],
    ['github.com/minio/minio', server, 'deploy/minio/Dockerfile.server'],
  ];
  assert.deepEqual(
    entries.map(({ name }) => name),
    expected.map(([name]) => name),
  );
  for (const [name, pinned, dockerfile] of expected) {
    const entry = entries.find((candidate) => candidate.name === name);
    assert.equal(entry.version, pinned.release, name);
    assert.equal(entry.license, 'AGPL-3.0-or-later', name);
    assert.ok(entry.revision.startsWith(pinned.revision), `${name} records the pinned commit`);
    assert.equal(entry.source, `https://codeload.github.com/${name.slice('github.com/'.length)}/tar.gz/${entry.revision}`);
    assert.ok(catalog.inputs[dockerfile], `${dockerfile} changes make the license review stale`);
  }
});
