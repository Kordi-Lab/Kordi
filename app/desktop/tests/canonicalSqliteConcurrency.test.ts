import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const canonicalSessionsSource = () => readFileSync(new URL('../src-tauri/src/canonical_sessions.rs', import.meta.url), 'utf8');

test('canonical SQLite connections use WAL and busy timeout to avoid UI-blocking lock failures', () => {
  const source = canonicalSessionsSource();
  const openStart = source.indexOf('fn open_db() -> Result<Connection, String>');
  const openEnd = source.indexOf('\n}\n\nfn upsert_identity_in_db', openStart);
  assert.notEqual(openStart, -1, 'expected canonical open_db');
  assert.notEqual(openEnd, -1, 'expected end of canonical open_db');
  const openDb = source.slice(openStart, openEnd);

  assert.match(openDb, /busy_timeout\(std::time::Duration::from_secs\(5\)\)/, 'canonical DB should wait briefly for concurrent writers instead of failing immediately');
  assert.match(openDb, /PRAGMA journal_mode = WAL/, 'canonical DB should use WAL for read/write concurrency');
  assert.match(openDb, /PRAGMA synchronous = NORMAL/, 'canonical DB should use NORMAL synchronous mode with WAL');
  assert.match(openDb, /PRAGMA foreign_keys = ON/, 'canonical DB should keep foreign keys enabled');
});
