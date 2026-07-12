import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const commandsSource = () => readFileSync(new URL('../src-tauri/src/canonical_sessions/commands.rs', import.meta.url), 'utf8');
const canonicalSessionsSource = () => readFileSync(new URL('../src-tauri/src/canonical_sessions.rs', import.meta.url), 'utf8');
const desktopSource = () => readFileSync(new URL('../src/lib/desktop.ts', import.meta.url), 'utf8');
const modelsSource = () => readFileSync(new URL('../src-tauri/src/canonical_sessions/models.rs', import.meta.url), 'utf8');
const typesSource = () => readFileSync(new URL('../src/kordi-app/types.ts', import.meta.url), 'utf8');
const cloudBridgeSource = () => readFileSync(new URL('../src/features/cloud/useCloudBridgeState.ts', import.meta.url), 'utf8');

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

test('mark-session-read returns a cursor delta without reloading canonical state', () => {
  const source = commandsSource();
  const commandStart = source.indexOf('pub(super) fn desktop_canonical_mark_session_read');
  assert.notEqual(commandStart, -1, 'expected mark-session-read command');
  const commandEnd = source.indexOf('pub(crate) fn session_exists', commandStart);
  assert.notEqual(commandEnd, -1, 'expected next function after mark-session-read');
  const command = source.slice(commandStart, commandEnd);

  assert.match(command, /Result<Option<CanonicalReadCursorDelta>, String>/, 'read command should return only the updated participant cursor');
  assert.doesNotMatch(command, /load_state_from_db/, 'read command must not reload all canonical messages');
});

test('fast append returns the persisted canonical message row across the native boundary', () => {
  const rustSource = canonicalSessionsSource();
  const rendererSource = desktopSource();

  assert.match(rustSource, /pub async fn desktop_canonical_append_message_fast[\s\S]*?Result<CanonicalSessionMessage, String>/, 'native fast append should return the persisted row');
  assert.match(rendererSource, /appendCanonicalMessageFast[\s\S]*?invokeDesktop<CanonicalSessionMessage>/, 'renderer fast append should receive the persisted row');
});

