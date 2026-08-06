import type { MouseEvent as ReactMouseEvent } from 'react';

import { openDesktopExternalUrl } from '@/lib/desktop';
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
  | { type: 'mention'; label: string; targetKind: 'agent' | 'person'; start: number }
  | { type: 'link'; label: string; href: string; start: number };

type InlineRange =
  | { type: 'mention'; label: string; targetKind: 'agent' | 'person'; start: number; end: number }
  | { type: 'link'; label: string; href: string; start: number; end: number };

export type SiteIconDescriptor = {
  hostname: string;
  requestUrl: string;
};

export const bareHttpUrlStartPattern = /https?:\/\//i;
const bareHttpUrlPattern = /https?:\/\/[^\s<>"']+/giu;
const trailingBareUrlPunctuationPattern = /[.,!?;:，。！？；：]+$/u;
const textualMentionPattern = /@[\p{L}\p{N}][\p{L}\p{N}._'-]{0,63}/gu;
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
  const labels = mentions
    .map((mention) => mention.label.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const normalizedText = text.toLowerCase();

  for (const label of labels) {
    const needle = `@${label}`;
    const structuredMention = mentions.find((mention) => mention.label.trim().toLowerCase() === label.toLowerCase());
    const targetKind = structuredMention?.targetKind === 'agent' || structuredMention?.targetKind === 'person'
      ? structuredMention.targetKind
      : inferredMentionTargetKind(needle);
    const normalizedNeedle = needle.toLowerCase();
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const start = normalizedText.indexOf(normalizedNeedle, searchFrom);
      if (start === -1) break;
      const candidate: InlineRange = {
        type: 'mention',
        label: needle,
        targetKind,
        start,
        end: start + needle.length,
      };
      if (
        isMentionBoundary(text, start, needle.length)
        && !reserved.some((range) => rangesOverlap(candidate, range))
        && !ranges.some((range) => rangesOverlap(candidate, range))
      ) {
        ranges.push(candidate);
      }
      searchFrom = candidate.end;
    }
  }
  return ranges;
}

function textualMentionRanges(text: string, reserved: InlineRange[]) {
  const ranges: InlineRange[] = [];
  for (const match of text.matchAll(textualMentionPattern)) {
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
    ) {
      ranges.push(candidate);
    }
  }
  return ranges;
}

export function parseMessageInlineParts(text: string, mentions: MessageMention[] = []): MessageInlinePart[] {
  const links = linkRanges(text);
  const structuredMentions = structuredMentionRanges(text, mentions, links);
  const textualMentions = textualMentionRanges(text, [...links, ...structuredMentions]);
  const mentionRanges = [...structuredMentions, ...textualMentions];
  const ranges = [...links, ...mentionRanges].sort((left, right) => left.start - right.start);
  const parts: MessageInlinePart[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) {
      parts.push({ type: 'text', value: text.slice(cursor, range.start), start: cursor });
    }
    if (range.type === 'link') {
      parts.push({ type: 'link', label: range.label, href: range.href, start: range.start });
    } else {
      parts.push({ type: 'mention', label: range.label, targetKind: range.targetKind, start: range.start });
    }
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor), start: cursor });
  return parts;
}
