import { Fragment } from 'react';

import type { MessageMention } from '../types';
import { cn } from '@/lib/utils';
import { ExternalMessageLink, MessageInlineContent } from './messageInlineContent';
import {
  bareHttpUrlStartPattern,
  compactExternalLinkLabel,
  markdownHttpLinkPrefix,
  safeExternalHttpHref,
  splitBareHttpUrl,
} from './messageLinks';

type MarkdownInlinePart =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'em'; value: string }
  | { type: 'strongEm'; value: string }
  | { type: 'link'; label: string; href: string };

export type MarkdownTone = 'default' | 'muted' | 'inherit';

export type MarkdownInlineOptions = {
  tone?: MarkdownTone;
  showLinkIcons?: boolean;
  mentions?: MessageMention[];
  onOpenMention?: (mention: MessageMention, anchorRect: DOMRect) => void;
};

function nextInlineTokenIndex(slice: string) {
  return ['[', '`', '*', '_', '\\'].map((token) => slice.indexOf(token)).concat(slice.search(bareHttpUrlStartPattern))
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0];
}

function emphasisDelimiter(text: string, index: number) {
  const marker = text[index];
  if (marker !== '*' && marker !== '_') return null;
  let end = index + 1;
  while (text[end] === marker) end += 1;
  const before = text[index - 1] ?? '';
  const after = text[end] ?? '';
  const beforeSpace = !before || /\s/u.test(before);
  const afterSpace = !after || /\s/u.test(after);
  const beforePunctuation = /[\p{P}\p{S}]/u.test(before);
  const afterPunctuation = /[\p{P}\p{S}]/u.test(after);
  const leftFlanking = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
  const rightFlanking = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
  return {
    marker,
    length: end - index,
    canOpen: leftFlanking && (marker === '*' || !rightFlanking || beforePunctuation),
    canClose: rightFlanking && (marker === '*' || !leftFlanking || afterPunctuation),
  };
}

