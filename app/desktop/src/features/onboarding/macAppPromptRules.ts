import { resolvePreferenceStorage, readPreferenceStorageItem, writePreferenceStorageItem } from '@/features/cloud/preferenceStorage';

/** Same-origin path that the site redirects to the latest signed Mac installer. */
export const MAC_DOWNLOAD_PATH = '/download/mac';
export const MAC_APP_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

type BrowserNavigator = {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string; mobile?: boolean };
};

/**
 * A desktop Mac browser. iPadOS reports a Macintosh user agent, so a touch
 * screen rules it out when the browser has no platform hint.
 */
export function isMacDesktopBrowser(browser: BrowserNavigator | undefined = globalThis.navigator): boolean {
  if (!browser) return false;
  const platform = browser.userAgentData?.platform;
  if (platform) return platform === 'macOS' && browser.userAgentData?.mobile !== true;
  return /Macintosh/.test(browser.userAgent ?? '') && (browser.maxTouchPoints ?? 0) <= 1;
}

export function macAppPromptKey(accountId: string, environment: string) {
  return `kordi.mac-app-prompt.v1:${encodeURIComponent(environment)}:${encodeURIComponent(accountId)}`;
}

export function readMacAppPromptDismissedAt(key: string, storage = resolvePreferenceStorage()): number | null {
  try {
    const value: unknown = JSON.parse(storage ? readPreferenceStorageItem(storage, key) ?? 'null' : 'null');
    if (!value || typeof value !== 'object') return null;
    const dismissedAt = (value as Record<string, unknown>).dismissedAt;
    return typeof dismissedAt === 'number' && Number.isFinite(dismissedAt) ? dismissedAt : null;
  } catch { return null; }
}

export function dismissMacAppPrompt(key: string, now = Date.now(), storage = resolvePreferenceStorage()) {
  return storage ? writePreferenceStorageItem(storage, key, JSON.stringify({ dismissedAt: now })) : false;
}

export function macAppPromptSnoozed(dismissedAt: number | null, now = Date.now()) {
  // A clock moved backwards past the dismissal still counts as snoozed.
  return dismissedAt !== null && now - dismissedAt < MAC_APP_PROMPT_SNOOZE_MS;
}

export type MacAppPromptState = {
  browserApp: boolean;
  macBrowser: boolean;
  signedIn: boolean;
  /** "Get to know Kordi" is still waiting for an answer. */
  welcome: boolean;
  tour: boolean;
  helpOpen: boolean;
  invitationBusy: boolean;
  dismissedAt: number | null;
  now?: number;
};

/** The Mac card never shares the screen with first-run help or an invitation. */
export function macAppPromptVisible(state: MacAppPromptState) {
  return state.browserApp && state.macBrowser && state.signedIn
    && !state.welcome && !state.tour && !state.helpOpen && !state.invitationBusy
    && !macAppPromptSnoozed(state.dismissedAt, state.now);
}

/** The Help menu row follows the same browser and Mac rule, without the snooze. */
export function macDownloadAvailable(browserApp: boolean, browser?: BrowserNavigator) {
  return browserApp && isMacDesktopBrowser(browser);
}
