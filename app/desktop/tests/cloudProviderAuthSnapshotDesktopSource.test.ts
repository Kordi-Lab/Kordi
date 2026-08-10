import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('desktop cloud provider-auth snapshot uses the root OpenAI runtime default', () => {
  const authSource = readFileSync(new URL('../src-tauri/src/auth.rs', import.meta.url), 'utf8');
  const snapshotSource = readFileSync(new URL('../src-tauri/src/auth/cloud_provider_snapshot.rs', import.meta.url), 'utf8');

  assert.match(authSource, /cloud_provider_snapshot::snapshot_model\(model\.as_deref\(\)\)/);
  assert.match(snapshotSource, /unwrap_or\(kordi_core::agent_session::DEFAULT_OPENAI_MODEL_ID\)/);
  assert.match(snapshotSource, /"anthropic" \| "anthropic-oauth"/);
  assert.match(snapshotSource, /"apiMode":\s*"anthropic-oauth"/);
  assert.doesNotMatch(snapshotSource, /unwrap_or\("gpt-5\.5"\)/);
  assert.doesNotMatch(snapshotSource, /fn cloud_fallback_supported_codex_model/);
  assert.doesNotMatch(snapshotSource, /"gpt-5\.5" \| "openai\/gpt-5\.5" => "gpt-5"/);
});