test('canonical catalog returns summaries without loading complete message or context history', () => {
  const source = commandsSource();
  const start = source.indexOf('fn load_catalog_from_db');
  const end = source.indexOf('pub(super) fn desktop_canonical_session_catalog', start);
  assert.notEqual(start, -1, 'expected catalog query');
  assert.notEqual(end, -1, 'expected catalog command after catalog query');
  const command = source.slice(start, end);

  assert.match(command, /COUNT\(\*\) OVER \(PARTITION BY sm\.session_id\)/);
  assert.match(command, /ROW_NUMBER\(\) OVER/);
  assert.doesNotMatch(command, /FROM context_snapshots ORDER BY/);
  assert.doesNotMatch(command, /select_identity\(conn|select_session\(conn|select_delegated_exchange\(conn/, 'catalog metadata should be loaded in bulk instead of one query per row');
  assert.match(modelsSource(), /pub struct CanonicalSessionCatalog/);
  assert.match(modelsSource(), /pub struct CanonicalSessionSummary/);
});

test('canonical transcript page uses descending indexed reads with a bounded limit', () => {
  const source = commandsSource();
  const start = source.indexOf('fn load_message_page_from_db');
  const end = source.indexOf('pub(super) fn desktop_canonical_session_messages', start);
  assert.notEqual(start, -1, 'expected paged transcript query');
  assert.notEqual(end, -1, 'expected page command after page query');
  const command = source.slice(start, end);

  assert.match(command, /sequence_num < \?2/);
  assert.match(command, /ORDER BY sequence_num DESC, created_at_ms DESC, id DESC/);
  assert.match(command, /\.clamp\(25, 200\)/);
  assert.match(desktopSource(), /fetchCanonicalSessionCatalog[\s\S]*invokeDesktop<CanonicalSessionCatalog>/);
  assert.match(desktopSource(), /fetchCanonicalSessionMessages[\s\S]*invokeDesktop<CanonicalMessagePage>/);
});

test('native scale regression seeds 20,000 rows and enforces catalog and page byte budgets', () => {
  const source = commandsSource();
  const start = source.indexOf('fn catalog_and_first_page_stay_bounded_with_twenty_thousand_messages');
  assert.notEqual(start, -1, 'expected native 20k-row payload regression');
  const testSource = source.slice(start);
  assert.match(testSource, /20_000/);
  assert.match(testSource, /catalog_bytes < 1024 \* 1024/);
  assert.match(testSource, /page\.messages\.len\(\) <= 150/);
  assert.match(testSource, /page_bytes < 512 \* 1024/);
});

test('cloud profile adoption returns a bounded identity delta without loading canonical state', () => {
  const modelSource = modelsSource();
  const nativeModel = /pub struct CanonicalProfileIdentityDelta \{([\s\S]*?)\n\}/.exec(modelSource);
  assert.ok(nativeModel, 'native model should expose the bounded delta');
  assert.deepEqual(
    Array.from(nativeModel[1]?.matchAll(/pub (\w+):/g) ?? [], (match) => match[1]),
    ['profile', 'identity', 'previous_identity_id', 'group_self_session_ids'],
  );
  assert.doesNotMatch(nativeModel[0], /messages|sessions|context_snapshots|CanonicalSessionState/);

  const rendererModel = /export type CanonicalProfileIdentityDelta = \{([\s\S]*?)\n\};/.exec(typesSource());
  assert.ok(rendererModel, 'renderer types should expose the bounded delta');
  assert.deepEqual(
    Array.from(rendererModel[1]?.matchAll(/^\s*(\w+)[?:]*:/gm) ?? [], (match) => match[1]),
    ['profile', 'identity', 'previousIdentityId', 'groupSelfSessionIds'],
  );

  const commandSource = commandsSource();
  const commandStart = commandSource.indexOf('pub(super) fn desktop_canonical_adopt_cloud_profile_identity');
  const commandEnd = commandSource.indexOf('pub(super) fn desktop_canonical_upsert_identity_fast', commandStart);
  assert.notEqual(commandStart, -1, 'expected native cloud profile adoption command');
  assert.notEqual(commandEnd, -1, 'expected the next native command');
  const command = commandSource.slice(commandStart, commandEnd);
  assert.match(command, /Result<CanonicalProfileIdentityDelta, String>/);
  assert.doesNotMatch(command, /CanonicalSessionState|load_state_from_db/);

  const rustSource = canonicalSessionsSource();
  const dbStart = rustSource.indexOf('pub(super) fn adopt_cloud_profile_identity_in_db');
  const dbEnd = rustSource.indexOf('fn update_local_profile_identities', dbStart);
  const dbAdoption = rustSource.slice(dbStart, dbEnd);
  assert.match(dbAdoption, /Result<CanonicalProfileIdentityDelta, String>/);
  assert.doesNotMatch(dbAdoption, /CanonicalSessionState|load_state_from_db/);

  const wrapperStart = rustSource.indexOf('pub async fn desktop_canonical_adopt_cloud_profile_identity');
  const wrapperEnd = rustSource.indexOf('#[tauri::command]', wrapperStart + 1);
  const wrapper = rustSource.slice(wrapperStart, wrapperEnd);
  assert.match(wrapper, /Result<CanonicalProfileIdentityDelta, String>/);
  assert.doesNotMatch(wrapper, /CanonicalSessionState|load_state_from_db/);

  const rendererSource = desktopSource();
  const rendererStart = rendererSource.indexOf('export async function adoptCloudProfileIdentity');
  const rendererEnd = rendererSource.indexOf('export async function', rendererStart + 1);
  const rendererClient = rendererSource.slice(rendererStart, rendererEnd);
  assert.match(rendererClient, /invokeDesktop<CanonicalProfileIdentityDelta>/);
  assert.doesNotMatch(rendererClient, /CanonicalSessionState/);

  const cloudSource = cloudBridgeSource();
  assert.match(
    cloudSource,
    /\.then\(\(delta\) => \{[\s\S]*?setCanonicalSessionState\?\.\(\(current\) => applyCanonicalProfileIdentityDelta\(current, delta\)\)/,
    'cloud adoption should merge the delta with a functional React state update',
  );
});

test('cloud profile adoption waits for the canonical state readiness transition', () => {
  const source = cloudBridgeSource();
  const signatureStart = source.indexOf('const cloudProfileAdoptionSignature');
  const effectStart = source.indexOf('useEffect(() => {', signatureStart);
  const effectEnd = source.indexOf('const contactIdentitySignature', effectStart);
  assert.notEqual(signatureStart, -1, 'expected cloud profile adoption signature');
  assert.notEqual(effectStart, -1, 'expected cloud profile adoption effect');
  assert.notEqual(effectEnd, -1, 'expected contact signature after adoption effect');
  const readinessSetup = source.slice(Math.max(0, signatureStart - 200), signatureStart);
  assert.match(
    readinessSetup,
    /const canonicalStateReady = Boolean\(canonicalSessionState\);/,
    'readiness must be a primitive that changes when a null catalog becomes loaded',
  );
  const effect = source.slice(effectStart, effectEnd);

  assert.match(effect, /if \(!account \|\| !canonicalStateReady \|\| !setCanonicalSessionState\) return;/);
  assert.match(
    effect,
    /\}, \[[^\]]*canonicalStateReady[^\]]*\]\);/,
    'null-to-loaded readiness must rerun adoption even when the human identity remains null',
  );
  assert.match(effect, /setCanonicalSessionState\?\.\(\(current\) => applyCanonicalProfileIdentityDelta\(current, delta\)\)/);
});

test('cloud profile adoption serializes same-account updates without per-render cancellation', () => {
  const source = cloudBridgeSource();
  assert.match(
    source,
    /const cloudProfileIdentityAdoptionCoordinator = useMemo\(\(\) => new CloudProfileIdentityAdoptionCoordinator\(\), \[\]\);/,
  );
  assert.match(
    source,
    /useEffect\(\(\) => \(\) => \{\s*cloudProfileIdentityAdoptionCoordinator\.changeAccount\(\);\s*\}, \[account\?\.accountId, cloudProfileIdentityAdoptionCoordinator\]\);/,
    'account switch and unmount should invalidate the old generation',
  );

  const signatureStart = source.indexOf('const cloudProfileAdoptionSignature');
  const effectStart = source.indexOf('useEffect(() => {', signatureStart);
  const effectEnd = source.indexOf('const contactIdentitySignature', effectStart);
  const effect = source.slice(effectStart, effectEnd);
  assert.match(effect, /if \(!account \|\| !canonicalStateReady \|\| !setCanonicalSessionState\) return;/);
  assert.match(effect, /cloudProfileIdentityAdoptionCoordinator\.request\(/);
  assert.match(effect, /adoptCloudProfileIdentity,/);
  assert.match(effect, /setCanonicalSessionState\?\.\(\(current\) => applyCanonicalProfileIdentityDelta\(current, delta\)\)/);
  assert.match(effect, /console\.warn\('\[cloud-profile-identity\] failed to adopt stable cloud profile identity', error\)/);
  assert.doesNotMatch(effect, /\bcancelled\b/, 'same-account profile rerenders must not drop an in-flight migration delta');
  assert.match(effect, /\[[^\]]*canonicalStateReady[^\]]*cloudProfileAdoptionSignature[^\]]*\]/);
});
