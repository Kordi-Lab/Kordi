import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const tauriRoot = new URL('../src-tauri/', import.meta.url);

test('desktop link previews use only the validated native HTTP path', () => {
  const buildScript = readFileSync(new URL('build.rs', tauriRoot), 'utf8');
  const linkPreview = readFileSync(new URL('src/link_preview.rs', tauriRoot), 'utf8');

  assert.doesNotMatch(buildScript, /LinkPreview\.swift/);
  assert.match(buildScript, /native\/LivePhotos\.swift/, 'the Live Photos bridge still builds');
  assert.doesNotMatch(linkPreview, /kordi_fetch_link_preview/);
  assert.doesNotMatch(linkPreview, /LPMetadataProvider/);
  assert.match(linkPreview, /request_public_remote_image/);
  assert.equal(existsSync(new URL('native/LinkPreview.swift', tauriRoot)), false);
});
