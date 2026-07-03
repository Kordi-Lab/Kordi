import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const commandsSource = () => readFileSync(new URL('../src-tauri/src/canonical_sessions/commands.rs', import.meta.url), 'utf8');
const canonicalSessionsSource = () => readFileSync(new URL('../src-tauri/src/canonical_sessions.rs', import.meta.url), 'utf8');

test('canonical state loading maps session_messages in one query instead of N+1 select_message calls', () => {
  const source = commandsSource();
  const loadStart = source.indexOf('pub(super) fn load_state_from_db');
  assert.notEqual(loadStart, -1, 'expected load_state_from_db in canonical session commands');
  const loadEnd = source.indexOf('pub(super) fn desktop_canonical_session_state', loadStart);
  assert.notEqual(loadEnd, -1, 'expected next command after load_state_from_db');
  const loader = source.slice(loadStart, loadEnd);

  assert.match(loader, /SELECT id, session_id, sender_identity_id, sender_role, message_kind, content_text, content_json,/, 'message state should be selected with all columns in one statement');
  assert.doesNotMatch(loader, /SELECT id FROM session_messages[\s\S]*select_message\(conn, &id\)/, 'load_state_from_db must not run one select_message query per message');
});

test('canonical open-or-create command runs blocking database work off the Tauri invoke thread', () => {
  const source = canonicalSessionsSource();
  const commandMatch = /pub async fn desktop_canonical_open_or_create_session\s*\(/.exec(source);
  assert.ok(commandMatch?.index !== undefined, 'open-or-create should be async so it does not block UI event handling');
  const commandStart = commandMatch.index;
  const commandEnd = source.indexOf('#[tauri::command]', commandStart + 1);
  assert.notEqual(commandEnd, -1, 'expected next tauri command after open-or-create');
  const command = source.slice(commandStart, commandEnd);

  assert.match(source, /async fn run_canonical_blocking/, 'canonical commands should share a blocking-pool helper');
  assert.match(command, /run_canonical_blocking\(move \|\| commands::desktop_canonical_open_or_create_session\(request\)\)\s*\.await/, 'open-or-create should dispatch DB state reload to the blocking pool');
});
