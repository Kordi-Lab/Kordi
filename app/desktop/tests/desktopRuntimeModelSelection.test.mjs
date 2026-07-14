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
