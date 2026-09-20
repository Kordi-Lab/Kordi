import { cloudApiBaseUrl } from '@/features/cloud/authClient';
import {
  readPreferenceStorageItem,
  resolvePreferenceStorage,
  writePreferenceStorageItem,
} from '@/features/cloud/preferenceStorage';

export const WHATS_NEW_LAST_SHOWN_VERSION_KEY = 'kordi.desktop.whatsNew.v1.lastShownVersion';

const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_RELEASE_NOTES_LENGTH = 16_384;
const MAX_VISIBLE_HIGHLIGHTS = 4;

export type WhatsNewRelease = {
  version: string;
  notes: string;
  publishedAt: string;
  changelogUrl?: string;
};

export type WhatsNewHighlightGroup = {
  title: string;
  items: string[];
};

export type WhatsNewHighlight = {
  category: string;
  title: string;
  detail?: string;
  kind: 'sign-in' | 'collaboration' | 'general';
};

export type WhatsNewRuntime = {
  isNativeShell: boolean;
  currentVersion: () => Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  storage?: Storage | null;
  signal?: AbortSignal;
};

const CURATED_RELEASE_HIGHLIGHTS: Readonly<Record<string, readonly WhatsNewHighlight[]>> = {
  '0.0.2-beta.3': [
    {
      category: 'Group planning',
      title: 'Turn conversations into shared plans with PiP',
      detail: 'PiP creates current, confirmable plan cards from group context and keeps participants and status in sync.',
      kind: 'collaboration',
    },
    {
      category: 'Voice messages',
      title: 'Send voice messages without waiting for transcription',
      detail: 'Mac and iPhone send recordings immediately while transcription completes, and iPhone hold-to-talk starts faster.',
      kind: 'general',
    },
    {
      category: 'Discussions and replies',
      title: 'Quote messages or open a focused discussion',
      detail: 'Clearer reply actions, steadier message layout, and refined bubble tails make conversation threads easier to follow.',
      kind: 'collaboration',
    },
    {
      category: 'Reliable agents',
      title: 'Use an available provider automatically',
      detail: 'Agent and group sessions recover stale routes by selecting a configured provider and compatible model without showing a false no-provider error.',
      kind: 'general',
    },
  ],
  '0.0.2-beta.2': [
    {
      category: 'Desktop chats',
      title: 'Keep your place in longer conversations',
      detail: 'Older history loads more steadily, media previews reuse loaded images, and unread replies stay in order.',
      kind: 'general',
    },
    {
      category: 'Local agents',
      title: 'Continue working in the folder you chose',
      detail: 'Workspace selection survives follow-ups and resumed sessions. Owner-only macOS application automation is now available.',
      kind: 'general',
    },
    {
      category: 'iPhone messages',
      title: 'React to individual photos',
      detail: 'Each photo has its own reaction and deletion controls, with steadier message menus and chat scrolling.',
      kind: 'general',
    },
    {
      category: 'History and notifications',
      title: 'Pick up conversations with less clutter',
      detail: 'History recovery avoids repeat uploads and preserves original dates on iPhone. Read messages clear their delivered iPhone notifications.',
      kind: 'general',
    },
  ],
  '0.0.1-beta.14': [
    {
      category: 'Large attachments',
      title: 'Large files upload without freezing the composer',
      detail: 'Resumable uploads support files up to 2 GiB with progress, cancellation, retry, and restart recovery.',
      kind: 'general',
    },
    {
      category: 'Shared identity',
      title: 'People and agents keep the same avatar everywhere',
      detail: 'Canonical avatars now stay consistent across Factory, conversations, mentions, profiles, calls, macOS, and iOS.',
      kind: 'collaboration',
    },
    {
      category: 'iPhone navigation',
      title: 'Agents and Account are now first-class destinations',
      detail: 'Root tabs, full-page destinations, and compact floating menus make frequent iPhone workflows easier to reach.',
      kind: 'general',
    },
    {
      category: 'Reliable agents and calls',
      title: 'Factory sessions, Support, and calls converge cleanly',
      detail: 'Agent identity and routing persist correctly, while call state resists delayed events and reports clearer media diagnostics.',
      kind: 'collaboration',
    },
  ],
  '0.0.1-beta.13': [
    {
      category: 'iPhone companion',
      title: 'Your chats, agents, calls, and media now travel with you',
      detail: 'The native iPhone app now includes Contact and Agent conversations, Digest, Ask Agent, calls, session details, expressive media, profiles, and presence.',
      kind: 'general',
    },
    {
      category: 'Reliable collaboration',
      title: 'Chats and agent work converge cleanly across devices',
      detail: 'Reliable sync v2 keeps messages, group handoffs, agent replies, read state, and runtime routes consistent without duplicate execution.',
      kind: 'collaboration',
    },
    {
      category: 'Calls and devices',
      title: 'Review active devices and start native calls',
      detail: 'Manage signed-in installations and use synchronized audio, video, and group-call history across macOS and iOS.',
      kind: 'collaboration',
    },
    {
      category: 'Chat polish',
      title: 'Messages stay compact, readable, and correctly delivered',
      detail: 'Refined composer behavior, mentions, partial agent output, receipts, media previews, scrolling, timestamps, and expandable tool activity.',
      kind: 'general',
    },
  ],
  '0.0.1-beta.12': [
    {
      category: 'Sign in',
      title: 'Social sign-in stays available in packaged Cloud builds',
      detail: 'Google and GitHub sign-in remain available when capability discovery is unavailable. Debug-only server guidance no longer leaks into the user build.',
      kind: 'sign-in',
    },
    {
      category: 'Group collaboration',
      title: 'Group agents can mention people and their Kordi agents',
      detail: 'Mentions now carry authorization, attribution, and reply-history handling across the shared conversation.',
      kind: 'collaboration',
    },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedVersion(value: unknown) {
  if (typeof value !== 'string') return null;
  const version = value.trim();
  return SEMANTIC_VERSION.test(version) ? version : null;
}

function safeChangelogUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function parseWhatsNewRelease(value: unknown, expectedVersion: string): WhatsNewRelease | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const version = normalizedVersion(value.version);
  const notes = typeof value.notes === 'string' ? value.notes.trim() : '';
  const publishedAt = typeof value.pubDate === 'string' ? value.pubDate.trim() : '';
  if (
    version !== expectedVersion
    || !notes
    || notes.length > MAX_RELEASE_NOTES_LENGTH
    || !publishedAt
    || Number.isNaN(Date.parse(publishedAt))
  ) {
    return null;
  }
  return {
    version,
    notes,
    publishedAt,
    changelogUrl: safeChangelogUrl(value.changelogUrl),
  };
}

export function whatsNewRequestUrl(version: string, baseUrl = cloudApiBaseUrl()) {
  const normalized = normalizedVersion(version);
  if (!normalized) throw new Error('Installed Kordi version is invalid.');
  return new URL(
    `/updates/releases/${encodeURIComponent(normalized)}/metadata`,
    baseUrl,
  ).toString();
}

export async function fetchWhatsNewRelease(
  version: string,
  options: Pick<WhatsNewRuntime, 'fetchImpl' | 'baseUrl' | 'signal'> = {},
) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  const response = await fetchImpl(whatsNewRequestUrl(version, options.baseUrl), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: options.signal,
  });
  if (!response.ok) return null;
  return parseWhatsNewRelease(await response.json(), version);
}

