import type { MouseEvent as ReactMouseEvent } from 'react';

import { openDesktopExternalUrl } from '@/lib/desktop';
import { blobEmojiById, type BlobEmoji } from '@/features/emoji/blobEmoji';
import { notoEmojiRanges, type NotoEmoji } from '@/features/emoji/notoEmoji';
import { messageMentionsForText } from '@/features/chat/messageMentions';
import type { MessageMention } from '../types';

type ExternalMessageLinkClickEvent = Pick<ReactMouseEvent<HTMLAnchorElement>, 'preventDefault'> & {
  altKey?: boolean;
  button?: number;
  ctrlKey?: boolean;
  defaultPrevented?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

type ExternalMessageLinkOpener = (url: string) => unknown;

export type MessageInlinePart =
  | { type: 'text'; value: string; start: number }
  | { type: 'blobEmoji'; emoji: BlobEmoji; start: number }
  | { type: 'notoEmoji'; emoji: NotoEmoji; start: number }
  | { type: 'mention'; label: string; targetKind: 'agent' | 'person' | 'all'; targetIdentityId?: string | null; humanId?: string | null; start: number }
  | { type: 'link'; label: string; href: string; start: number };

type InlineRange =
  | { type: 'blobEmoji'; emoji: BlobEmoji; start: number; end: number }
  | { type: 'notoEmoji'; emoji: NotoEmoji; start: number; end: number }
  | { type: 'mention'; label: string; targetKind: 'agent' | 'person' | 'all'; targetIdentityId?: string | null; humanId?: string | null; start: number; end: number }
  | { type: 'link'; label: string; href: string; start: number; end: number };

export type SiteIconDescriptor = {
  hostname: string;
  requestUrl: string;
};

export type MessageLinkMatch = {
  href: string;
  label: string;
  matchedLength: number;
};

export const bareHttpUrlStartPattern = /https?:\/\//i;
const bareHttpUrlPattern = /https?:\/\/[^\s<>"']+/giu;
const trailingBareUrlPunctuationPattern = /[.,!?;:，。！？；：]+$/u;
const legacyMyKordiMentionPattern = /@My[ \t]+Kordi\b/giu;
const textualMentionPattern = /@[\p{L}\p{N}][\p{L}\p{N}._'-]{0,63}/gu;
const blobEmojiPattern = /:blob:([A-Za-z0-9_-]+):/gu;
const siteIconDescriptorCache = new Map<string, SiteIconDescriptor>();
const MAX_SITE_ICON_DESCRIPTOR_CACHE_ENTRIES = 256;

function countCharacter(value: string, target: string) {
  let count = 0;
  for (const character of value) {
    if (character === target) count += 1;
  }
  return count;
}

export function splitBareHttpUrl(value: string) {
  let href = value.replace(trailingBareUrlPunctuationPattern, '');
  const pairs = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const;

  let removedClosingDelimiter = true;
  while (removedClosingDelimiter && href) {
    removedClosingDelimiter = false;
    for (const [opening, closing] of pairs) {
      if (
        href.endsWith(closing)
        && countCharacter(href, closing) > countCharacter(href, opening)
      ) {
        href = href.slice(0, -1).replace(trailingBareUrlPunctuationPattern, '');
        removedClosingDelimiter = true;
        break;
      }
    }
  }

  return {
    href,
    suffix: value.slice(href.length),
  };
}

export function safeExternalHttpHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function compactExternalLinkLabel(label: string, href: string, maxLength = 48) {
  if (label !== href || label.length <= maxLength) return label;
  const url = new URL(href);
  const hostname = url.hostname.replace(/^www\./i, '');
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the encoded path when a sender supplied malformed percent escapes.
  }
  const leaf = path.split('/').filter(Boolean).pop() ?? '';
  if (/^[a-z\d]{20,}$/i.test(leaf)) return hostname;
  const compact = `${hostname}${path === '/' ? '' : path}`;
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function markdownHttpLinkPrefix(value: string): MessageLinkMatch | null {
  if (!value.startsWith('[')) return null;

  let escaped = false;
  for (let labelEnd = 1; labelEnd < value.length; labelEnd += 1) {
    const character = value[labelEnd];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== ']') continue;

    let destinationStart = labelEnd + 1;
    while (/\s/.test(value[destinationStart] ?? '')) destinationStart += 1;
    if (value[destinationStart] !== '(') continue;
    destinationStart += 1;

    let parenthesisDepth = 0;
    escaped = false;
    for (let cursor = destinationStart; cursor < value.length; cursor += 1) {
      const destinationCharacter = value[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (destinationCharacter === '\\') {
        escaped = true;
        continue;
      }
      if (/\s/.test(destinationCharacter)) break;
      if (destinationCharacter === '(') {
        parenthesisDepth += 1;
        continue;
      }
      if (destinationCharacter !== ')') continue;
      if (parenthesisDepth > 0) {
        parenthesisDepth -= 1;
        continue;
      }

      const href = safeExternalHttpHref(
        value.slice(destinationStart, cursor).replace(/\\([\\()])/g, '$1'),
      );
      if (!href) return null;
      return {
        href,
        label: value.slice(1, labelEnd).replace(/\\([\\[\]])/g, '$1'),
        matchedLength: cursor + 1,
      };
    }
  }

  return null;
}

export function firstExternalMessageLink(text: string): Omit<MessageLinkMatch, 'matchedLength'> | null {
  const visibleText = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');

  for (const candidate of visibleText.matchAll(/\[|https?:\/\//gi)) {
    const slice = visibleText.slice(candidate.index);
    const markdownLink = markdownHttpLinkPrefix(slice);
    if (markdownLink) {
      return { href: markdownLink.href, label: markdownLink.label };
    }
    const bare = slice.match(/^https?:\/\/[^\s<>"']+/i)?.[0];
    if (!bare) continue;
    const { href } = splitBareHttpUrl(bare);
    const safeHref = safeExternalHttpHref(href);
    if (safeHref) return { href: safeHref, label: href };
  }

  return null;
}

function rememberSiteIconDescriptor(hostname: string, descriptor: SiteIconDescriptor) {
  if (siteIconDescriptorCache.has(hostname)) siteIconDescriptorCache.delete(hostname);
  while (siteIconDescriptorCache.size >= MAX_SITE_ICON_DESCRIPTOR_CACHE_ENTRIES) {
    const oldest = siteIconDescriptorCache.keys().next().value;
    if (!oldest) break;
    siteIconDescriptorCache.delete(oldest);
  }
  siteIconDescriptorCache.set(hostname, descriptor);
  return descriptor;
}

export function siteIconDescriptorForHref(href: string): SiteIconDescriptor | null {
  const safeHref = safeExternalHttpHref(href);
  if (!safeHref) return null;
  try {
    const hostname = new URL(safeHref).hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname) return null;
    const cached = siteIconDescriptorCache.get(hostname);
    if (cached) {
      siteIconDescriptorCache.delete(hostname);
      siteIconDescriptorCache.set(hostname, cached);
      return cached;
    }
    const requestUrl = new URL('/favicon.ico', `https://${hostname}/`).href;
    return rememberSiteIconDescriptor(hostname, { hostname, requestUrl });
  } catch {
    return null;
  }
}

export function siteIconRequestUrl(href: string): string | null {
  return siteIconDescriptorForHref(href)?.requestUrl ?? null;
}

export function openExternalMessageLink(
  event: ExternalMessageLinkClickEvent,
  href: string,
  openExternalUrl: ExternalMessageLinkOpener = openDesktopExternalUrl,
) {
  const safeHref = safeExternalHttpHref(href);
  if (!safeHref) return false;
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }

  event.preventDefault();
  try {
    void Promise.resolve(openExternalUrl(safeHref)).catch(() => undefined);
  } catch {
    // The click remains handled when the native opener reports a synchronous failure.
  }
  return true;
}

function rangesOverlap(left: Pick<InlineRange, 'start' | 'end'>, right: Pick<InlineRange, 'start' | 'end'>) {
  return left.start < right.end && left.end > right.start;
}

function linkRanges(text: string): InlineRange[] {
  const ranges: InlineRange[] = [];
  for (const match of text.matchAll(bareHttpUrlPattern)) {
    const raw = match[0];
    const start = match.index;
    const { href } = splitBareHttpUrl(raw);
    const safeHref = safeExternalHttpHref(href);
    if (!safeHref) continue;
    ranges.push({
      type: 'link',
      label: href,
      href: safeHref,
      start,
      end: start + href.length,
    });
  }
  return ranges;
}

function blobEmojiRanges(text: string): InlineRange[] {
  const ranges: InlineRange[] = [];
  for (const match of text.matchAll(blobEmojiPattern)) {
    const emoji = blobEmojiById.get(match[1]);
    if (!emoji) continue;
    ranges.push({
      type: 'blobEmoji',
      emoji,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return ranges;
}

function isMentionBoundary(text: string, index: number, length: number) {
  const before = text[index - 1] ?? '';
  const after = text[index + length] ?? '';
  return (!before || !/[\p{L}\p{N}._%+-]/u.test(before))
    && (!after || !/[\p{L}\p{N}._'-]/u.test(after));
}

function inferredMentionTargetKind(label: string): 'agent' | 'person' {
  const normalized = label.replace(/^@/, '').normalize('NFKC').toLowerCase();
  return normalized === 'kordi' || normalized === 'mykordi' || normalized.endsWith('kordi')
    ? 'agent'
    : 'person';
}

function structuredMentionRanges(text: string, mentions: MessageMention[], reserved: InlineRange[]) {
  const ranges: InlineRange[] = [];
  const candidates = messageMentionsForText(text, mentions)?.map((mention) => {
    const targetKind: 'agent' | 'person' | 'all' = mention.targetKind === 'all'
      ? 'all'
      : mention.targetKind === 'agent' || mention.targetKind === 'person'
        ? mention.targetKind
        : inferredMentionTargetKind(mention.label);
    return {
      mention,
      targetKind,
      start: mention.startUtf16!,
      end: mention.startUtf16! + mention.lengthUtf16!,
    };
  }).sort((left, right) => left.start - right.start) ?? [];

  for (const { mention, targetKind, start, end } of candidates) {
    const candidate: InlineRange = {
      type: 'mention',
      label: text.slice(start, end),
      targetKind,
      targetIdentityId: mention.targetIdentityId,
      humanId: mention.humanId,
      start,
      end,
    };
    if (
      isMentionBoundary(text, start, end - start)
      && !reserved.some((range) => rangesOverlap(candidate, range))
      && !ranges.some((range) => rangesOverlap(candidate, range))
    ) {
      ranges.push(candidate);
    }
  }
  return ranges;
}

function textualMentionRanges(text: string, reserved: InlineRange[]) {
  const ranges: InlineRange[] = [];
  for (const pattern of [legacyMyKordiMentionPattern, textualMentionPattern]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const candidate: InlineRange = {
        type: 'mention',
        label: match[0],
        targetKind: inferredMentionTargetKind(match[0]),
        start,
        end: start + match[0].length,
      };
      if (
        isMentionBoundary(text, start, match[0].length)
        && !reserved.some((range) => rangesOverlap(candidate, range))
        && !ranges.some((range) => rangesOverlap(candidate, range))
      ) {
        ranges.push(candidate);
      }
    }
  }
  return ranges;
}

export function parseMessageInlineParts(text: string, mentions: MessageMention[] = []): MessageInlinePart[] {
  const links = linkRanges(text);
  const blobEmoji = blobEmojiRanges(text);
  const notoEmoji: InlineRange[] = notoEmojiRanges(text)
    .map((range) => ({ type: 'notoEmoji' as const, ...range }))
    .filter((range) => !links.some((link) => rangesOverlap(range, link)));
  const emojiRanges = [...blobEmoji, ...notoEmoji];
  const structuredMentions = structuredMentionRanges(text, mentions, [...links, ...emojiRanges]);
  const textualMentions = textualMentionRanges(text, [...links, ...emojiRanges, ...structuredMentions]);
  const mentionRanges = [...structuredMentions, ...textualMentions];
  const ranges = [...links, ...emojiRanges, ...mentionRanges].sort((left, right) => left.start - right.start);
  const parts: MessageInlinePart[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) {
      parts.push({ type: 'text', value: text.slice(cursor, range.start), start: cursor });
    }
    if (range.type === 'link') {
      parts.push({ type: 'link', label: range.label, href: range.href, start: range.start });
    } else if (range.type === 'blobEmoji') {
      parts.push({ type: 'blobEmoji', emoji: range.emoji, start: range.start });
    } else if (range.type === 'notoEmoji') {
      parts.push({ type: 'notoEmoji', emoji: range.emoji, start: range.start });
    } else {
      parts.push({
        type: 'mention',
        label: range.label,
        targetKind: range.targetKind,
        targetIdentityId: range.targetIdentityId,
        ...(range.humanId ? { humanId: range.humanId } : {}),
        start: range.start,
      });
    }
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor), start: cursor });
  return parts;
}