function emphasisMatches(text: string) {
  type Opening = NonNullable<ReturnType<typeof emphasisDelimiter>> & { start: number; depth: number };
  type Match = { type: 'strongEm' | 'strong' | 'em'; value: string; matchedLength: number };
  const matches = new Map<number, Match>();
  const pending: Opening[] = [];
  const byMarker: Record<string, Opening[]> = { '*': [], '_': [] };
  let cursor = 0;

  // Match all delimiters once, including failed openers. Rescanning the remaining
  // message for each unmatched opener makes incomplete streamed text quadratic.
  while (cursor < text.length) {
    const slice = text.slice(cursor);
    const opaqueLength = markdownHttpLinkPrefix(slice)?.matchedLength ?? slice.match(/^`[^`]+`/)?.[0].length;
    if (opaqueLength) {
      cursor += opaqueLength;
      continue;
    }
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    const delimiter = emphasisDelimiter(text, cursor);
    if (!delimiter) {
      cursor += 1;
      continue;
    }
    let consumed = 0;
    if (delimiter.canClose) {
      const candidates = byMarker[delimiter.marker];
      while (candidates.length) {
        const opening = candidates[candidates.length - 1];
        if (opening.length > delimiter.length - consumed) break;
        // Unmatched delimiters of another kind remain literal inside the wrapper.
        while (pending.length > opening.depth) {
          const removed = pending.pop()!;
          byMarker[removed.marker].pop();
        }
        matches.set(opening.start, {
          type: opening.length === 3 ? 'strongEm' : opening.length === 2 ? 'strong' : 'em',
          value: text.slice(opening.start + opening.length, cursor + consumed),
          matchedLength: cursor + consumed + opening.length - opening.start,
        });
        consumed += opening.length;
      }
    }
    if (!consumed && delimiter.canOpen && delimiter.length <= 3) {
      const opening = { ...delimiter, start: cursor, depth: pending.length };
      pending.push(opening);
      byMarker[delimiter.marker].push(opening);
    }
    cursor += delimiter.length;
  }
  return matches;
}

function parseInlineMarkdown(text: string): MarkdownInlinePart[] {
  const parts: MarkdownInlinePart[] = [];
  const emphasisByStart = emphasisMatches(text);
  let index = 0;

  while (index < text.length) {
    const slice = text.slice(index);
    const escaped = slice.match(/^\\([\\`*_[\]])/);
    if (escaped) {
      parts.push({ type: 'text', value: escaped[1] });
      index += escaped[0].length;
      continue;
    }
    const markdownLink = markdownHttpLinkPrefix(slice);
    if (markdownLink) {
      parts.push({ type: 'link', label: markdownLink.label, href: markdownLink.href });
      index += markdownLink.matchedLength;
      continue;
    }
    const emphasis = emphasisByStart.get(index);
    if (emphasis) {
      parts.push({ type: emphasis.type, value: emphasis.value });
      index += emphasis.matchedLength;
      continue;
    }
    const patterns = [
      { type: 'bareLink' as const, match: slice.match(/^https?:\/\/[^\s<>"']+/i) },
      { type: 'code' as const, match: slice.match(/^`([^`]+)`/) },
    ];
    const hit = patterns.find((entry) => entry.match);

    if (!hit?.match) {
      const nextIndex = nextInlineTokenIndex(slice);
      if (nextIndex === undefined) {
        parts.push({ type: 'text', value: text.slice(index) });
        break;
      }
      if (nextIndex === 0) {
        const literalLength = emphasisDelimiter(text, index)?.length ?? 1;
        parts.push({ type: 'text', value: slice.slice(0, literalLength) });
        index += literalLength;
        continue;
      }
      const endIndex = index + nextIndex;
      parts.push({ type: 'text', value: text.slice(index, endIndex) });
      index = endIndex;
      continue;
    }

    const [matched, first] = hit.match;
    if (hit.type === 'bareLink') {
      const { href, suffix } = splitBareHttpUrl(matched);
      const safeHref = safeExternalHttpHref(href);
      parts.push(safeHref
        ? { type: 'link', label: href, href: safeHref }
        : { type: 'text', value: href });
      if (suffix) parts.push({ type: 'text', value: suffix });
    } else {
      parts.push({ type: 'code', value: first });
    }
    index += matched.length;
  }

  // Keep literal token boundaries invisible to mention and emoji recognition.
  return parts.reduce<MarkdownInlinePart[]>((merged, part) => {
    const previous = merged[merged.length - 1];
    if (previous?.type === 'text' && part.type === 'text') previous.value += part.value;
    else merged.push(part);
    return merged;
  }, []);
}

export function MarkdownInlineContent({
  text,
  tone = 'default',
  showLinkIcons = false,
  mentions,
  onOpenMention,
}: { text: string } & MarkdownInlineOptions) {
  return parseInlineMarkdown(text).map((part, index) => {
    if (part.type === 'code') {
      return (
        <code
          key={`code-${index}`}
          className={cn(
            'rounded bg-[color:var(--app-control-bg)] px-1.5 py-0.5 font-mono text-[0.92em]',
            tone === 'inherit' ? undefined : tone === 'muted' ? 'text-slate-200' : 'text-slate-100',
          )}
        >
          {part.value}
        </code>
      );
    }
    if (part.type === 'strong' || part.type === 'strongEm') {
      const content = <MarkdownInlineContent text={part.value} tone={tone} mentions={mentions} onOpenMention={onOpenMention} showLinkIcons={showLinkIcons} />;
      return (
        <strong key={`strong-${index}`} className={cn('font-semibold', tone === 'inherit' ? undefined : tone === 'muted' ? 'text-slate-100' : 'text-white')}>
          {part.type === 'strongEm' ? <em className="italic">{content}</em> : content}
        </strong>
      );
    }
    if (part.type === 'em') {
      return (
        <em key={`em-${index}`} className={cn('italic', tone === 'inherit' ? undefined : tone === 'muted' ? 'text-slate-300' : 'text-slate-100')}>
          <MarkdownInlineContent text={part.value} tone={tone} mentions={mentions} onOpenMention={onOpenMention} showLinkIcons={showLinkIcons} />
        </em>
      );
    }
    if (part.type === 'link') {
      const label = compactExternalLinkLabel(part.label, part.href);
      return (
        <ExternalMessageLink
          key={`link-${index}`}
          href={part.href}
          tone={tone === 'muted' ? 'muted' : 'default'}
          showSiteIcon={showLinkIcons}
        >
          <MessageInlineContent text={label} mentions={mentions} linksInteractive={false} showSiteIcons={false} />
        </ExternalMessageLink>
      );
    }
    return <Fragment key={`text-${index}`}><MessageInlineContent text={part.value} mentions={mentions} onOpenMention={onOpenMention} showSiteIcons={false} /></Fragment>;
  });
}
