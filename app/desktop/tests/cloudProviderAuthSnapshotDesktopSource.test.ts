import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('desktop cloud provider-auth snapshot uses provider-specific runtime defaults', () => {
  const source = readFileSync(new URL('../src-tauri/src/cloud_provider_auth_snapshot.rs', import.meta.url), 'utf8');

  assert.match(
    source,
    /parse_model_arg\(Some\(provider\), None\)\.1/,
  );
  assert.match(source, /snapshot_model\("openai", None\)/);
  assert.match(source, /snapshot_model\("anthropic", None\)/);
  assert.match(source, /snapshot_model\("github-copilot", None\)/);
  assert.doesNotMatch(source, /unwrap_or\("gpt-5\.5"\)/);
  assert.doesNotMatch(source, /fn cloud_fallback_supported_codex_model/);
  assert.doesNotMatch(source, /"gpt-5\.5" \| "openai\/gpt-5\.5" => "gpt-5"/);
});
