import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('desktop cloud provider-auth snapshot preserves the local fallback model default', () => {
  const source = readFileSync(new URL('../src-tauri/src/auth.rs', import.meta.url), 'utf8');

  assert.match(source, /unwrap_or\("gpt-5\.5"\)/);
  assert.doesNotMatch(source, /fn cloud_fallback_supported_codex_model/);
  assert.doesNotMatch(source, /"gpt-5\.5" \| "openai\/gpt-5\.5" => "gpt-5"/);
});
