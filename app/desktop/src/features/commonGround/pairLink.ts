// Pairing codes and the `kordi://common-ground/pair/<code>` link. No Tauri imports, so the
// parser and the pending-code handoff can be tested and shared by the app shell and the page.

/** Characters in a pairing code, without the separator. */
export const PAIR_CODE_CHARS = 8;

/** Fired on `window` when a pairing link arrives; Contacts opens Grounding. */
export const COMMON_GROUND_PAIR_LINK_EVENT = 'kordi-common-ground-pair-link';

/**
 * Upper case without separators, as the server reads codes: O reads as 0, and I and L as 1.
 */
export function normalizePairCode(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** `K4M7-2QXA` from any spelling of a full code; null when it is not one. */
export function displayPairCode(value: string): string | null {
  const code = normalizePairCode(value);
  return code.length === PAIR_CODE_CHARS ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
}

/** The link a QR code carries. */
export function pairLinkUrl(code: string): string {
  return `kordi://common-ground/pair/${encodeURIComponent(code)}`;
}

/** The code in a `kordi://common-ground/pair/<code>` link, displayed; null for anything else. */
export function pairCodeFromUrl(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'kordi:' || url.hostname !== 'common-ground') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0] !== 'pair') return null;
    return displayPairCode(decodeURIComponent(parts[1]));
  } catch {
    return null;
  }
}

// The newest code from a link, kept until the Grounding page takes it. Contacts and the page
// load after the link arrives, so the code waits here rather than only in the event.
let pending: string | null = null;

/** Keeps the code from a pairing link and announces it; false when the link is not one. */
export function rememberPairLink(value: string | null | undefined, target: EventTarget | null = typeof window === 'undefined' ? null : window): boolean {
  const code = pairCodeFromUrl(value);
  if (!code) return false;
  pending = code;
  target?.dispatchEvent(new CustomEvent<string>(COMMON_GROUND_PAIR_LINK_EVENT, { detail: code }));
  return true;
}

export function hasPendingPairLink(): boolean {
  return pending !== null;
}

/** The waiting code, once. */
export function takePendingPairLink(): string | null {
  const code = pending;
  pending = null;
  return code;
}