export async function loadWhatsNewRelease(runtime: WhatsNewRuntime): Promise<WhatsNewRelease | null> {
  if (!runtime.isNativeShell) return null;
  try {
    const version = normalizedVersion(await runtime.currentVersion());
    if (!version) return null;
    const storage = runtime.storage === undefined
      ? resolvePreferenceStorage()
      : runtime.storage;
    if (
      storage
      && readPreferenceStorageItem(storage, WHATS_NEW_LAST_SHOWN_VERSION_KEY) === version
    ) {
      return null;
    }
    return await fetchWhatsNewRelease(version, runtime);
  } catch {
    return null;
  }
}

export function markWhatsNewPresented(
  release: Pick<WhatsNewRelease, 'version'>,
  storage: Storage | null = resolvePreferenceStorage(),
) {
  if (!storage) return false;
  return writePreferenceStorageItem(
    storage,
    WHATS_NEW_LAST_SHOWN_VERSION_KEY,
    release.version,
  );
}

function cleanReleaseNoteText(value: string) {
  return value
    .replace(/\[([^\]]+)]\([^\s)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s*\(\s*(?:\[#\d+]\s*(?:,\s*)?)+\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function highlightKind(category: string, item: string): WhatsNewHighlight['kind'] {
  const text = `${category} ${item}`.toLowerCase();
  if (/sign[ -]?in|auth|google|github/.test(text)) return 'sign-in';
  if (/group|mention|collaborat|participant/.test(text)) return 'collaboration';
  return 'general';
}

function splitHighlightText(value: string) {
  const match = value.match(/^(.+?[.!?])(?:\s+|$)(.*)$/);
  if (!match || !match[2]) return { title: value };
  return { title: match[1], detail: match[2] };
}

export function releaseHighlights(release: WhatsNewRelease): WhatsNewHighlight[] {
  const curated = CURATED_RELEASE_HIGHLIGHTS[release.version];
  if (curated) return curated.map((highlight) => ({ ...highlight }));

  return releaseHighlightGroups(release.notes)
    .flatMap((group) => group.items.map((item) => ({
      category: group.title,
      ...splitHighlightText(item),
      kind: highlightKind(group.title, item),
    })))
    .slice(0, MAX_VISIBLE_HIGHLIGHTS);
}

export function releaseHighlightGroups(notes: string): WhatsNewHighlightGroup[] {
  const groups: WhatsNewHighlightGroup[] = [];
  let current: WhatsNewHighlightGroup | null = null;
  let lastItemIndex = -1;

  const ensureGroup = () => {
    current ??= { title: 'Highlights', items: [] };
    if (!groups.includes(current)) groups.push(current);
    return current;
  };

  for (const rawLine of notes.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/)?.[1];
    if (heading) {
      current = { title: cleanReleaseNoteText(heading), items: [] };
      groups.push(current);
      lastItemIndex = -1;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)?.[1];
    if (bullet) {
      const group = ensureGroup();
      const item = cleanReleaseNoteText(bullet);
      if (item) {
        group.items.push(item);
        lastItemIndex = group.items.length - 1;
      }
      continue;
    }
    const text = cleanReleaseNoteText(line);
    if (!text) continue;
    const group = ensureGroup();
    if (lastItemIndex >= 0) {
      group.items[lastItemIndex] = `${group.items[lastItemIndex]} ${text}`;
    } else {
      group.items.push(text);
      lastItemIndex = group.items.length - 1;
    }
  }

  return groups.filter((group) => group.title && group.items.length > 0);
}
