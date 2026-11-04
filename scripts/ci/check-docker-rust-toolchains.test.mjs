import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXEMPT_FILES,
  collectRepositoryPins,
  compareVersions,
  findOutdatedPins,
  findPinnedToolchains,
  isCandidateFile,
  requiredRustVersion,
} from './check-docker-rust-toolchains.mjs';

test('recognizes Docker, compose, and toolchain files', () => {
  for (const file of [
    'bridges/cloud-server/Dockerfile',
    'deploy/render/Dockerfile.runner',
    'deploy/render/nats.Dockerfile',
    'deploy/dev/compose.yaml',
    'bridges/docker/docker-compose.yml',
    'agent/rust-toolchain.toml',
  ]) {
    assert.ok(isCandidateFile(file), file);
  }
  assert.ok(!isCandidateFile('docs/Dockerfile-notes.md/readme.txt'));
  assert.ok(!isCandidateFile('scripts/ci/check-docker-rust-toolchains.mjs'));
});

test('extracts pinned Rust builder images and toolchain channels', () => {
  const dockerfile = [
    'FROM rust:1.88-slim-bookworm AS builder',
    'FROM --platform=linux/amd64 docker.io/library/rust:1.97.1-slim-bookworm AS second',
    'FROM rust:latest AS floating',
    'FROM debian:bookworm-slim AS runtime',
    'FROM example.test/rust:1.10 AS mirror',
  ].join('\n');
  assert.deepEqual(findPinnedToolchains('Dockerfile', dockerfile), [
    { file: 'Dockerfile', line: 1, version: '1.88' },
    { file: 'Dockerfile', line: 2, version: '1.97.1' },
  ]);
  assert.deepEqual(findPinnedToolchains('compose.yaml', 'services:\n  build:\n    image: "rust:1.82-bookworm"\n'), [
    { file: 'compose.yaml', line: 3, version: '1.82' },
  ]);
  assert.deepEqual(findPinnedToolchains('a/rust-toolchain.toml', '[toolchain]\nchannel = "1.93.0"\n'), [
    { file: 'a/rust-toolchain.toml', line: 2, version: '1.93.0' },
  ]);
  assert.deepEqual(findPinnedToolchains('a/rust-toolchain.toml', '[toolchain]\nchannel = "stable"\n'), []);
});

test('takes the highest rust-version among resolved packages only', () => {
  const metadata = {
    packages: [
      { id: 'a', name: 'alpha', version: '1.0.0', rust_version: '1.88' },
      { id: 'b', name: 'beta', version: '2.0.0', rust_version: '1.91.0' },
      { id: 'c', name: 'gamma', version: '3.0.0', rust_version: '1.91' },
      { id: 'd', name: 'delta', version: '4.0.0', rust_version: '1.99.0' },
      { id: 'e', name: 'epsilon', version: '5.0.0', rust_version: null },
    ],
    resolve: { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'e' }] },
  };
  assert.deepEqual(requiredRustVersion(metadata), { version: '1.91.0', packages: ['beta@2.0.0', 'gamma@3.0.0'] });
});

test('flags pins below the requirement and skips exempt files', () => {
  assert.equal(compareVersions('1.97', '1.91.0'), 6);
  assert.equal(compareVersions('1.91', '1.91.0'), 0);
  assert.ok(compareVersions('1.88', '1.91.0') < 0);
  const exempt = Object.keys(EXEMPT_FILES)[0];
  const pins = [
    { file: 'bridges/cloud-server/Dockerfile', line: 15, version: '1.88' },
    { file: 'deploy/render/Dockerfile', line: 4, version: '1.97' },
    { file: exempt, line: 7, version: '1.82' },
  ];
  assert.deepEqual(findOutdatedPins(pins, '1.91.0'), [pins[0]]);
});

test('every exemption still names a file with a pinned toolchain', () => {
  const pinnedFiles = new Set(collectRepositoryPins().map((pin) => pin.file));
  for (const file of Object.keys(EXEMPT_FILES)) {
    assert.ok(pinnedFiles.has(file), `${file} no longer pins Rust; remove its exemption`);
  }
  assert.ok(pinnedFiles.has('bridges/cloud-server/Dockerfile'));
});
