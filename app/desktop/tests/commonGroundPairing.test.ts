import assert from 'node:assert/strict';
import { test } from 'node:test';

import qrcode from 'qrcode-generator';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  COMMON_GROUND_PAIR_LINK_EVENT, displayPairCode, hasPendingPairLink, normalizePairCode, pairCodeFromUrl, pairLinkUrl, rememberPairLink, takePendingPairLink,
} from '../src/features/commonGround/pairLink';
import { PairCodePanel } from '../src/features/commonGround/PairCodePanel';
import { qrModules } from '../src/features/commonGround/qrModules';
import { CgPairSession, PAIR_CODE_TTL_MS, PAIR_REFRESH_LEAD_MS, pairCodeDeadline, pairTimeLeft } from '../src/features/commonGround/pairSession';
import { CommonGroundStore } from '../src/features/commonGround/store';
import { PAIR_EXPIRED, PAIR_INVALID, PAIR_SELF, PAIR_SHARING_OFF, redeemPairLink } from '../src/features/commonGround/storePairing';

import { card, mockServer, person, profile, rel } from './helpers/commonGroundServer';

const NOW = Date.parse('2026-10-21T10:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const work = profile('cgp_work', 'work', 'Work', true);
const hana = { person: person('acct_hana', rel()), card };
const notFound = { status: 404, body: { errorCode: 'common_ground_code_not_found', message: 'Code not found or expired.' } };

function pairStore(routes: Parameters<typeof mockServer>[0]) {
  const server = mockServer(routes);
  const store = new CommonGroundStore(server.client, { profiles: true });
  store.set({ profiles: [work], profileId: 'cgp_work', loaded: true });
  return { ...server, store };
}

/** Timers that run only when the test says so. */
function manualTimers() {
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const setTimer = (run: () => void, ms: number) => {
    const timer = { run, ms, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  return { timers, setTimer };
}

test('pair link: reads kordi://common-ground/pair/<code> and nothing else', () => {
  assert.equal(pairCodeFromUrl('kordi://common-ground/pair/K4M7-2QXA'), 'K4M7-2QXA');
  assert.equal(pairCodeFromUrl('  kordi://common-ground/pair/k4m72qxa '), 'K4M7-2QXA');
  assert.equal(pairCodeFromUrl('kordi://common-ground/pair/K4M7-2QXA/'), 'K4M7-2QXA');
  assert.equal(pairCodeFromUrl(pairLinkUrl('K4M7-2QXA')), 'K4M7-2QXA');
  for (const value of [
    'kordi://common-ground/pair/K4M7', 'kordi://common-ground/room/4821', 'kordi://common-ground/pair/K4M7-2QXA/extra',
    'kordi://document/K4M7-2QXA', 'https://kordi.ai/common-ground/pair/K4M7-2QXA', 'K4M7-2QXA', '', null, undefined, 'not a url',
  ]) assert.equal(pairCodeFromUrl(value), null, String(value));
});

test('pair link: codes read as the server reads them', () => {
  assert.equal(normalizePairCode(' k4m7 - 2qxa '), 'K4M72QXA');
  assert.equal(normalizePairCode('OIL0'), '0110');
  assert.equal(displayPairCode('k4m72qxa'), 'K4M7-2QXA');
  assert.equal(displayPairCode('K4M7-2QX'), null);
});

test('pair link: a link waits for the page once and is announced', () => {
  const target = new EventTarget();
  const seen: string[] = [];
  target.addEventListener(COMMON_GROUND_PAIR_LINK_EVENT, (event) => seen.push((event as CustomEvent<string>).detail));
  assert.equal(rememberPairLink('kordi://common-ground/room/4821', target), false);
  assert.equal(hasPendingPairLink(), false);
  assert.equal(rememberPairLink('kordi://common-ground/pair/k4m72qxa', target), true);
  assert.deepEqual(seen, ['K4M7-2QXA']);
  assert.equal(hasPendingPairLink(), true);
  assert.equal(takePendingPairLink(), 'K4M7-2QXA');
  assert.equal(takePendingPairLink(), null);
});

test('pairing: the popover shows a code for the selected card and renews it before it runs out', async () => {
  const { calls, store } = pairStore({
    'POST pairings/code': [
      { status: 200, body: { code: 'K4M7-2QXA', expiresAt: at(PAIR_CODE_TTL_MS), profileId: 'cgp_work' } },
      { status: 200, body: { code: 'P9RT-6WZB', expiresAt: at(PAIR_CODE_TTL_MS), profileId: 'cgp_work' } },
    ],
  });
  const { timers, setTimer } = manualTimers();
  const session = new CgPairSession({ create: () => store.newPairCode(), redeem: (code) => store.redeemPairCode(code), now: () => NOW, setTimer });
  assert.equal(session.getSnapshot().phase, 'loading');
  await session.start();
  assert.deepEqual(calls.map((call) => [call.method, call.url.split('common-ground/')[1], call.body]), [['POST', 'pairings/code', { profileId: 'cgp_work' }]]);
  assert.equal(session.getSnapshot().phase, 'ready');
  assert.equal(session.getSnapshot().code, 'K4M7-2QXA');
  assert.equal(session.getSnapshot().expiresAt, NOW + PAIR_CODE_TTL_MS);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, PAIR_CODE_TTL_MS - PAIR_REFRESH_LEAD_MS);
  timers[0].run();
  // The old code stays on screen while the new one is on its way.
  assert.equal(session.getSnapshot().code, 'K4M7-2QXA');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.getSnapshot().code, 'P9RT-6WZB');
  assert.equal(timers.length, 2);
  session.stop();
  assert.equal(timers[1].cancelled, true);
});

test('pairing: their code pairs, sharing the selected card, and opens the match', async () => {
  const { calls, store } = pairStore({
    'POST pairings/code': { status: 200, body: { code: 'K4M7-2QXA', expiresAt: at(PAIR_CODE_TTL_MS) } },
    'POST pairings/redeem': { status: 200, body: hana },
  });
  const session = new CgPairSession({ create: () => store.newPairCode(), redeem: (code) => store.redeemPairCode(code), now: () => NOW, setTimer: () => () => undefined });
  await session.start();
  assert.equal(await session.redeem(' p9rt 6wzb '), true);
  const redeem = calls.find((call) => call.url.endsWith('pairings/redeem'));
  assert.deepEqual(redeem?.body, { code: 'P9RT-6WZB', profileId: 'cgp_work' });
  assert.deepEqual(store.top(), { name: 'match', accountId: 'acct_hana', profileId: 'cgp_work' });
  assert.equal(session.getSnapshot().phase, 'closed');
});

test('pairing: an expired or used code asks for a new one, and your own code is refused', async () => {
  const { calls, store } = pairStore({
    'POST pairings/code': { status: 200, body: { code: 'K4M7-2QXA', expiresAt: at(PAIR_CODE_TTL_MS) } },
    'POST pairings/redeem': notFound,
  });
  const session = new CgPairSession({ create: () => store.newPairCode(), redeem: (code) => store.redeemPairCode(code), now: () => NOW, setTimer: () => () => undefined });
  await session.start();

  assert.equal(await session.redeem('k4m7-2qxa'), false);
  assert.equal(session.getSnapshot().error, PAIR_SELF);
  assert.equal(await session.redeem('K4M7'), false);
  assert.equal(session.getSnapshot().error, PAIR_INVALID);
  assert.equal(calls.filter((call) => call.url.endsWith('pairings/redeem')).length, 0);

  assert.equal(await session.redeem('P9RT-6WZB'), false);
  assert.equal(session.getSnapshot().error, PAIR_EXPIRED);
  assert.equal(PAIR_EXPIRED, 'That code expired. Ask for a new one.');
  assert.equal(session.getSnapshot().phase, 'ready');
  assert.deepEqual(store.top(), { name: 'home' });
  session.clearError();
  assert.equal(session.getSnapshot().error, null);
});

test('pairing: sharing off asks to turn it back on; no card opens Build', async () => {
  const sharingOff = { status: 409, body: { errorCode: 'common_ground_sharing_off', message: 'Turn on sharing to meet people.' } };
  const off = pairStore({ 'POST pairings/code': sharingOff });
  const session = new CgPairSession({ create: () => off.store.newPairCode(), redeem: (code) => off.store.redeemPairCode(code), now: () => NOW });
  await session.start();
  assert.equal(session.getSnapshot().phase, 'sharing-off');
  assert.equal(session.getSnapshot().code, null);

  const empty = pairStore({ 'POST pairings/code': { status: 409, body: { errorCode: 'common_ground_no_card', message: 'Build your card first.' } } });
  const first = new CgPairSession({ create: () => empty.store.newPairCode(), redeem: (code) => empty.store.redeemPairCode(code), now: () => NOW });
  await first.start();
  assert.equal(first.getSnapshot().phase, 'closed');
  assert.equal(empty.store.top().name, 'build');
});

test('pairing: a link redeems its code and shows failures as the page notice', async () => {
  const ok = pairStore({ 'POST pairings/redeem': { status: 200, body: hana } });
  assert.deepEqual(await redeemPairLink(ok.store, 'K4M7-2QXA'), { status: 'paired', accountId: 'acct_hana' });
  assert.equal(ok.store.top().name, 'match');

  const expired = pairStore({ 'POST pairings/redeem': notFound });
  await redeemPairLink(expired.store, 'K4M7-2QXA');
  assert.equal(expired.store.getSnapshot().notice, PAIR_EXPIRED);

  const off = pairStore({ 'POST pairings/redeem': { status: 409, body: { errorCode: 'common_ground_sharing_off', message: 'x' } } });
  await redeemPairLink(off.store, 'K4M7-2QXA');
  assert.equal(off.store.getSnapshot().notice, PAIR_SHARING_OFF);
});

test('pairing: a stopped popover drops a code still on its way', async () => {
  let resolve: (value: Awaited<ReturnType<CommonGroundStore['newPairCode']>>) => void = () => undefined;
  const session = new CgPairSession({ create: () => new Promise((done) => { resolve = done; }), redeem: async () => ({ status: 'build' }), now: () => NOW });
  const started = session.start();
  session.stop();
  resolve({ status: 'ok', code: { code: 'K4M7-2QXA', expiresAt: at(PAIR_CODE_TTL_MS) } });
  await started;
  assert.equal(session.getSnapshot().code, null);
});

test('pairing: deadlines follow the server unless the clocks disagree; time left reads m:ss', () => {
  assert.equal(pairCodeDeadline(at(90_000), NOW), NOW + 90_000);
  assert.equal(pairCodeDeadline(at(-5_000), NOW), NOW + PAIR_CODE_TTL_MS);
  assert.equal(pairCodeDeadline(at(3_600_000), NOW), NOW + PAIR_CODE_TTL_MS);
  assert.equal(pairCodeDeadline('soon', NOW), NOW + PAIR_CODE_TTL_MS);
  assert.equal(pairTimeLeft(102_000), '1:42');
  assert.equal(pairTimeLeft(9_001), '0:10');
  assert.equal(pairTimeLeft(-1), '0:00');
});

test('pairing: the QR code carries the link as one path', () => {
  const { size, d } = qrModules(qrcode, pairLinkUrl('K4M7-2QXA'));
  assert.ok(size >= 25, `size ${size}`);
  assert.match(d, /^M0 0h7v1h-7z/);
});

test('pairing: Home shows Pair above Pair code', () => {
  const { store } = pairStore({});
  const html = renderToStaticMarkup(createElement(PairCodePanel, { state: store.getSnapshot(), store }));
  assert.match(html, /data-cg-pair="true"[^>]*aria-expanded="false"/);
  assert.ok(html.indexOf('>Pair<') < html.indexOf('>Pair code<'));
});
