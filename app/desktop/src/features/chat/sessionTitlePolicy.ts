export const SESSION_TITLE_POLICY_VERSION = 1;
export const MAX_SESSION_TITLE_GRAPHEMES = 48;

const SESSION_TITLE_CACHE_LIMIT = 512;
const SESSION_TITLE_CACHE_MAX_SOURCE_LENGTH = 4_096;

export type SessionTitleSource = 'placeholder' | 'auto' | 'imported' | 'external' | 'legacy' | 'manual';

type SegmenterLike = {
  segment(value: string): Iterable<{ segment: string }>;
};

type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' },
) => SegmenterLike;

const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
const graphemeSegmenter = Segmenter
  ? new Segmenter(undefined, { granularity: 'grapheme' })
  : null;
const sessionTitleCache = new Map<string, string | null>();

function graphemes(value: string) {
  if (!graphemeSegmenter) return Array.from(value);
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function truncateTitle(value: string) {
  // A UTF-16 string cannot contain more grapheme clusters than code units. Most
  // titles are short, so avoid entering the comparatively expensive ICU
  // segmenter unless truncation is actually possible.
  if (value.length <= MAX_SESSION_TITLE_GRAPHEMES) return value;
  const segments = graphemes(value);
  if (segments.length <= MAX_SESSION_TITLE_GRAPHEMES) return value;
  return `${segments.slice(0, MAX_SESSION_TITLE_GRAPHEMES - 1).join('')}…`;
}

function withoutReplyAndCodeContext(value: string) {
  let inCodeFence = false;
  return value
    .split(/\r?\n/u)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (/^(?:```|~~~)/u.test(trimmed)) {
        inCodeFence = !inCodeFence;
        return [];
      }
      if (
        inCodeFence
        || trimmed.startsWith('>')
        || /^(?:replying to|quoted message):/iu.test(trimmed)
      ) return [];
      return [trimmed];
    })
    .join(' ');
}

function isUrlOrPathToken(token: string) {
  return /^(?:https?:\/\/|www\.|\.\.?\/|~\/|\/[^/]|[a-z]:[\\/])/iu.test(token);
}

function removeTransportNoise(value: string) {
  const tokens = value.trim().split(/\s+/u).filter(Boolean);
  if (tokens[0]?.startsWith('/')) tokens.shift();
  while (tokens[0]?.startsWith('@')) tokens.shift();
  const cleaned: string[] = [];
  let insideAttachment = false;
  let skipAttachmentValue = false;
  for (const token of tokens) {
    if (insideAttachment) {
      if (token.endsWith(']')) insideAttachment = false;
      continue;
    }
    if (/^\[attachment:/iu.test(token)) {
      insideAttachment = !token.endsWith(']');
      continue;
    }
    if (skipAttachmentValue) {
      skipAttachmentValue = false;
      continue;
    }
    if (/^(?:attached|attachment:)$/iu.test(token)) {
      skipAttachmentValue = true;
      continue;
    }
    if (!isUrlOrPathToken(token)) cleaned.push(token);
  }
  return cleaned.join(' ');
}

function informationProbe(value: string) {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLocaleLowerCase();
}

function isAttachmentBoilerplate(value: string) {
  const trimmed = value.trim();
  return /^(?:attached\s+|attachment:)/iu.test(trimmed)
    && trimmed.split(/\s+/u).filter(Boolean).length <= 3;
}

export function isLowInformationSessionSeed(value: string) {
  const probe = informationProbe(value);
  if (!probe || /^\p{N}+$/u.test(probe) || !/[\p{L}\p{N}]/u.test(probe)) return true;
  return new Set([
    'hi', 'hii', 'hiii', 'hiiii', 'hello', 'helloo', 'hey', 'heyy', 'yo', 'sup',
    'test', 'testing', 'testmessage', 'testreply', 'ok', 'okay', 'k', 'yes', 'yep', 'sure',
    'thanks', 'thankyou', 'gotit', 'kordi', 'mykordi', 'myagent', 'newchat', 'newsession',
    'hithere', 'hellothere', 'howareyou', 'hihowareyou', 'hellohowareyou',
    'howcanihelp', 'hihowcanihelp', 'hellohowcanihelp',
    '\u4F60\u597D', '\u60A8\u597D', '\u55E8', '\u6D4B\u8BD5',
    '\u6536\u5230', '\u597D\u7684', '\u8C22\u8C22',
    '\u4F60\u597D\u5417', '\u4F60\u597D\u55CE',
  ]).has(probe) || /^test(?:reply|message)?\p{N}+$/u.test(probe);
}

function knownSemanticTitle(value: string) {
  const lower = value.toLocaleLowerCase();
  if (
    lower.includes('\u6A21\u578B')
    && (
      lower.includes('\u8C01')
      || lower.includes('\u8EAB\u4EFD')
      || lower.includes('\u4F60\u662F')
    )
  ) {
    return '\u6A21\u578B\u4E0E\u8EAB\u4EFD';
  }
  if (lower.includes('model') && /who are you|which model|what model|identity/u.test(lower)) {
    return 'Model and identity';
  }
  if (lower.includes('node') && lower.includes('cpu') && lower.includes('diagnos')) {
    return 'Diagnose high Node CPU';
  }
  return null;
}

export function isKnownLegacyAutoTitle(value: string) {
  const trimmed = value.trim();
  const semantic = knownSemanticTitle(trimmed);
  return isLowInformationSessionSeed(trimmed)
    || isAttachmentBoilerplate(trimmed)
    || (semantic !== null && semantic.toLocaleLowerCase() !== trimmed.toLocaleLowerCase());
}

function capitalizeFirstAscii(value: string) {
  return /^[a-z]/u.test(value) ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function deriveSessionTitleUncached(value: string): string | null {
  const withoutContext = withoutReplyAndCodeContext(value);
  if (isAttachmentBoilerplate(withoutContext)) return null;
  const cleaned = removeTransportNoise(withoutContext)
    .replace(/^[\s.,:;!?。，：；！？_`'"()[\]{}-]+|[\s.,:;!?。，：；！？_`'"()[\]{}-]+$/gu, '')
    .trim();
  if (isLowInformationSessionSeed(cleaned)) return null;
  const semantic = knownSemanticTitle(cleaned);
  if (semantic) return semantic;

  const words = cleaned.split(/\s+/u).filter(Boolean);
  while (/^(?:please|help|hey|hello)$/iu.test(words[0] ?? '')) words.shift();
  const concise = words.slice(0, 8).join(' ').trim();
  if (!concise || isLowInformationSessionSeed(concise)) return null;
  return truncateTitle(capitalizeFirstAscii(concise));
}

export function deriveSessionTitle(value: string): string | null {
  if (value.length > SESSION_TITLE_CACHE_MAX_SOURCE_LENGTH) {
    return deriveSessionTitleUncached(value);
  }

  if (sessionTitleCache.has(value)) {
    const cached = sessionTitleCache.get(value) ?? null;
    sessionTitleCache.delete(value);
    sessionTitleCache.set(value, cached);
    return cached;
  }

  const derived = deriveSessionTitleUncached(value);
  sessionTitleCache.set(value, derived);
  if (sessionTitleCache.size > SESSION_TITLE_CACHE_LIMIT) {
    const oldest = sessionTitleCache.keys().next().value;
    if (oldest !== undefined) sessionTitleCache.delete(oldest);
  }
  return derived;
}

export function legacySessionTitleFromMessageText(value?: string | null) {
  const text = value?.trim().split(/\s+/u).filter(Boolean).slice(0, 8).join(' ')
    .slice(0, 60).trim();
  return text || null;
}

export function attachmentSessionTitle(count: number, containsImage = false) {
  if (count <= 0) return null;
  if (count === 1) return containsImage ? 'Image attachment' : 'File attachment';
  return `${count} attachments`;
}

export function optimisticSessionTitle(
  messageText: string,
  attachments: Array<{ kind?: string | null; mimeType?: string | null }>,
  fallbackTitle: string,
) {
  return deriveSessionTitle(messageText)
    ?? attachmentSessionTitle(
      attachments.length,
      attachments.some((attachment) => attachment.kind === 'image' || attachment.mimeType?.startsWith('image/')),
    )
    ?? fallbackTitle;
}

export function titleSourceFromMetadata(metadata: Record<string, unknown>, title?: string | null): SessionTitleSource {
  const value = [metadata.sessionTitleSource, metadata.titleSource]
    .find((candidate): candidate is string => typeof candidate === 'string')
    ?.trim()
    .toLowerCase();
  if (value && ['placeholder', 'auto', 'imported', 'external', 'legacy', 'manual'].includes(value)) {
    if ((value === 'auto' || value === 'legacy') && isGenericSessionTitle(title)) {
      return 'placeholder';
    }
    return value as SessionTitleSource;
  }
  return isGenericSessionTitle(title) ? 'placeholder' : 'legacy';
}

export function titleSourcePrecedence(source: SessionTitleSource) {
  if (source === 'manual') return 4;
  if (source === 'imported' || source === 'external') return 3;
  if (source === 'legacy') return 2;
  if (source === 'auto') return 1;
  return 0;
}

export function incomingSessionTitleWins(
  existing: {
    titleSource: SessionTitleSource;
    titleRevision: number;
    updatedAtMs: number;
    updatedByAccountId?: string | null;
  },
  incoming: {
    titleSource: SessionTitleSource;
    titleRevision: number;
    updatedAtMs: number;
    updatedByAccountId?: string | null;
  },
) {
  const existingRank = titleSourcePrecedence(existing.titleSource);
  const incomingRank = titleSourcePrecedence(incoming.titleSource);
  if (incomingRank !== existingRank) return incomingRank > existingRank;
  if (incoming.titleSource === 'auto') {
    return incoming.titleRevision > existing.titleRevision && incoming.titleRevision <= 2;
  }
  if (['manual', 'imported', 'external', 'legacy'].includes(incoming.titleSource)) {
    const existingActor = existing.updatedByAccountId?.trim() ?? '';
    const incomingActor = incoming.updatedByAccountId?.trim() ?? '';
    return incoming.updatedAtMs > existing.updatedAtMs
      || (incoming.updatedAtMs === existing.updatedAtMs
        && (incoming.titleRevision > existing.titleRevision
          || (incoming.titleRevision === existing.titleRevision
            && Boolean(incomingActor)
            && (!existingActor || incomingActor < existingActor))));
  }
  return false;
}

export function sessionTitleMetadata(
  source: SessionTitleSource,
  options: { revision?: number; updatedAtMs?: number; generatedFromMessageId?: string | null } = {},
) {
  const revision = options.revision ?? (source === 'placeholder' ? 0 : 1);
  return {
    sessionTitleSource: source,
    titleSource: source,
    sessionTitleRevision: revision,
    sessionTitlePolicyVersion: SESSION_TITLE_POLICY_VERSION,
    sessionTitleUpdatedAtMs: options.updatedAtMs ?? Date.now(),
    ...(options.generatedFromMessageId ? { sessionTitleGeneratedFromMessageId: options.generatedFromMessageId } : {}),
  };
}

export function isGenericSessionTitle(value?: string | null) {
  const title = value?.trim() ?? '';
  return isExplicitPlaceholderSessionTitle(title)
    || isRawSessionIdentifier(title)
    || isKnownLegacyAutoTitle(title);
}

export function isExplicitPlaceholderSessionTitle(value?: string | null) {
  const title = value?.trim() ?? '';
  return !title
    || /^(?:#\s*)?(?:new (?:session|chat|fork)|untitled session|session)$/iu.test(title);
}

export function isRawSessionIdentifier(value?: string | null) {
  const trimmed = value?.trim() ?? '';
  return /^session:/iu.test(trimmed)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(trimmed);
}
