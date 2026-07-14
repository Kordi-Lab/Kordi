import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function rustCommandSource(commandName) {
  const source = readFileSync(new URL('../src-tauri/src/chat.rs', import.meta.url), 'utf8');
  const start = source.indexOf(`pub async fn ${commandName}`);
  assert.notEqual(start, -1, `${commandName} command must exist`);
  const end = source.indexOf('\n#[tauri::command]', start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

test('desktop model selection loads or creates the exact requested runtime session', () => {
  const command = rustCommandSource('desktop_chat_update_session_config');

  assert.match(command, /ensure_loaded_or_create_explicit_session\s*\(/);
  assert.doesNotMatch(command, /ensure_loaded_session\s*\(/);
});

test('desktop model selection materializes a new canonical runtime before persisting config', () => {
  const command = rustCommandSource('desktop_chat_update_session_config');
  assert.match(
    command,
    /\.set_explicit_config\(model\.as_deref\(\), thinking\.as_deref\(\)\)/,
    'the exact runtime must materialize and persist its explicit configuration atomically',
  );
});

test('desktop draft model selection stays transient until the first send', () => {
  const command = rustCommandSource('desktop_chat_update_session_config');

  assert.match(
    command,
    /if target_session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID[\s\S]*\.set_model\([\s\S]*\.set_thinking\([\s\S]*else[\s\S]*\.set_explicit_config\(/,
    'draft changes must use the non-materializing setters while real sessions persist explicit config',
  );
});

test('desktop companion hydration reads the exact requested runtime without falling back', () => {
  const command = rustCommandSource('desktop_chat_session_detail');

  assert.match(command, /ensure_loaded_or_create_explicit_session\s*\(/);
  assert.doesNotMatch(command, /ensure_loaded_session\s*\(/);
  assert.match(command, /\.detail\(\)/);
});
