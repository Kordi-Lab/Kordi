import type { Page } from '@playwright/test';
import type { CgMatch, CgOwnerView, CgPairCode, CgPersonCard, CgProfile, CgRecentEntry, CgTopicLists } from '@/features/commonGround/types';
import { account } from './apiFixture';

// Synthetic Grounding routes for the complete web app: one Work card, a pairing
// with one synthetic person, and Nearby. Install after the base API fixture.
export const groundingPeerId = 'acct_browser_grounding_peer';
export const groundingPeerName = 'Robin Synthetic';
export const ownPairCode = 'K4M7-2QXA';
export const peerPairCode = 'R7NB-5WQE';
export const syntheticTopics: CgTopicLists = {
  workingOn: ['Synthetic browser QA'], interests: ['Trail running'], canHelp: ['Playwright tests'], lookingFor: ['Test partners'],
};
const profileId = 'cgp_browser_fixture_work';
const timestamp = '2026-11-05T12:00:00Z';
const relationship = { contact: false, request: null, requestId: null, conversationId: null };
const peer = { accountId: groundingPeerId, name: groundingPeerName, avatarUrl: null, handle: 'robin_synthetic', hasCard: true,
  profile: { profileId: 'cgp_browser_fixture_peer', kind: 'work' as const, name: 'Work' } };

export type GroundingRequest = { method: string; path: string; headers: Record<string, string>; body: unknown };

export async function installGroundingFixture(page: Page, baseURL: string, options: { built?: boolean } = {}) {
  let built = Boolean(options.built);
  // Like the server, Build answers 202 while the run works; the next read finds the card.
  let building = false;
  let nearby = {
    enabled: false, participating: false, pausedUntil: null as string | null, consentedAt: null as string | null, profileId,
    openTo: [] as string[], range: 2000, minScore: 0, alerts: { requests: true, matches: true, matchMinScore: 85, maxPerDay: 3 },
    location: null as { capturedAt: string; freshUntil: string; fresh: boolean } | null, freshSeconds: 1800,
  };
  const recent: CgRecentEntry[] = [];
  const requests: GroundingRequest[] = [];
  const profile = (): CgProfile => ({ profileId, kind: 'work', name: 'Work', design: null, icon: null, focus: null, position: 0,
    hasCard: built, sharing: built, builtAt: built ? timestamp : null, topicCount: built ? 4 : 0 });
  const owner = (): CgOwnerView => ({
    card: built ? { ...syntheticTopics, hidden: [], revision: 1, builtAt: timestamp } : null,
    sharing: built, build: { status: building ? 'building' : 'idle', errorCode: null }, profile: { profileId, kind: 'work', name: 'Work', focus: null },
  });
  const match: CgMatch = { status: 'ready', person: peer, score: 72, headline: 'Trail running', relationship, profileId,
    shared: [{ topic: 'Trail running', theirTopic: 'Trail running', why: 'Synthetic fixture: you both run trails.' }],
    youBring: [], theyBring: [], nextStep: 'Synthetic fixture: compare test plans.' };

  await page.route('**/v*/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseURL) return route.abort();
    const path = url.pathname;
    const method = request.method();
    if (path === '/v1/cloud/auth/capabilities') {
      return route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], commonGroundVersion: 3, commonGroundNearbyVersion: 1 } });
    }
    if (!path.startsWith('/v1/cloud/common-ground/')) return route.fallback();
    const body = request.postData() ? request.postDataJSON() as unknown : null;
    requests.push({ method, path, headers: request.headers(), body });
    const key = `${method} ${path.slice('/v1/cloud/common-ground/'.length)}`;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    switch (key) {
      case 'GET profiles': return json({ profiles: [profile()] });
      case 'GET card':
        if (building) [building, built] = [false, true];
        return json(owner());
      case 'GET documents': return json({ documents: [] });
      case 'GET rooms': return json({ rooms: [] });
      case 'GET recent': return json({ people: recent });
      case 'POST card/build':
        building = true;
        return json(owner(), 202);
      case 'POST pairings/code':
        return json({ code: ownPairCode, expiresAt: new Date(Date.now() + 120_000).toISOString(), profileId } satisfies CgPairCode, 201);
      case 'POST pairings/redeem':
        if (!recent.length) recent.push({ person: peer, score: 72, headline: 'Trail running', relationship, profileId, openedAt: timestamp });
        return json({ person: peer, card: syntheticTopics, relationship } satisfies CgPersonCard);
      case `GET people/${groundingPeerId}/match`: return json(match);
      case 'GET nearby': return json(nearby);
      case 'PUT nearby': {
        const patch = body as Partial<typeof nearby> & { consent?: boolean };
        nearby = { ...nearby, ...patch, alerts: { ...nearby.alerts, ...patch.alerts }, participating: patch.enabled ?? nearby.enabled,
          consentedAt: patch.consent ? timestamp : nearby.consentedAt };
        return json(nearby);
      }
      case 'POST nearby/location': {
        const capturedAt = (body as { capturedAt: string }).capturedAt;
        nearby = { ...nearby, location: { capturedAt, freshUntil: new Date(Date.parse(capturedAt) + 1_800_000).toISOString(), fresh: true } };
        return json({ location: nearby.location });
      }
      case 'GET nearby/people': return json({ people: [], matching: 0, location: nearby.location });
      case 'GET nearby/needs': return json({ needs: [] });
      default: return json({ errorCode: 'fixture_route_unavailable', message: 'Not in the synthetic Grounding fixture.' }, 404);
    }
  });
  return { requests, owner: account.accountId };
}

/**
 * One fresh synthetic position. Playwright's WebKit override sends milliseconds where
 * WebKit expects seconds, so its position timestamps are 1000x too large; stub both engines alike.
 */
export async function stubBrowserLocation(page: Page) {
  await page.addInitScript(() => {
    const position = () => ({ timestamp: Date.now(), coords: { latitude: 37.42751, longitude: -122.16972, accuracy: 30,
      altitude: null, altitudeAccuracy: null, heading: null, speed: null } });
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
      configurable: true,
      value: (success: PositionCallback) => { setTimeout(() => success(position() as unknown as GeolocationPosition), 0); },
    });
  });
}
