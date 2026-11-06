import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dismissMacAppPrompt, isMacDesktopBrowser, MAC_APP_PROMPT_SNOOZE_MS, MAC_DOWNLOAD_PATH, macAppPromptKey,
  macAppPromptVisible, macDownloadAvailable, readMacAppPromptDismissedAt, type MacAppPromptState,
} from '@/features/onboarding/macAppPromptRules';

const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const DAY = 24 * 60 * 60 * 1000;

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } } as unknown as Storage;
}

const ready: MacAppPromptState = { browserApp: true, macBrowser: true, signedIn: true, welcome: false, tour: false,
  helpOpen: false, invitationBusy: false, dismissedAt: null, now: 1_800_000_000_000 };

test('only a desktop Mac browser counts as a Mac', () => {
  assert.equal(isMacDesktopBrowser({ userAgent: MAC_CHROME, maxTouchPoints: 0 }), true);
  assert.equal(isMacDesktopBrowser({ userAgent: MAC_SAFARI, maxTouchPoints: 0 }), true);
  assert.equal(isMacDesktopBrowser({ userAgent: MAC_SAFARI, maxTouchPoints: 5 }), false, 'iPadOS reports a Mac user agent with touch');
  assert.equal(isMacDesktopBrowser({ userAgent: IPHONE, maxTouchPoints: 5 }), false);
  assert.equal(isMacDesktopBrowser({ userAgent: WINDOWS, maxTouchPoints: 0 }), false);
  assert.equal(isMacDesktopBrowser(undefined), false);
});

test('the platform hint wins over the user agent when present', () => {
  assert.equal(isMacDesktopBrowser({ userAgent: MAC_CHROME, maxTouchPoints: 0, userAgentData: { platform: 'macOS', mobile: false } }), true);
  assert.equal(isMacDesktopBrowser({ userAgent: MAC_CHROME, maxTouchPoints: 0, userAgentData: { platform: 'Windows' } }), false);
  assert.equal(isMacDesktopBrowser({ userAgent: WINDOWS, maxTouchPoints: 0, userAgentData: { platform: 'macOS' } }), true);
  assert.equal(isMacDesktopBrowser({ userAgent: MAC_CHROME, userAgentData: { platform: '' }, maxTouchPoints: 0 }), true, 'an empty hint falls back');
});

test('the Help menu row needs the browser app and a Mac browser', () => {
  assert.equal(macDownloadAvailable(true, { userAgent: MAC_CHROME, maxTouchPoints: 0 }), true);
  assert.equal(macDownloadAvailable(false, { userAgent: MAC_CHROME, maxTouchPoints: 0 }), false, 'never in the desktop app');
  assert.equal(macDownloadAvailable(true, { userAgent: WINDOWS, maxTouchPoints: 0 }), false);
  assert.equal(MAC_DOWNLOAD_PATH, '/download/mac');
});

test('the card shows only in the signed-in browser app on a Mac', () => {
  assert.equal(macAppPromptVisible(ready), true);
  assert.equal(macAppPromptVisible({ ...ready, browserApp: false }), false);
  assert.equal(macAppPromptVisible({ ...ready, macBrowser: false }), false);
  assert.equal(macAppPromptVisible({ ...ready, signedIn: false }), false);
});

test('the card waits for the welcome prompt, the tour, the Help menu and an invitation', () => {
  assert.equal(macAppPromptVisible({ ...ready, welcome: true }), false);
  assert.equal(macAppPromptVisible({ ...ready, tour: true }), false);
  assert.equal(macAppPromptVisible({ ...ready, helpOpen: true }), false);
  assert.equal(macAppPromptVisible({ ...ready, invitationBusy: true }), false);
});

test('a dismissal hides the card for seven days', () => {
  const now = ready.now!;
  assert.equal(MAC_APP_PROMPT_SNOOZE_MS, 7 * DAY);
  assert.equal(macAppPromptVisible({ ...ready, dismissedAt: now }), false);
  assert.equal(macAppPromptVisible({ ...ready, dismissedAt: now - 6 * DAY }), false);
  assert.equal(macAppPromptVisible({ ...ready, dismissedAt: now - 7 * DAY + 1 }), false);
  assert.equal(macAppPromptVisible({ ...ready, dismissedAt: now - 7 * DAY }), true);
  assert.equal(macAppPromptVisible({ ...ready, dismissedAt: now - 30 * DAY }), true);
});

test('the dismissal is stored per account and environment with a timestamp', () => {
  const storage = memoryStorage();
  const key = macAppPromptKey('acct_mac', 'https://app.kordi.test');
  assert.equal(readMacAppPromptDismissedAt(key, storage), null);
  assert.equal(dismissMacAppPrompt(key, 1_800_000_000_000, storage), true);
  assert.equal(readMacAppPromptDismissedAt(key, storage), 1_800_000_000_000);
  assert.equal(readMacAppPromptDismissedAt(macAppPromptKey('acct_other', 'https://app.kordi.test'), storage), null);
  assert.equal(readMacAppPromptDismissedAt(macAppPromptKey('acct_mac', 'https://other.kordi.test'), storage), null);
  storage.setItem(key, '{"dismissedAt":"soon"}');
  assert.equal(readMacAppPromptDismissedAt(key, storage), null, 'a malformed value shows the card again');
  storage.setItem(key, 'not json');
  assert.equal(readMacAppPromptDismissedAt(key, storage), null);
  assert.equal(dismissMacAppPrompt(key, 1, null), false, 'no storage, no crash');
});
