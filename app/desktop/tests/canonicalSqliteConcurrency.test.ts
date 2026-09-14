import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const canonicalSessionsSource = () => readFileSync(new URL('../src-tauri/src/canonical_sessions/database.rs', import.meta.url), 'utf8');

test('canonical SQLite connections use WAL and busy timeout to avoid UI-blocking lock failures', () => {
  const source = canonicalSessionsSource();
  const openStart = source.indexOf('fn open_db_at_path(');
  const openEnd = source.length;
  assert.notEqual(openStart, -1, 'expected shared canonical database opener');
  const openDb = source.slice(openStart, openEnd);

  assert.match(openDb, /busy_timeout\(std::time::Duration::from_secs\(5\)\)/, 'canonical DB should wait briefly for concurrent writers instead of failing immediately');
  assert.match(openDb, /PRAGMA journal_mode = WAL/, 'canonical DB should use WAL for read/write concurrency');
  assert.match(openDb, /PRAGMA synchronous = NORMAL/, 'canonical DB should use NORMAL synchronous mode with WAL');
  assert.match(openDb, /initialize_schema\(&conn\)\?/, 'every connection checkout should initialize connection settings');
  const schema = readFileSync(new URL('../src-tauri/src/canonical_sessions/schema.rs', import.meta.url), 'utf8');
  const initialize = schema.slice(schema.indexOf('fn initialize_schema('), schema.indexOf('fn schema_is_current('));
  const foreignKeys = initialize.indexOf('pragma_update(None, "foreign_keys", true)');
  const warmShortcut = initialize.indexOf('schema_is_current(conn)?');
  assert.ok(foreignKeys >= 0 && warmShortcut > foreignKeys, 'foreign keys must be enabled before the warm schema shortcut');
});
