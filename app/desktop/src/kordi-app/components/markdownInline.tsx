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
  | { type: 'link'; label: string; href: string };

export type MarkdownTone = 'default' | 'muted' | 'inherit';

export type MarkdownInlineOptions = {
  tone?: MarkdownTone;
  showLinkIcons?: boolean;
  mentions?: MessageMention[];
  onOpenMention?: (mention: MessageMention, anchorRect: DOMRect) => void;
};

function nextInlineTokenIndex(slice: string) {
  return [slice.indexOf('['), slice.indexOf('`'), slice.indexOf('*'), slice.search(bareHttpUrlStartPattern)]
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0];
}

function parseInlineMarkdown(text: string): MarkdownInlinePart[] {
  const parts: MarkdownInlinePart[] = [];
  let index = 0;

  while (index < text.length) {
    const slice = text.slice(index);
    const markdownLink = markdownHttpLinkPrefix(slice);
    if (markdownLink) {
      parts.push({ type: 'link', label: markdownLink.label, href: markdownLink.href });
      index += markdownLink.matchedLength;
      continue;
    }
    const patterns = [
      { type: 'bareLink' as const, match: slice.match(/^https?:\/\/[^\s<>"']+/i) },
      { type: 'code' as const, match: slice.match(/^`([^`]+)`/) },
      { type: 'strong' as const, match: slice.match(/^\*\*([^*]+)\*\*/) },
      { type: 'em' as const, match: slice.match(/^\*([^*]+)\*/) },
    ];
    const hit = patterns.find((entry) => entry.match);

    if (!hit?.match) {
      const nextIndex = nextInlineTokenIndex(slice);
      if (nextIndex === undefined) {
        parts.push({ type: 'text', value: text.slice(index) });
        break;
      }
      if (nextIndex === 0) {
        parts.push({ type: 'text', value: slice[0] });
        index += 1;
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
    } else if (hit.type === 'code') {
      parts.push({ type: 'code', value: first });
    } else if (hit.type === 'strong') {
      parts.push({ type: 'strong', value: first });
    } else {
      parts.push({ type: 'em', value: first });
    }
    index += matched.length;
  }

  return parts;
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
    if (part.type === 'strong') {
      return (
        <strong key={`strong-${index}`} className={cn('font-semibold', tone === 'inherit' ? undefined : tone === 'muted' ? 'text-slate-100' : 'text-white')}>
          <MessageInlineContent text={part.value} mentions={mentions} onOpenMention={onOpenMention} showSiteIcons={false} />
        </strong>
      );
    }
    if (part.type === 'em') {
      return (
        <em key={`em-${index}`} className={cn('italic', tone === 'inherit' ? undefined : tone === 'muted' ? 'text-slate-300' : 'text-slate-100')}>
          <MessageInlineContent text={part.value} mentions={mentions} onOpenMention={onOpenMention} showSiteIcons={false} />
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
