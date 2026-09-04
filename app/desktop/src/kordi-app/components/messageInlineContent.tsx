import { Fragment, memo, useMemo, useState, type ReactNode } from 'react';
import { Globe2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { BlobEmojiImage } from '@/features/emoji/BlobEmojiImage';
import { NotoEmojiImage } from '@/features/emoji/NotoEmojiImage';
import type { MessageMention } from '../types';
import {
  compactExternalLinkLabel,
  openExternalMessageLink,
  parseMessageInlineParts,
  safeExternalHttpHref,
  siteIconDescriptorForHref,
} from './messageLinks';
import {
  shouldLoadAvatarThroughNativeProxy,
  useRemoteAvatarImage,
} from './remoteAvatarImage';

export const SiteIcon = memo(function SiteIcon({ href }: { href: string }) {
  const descriptor = siteIconDescriptorForHref(href);
  const requestUrl = descriptor?.requestUrl ?? null;
  const shouldLoad = shouldLoadAvatarThroughNativeProxy(requestUrl);
  const remoteIcon = useRemoteAvatarImage(requestUrl, shouldLoad);
  const [failedDataUrl, setFailedDataUrl] = useState<string | null>(null);
  const loadedDataUrl = remoteIcon.status === 'ready' && remoteIcon.dataUrl !== failedDataUrl
    ? remoteIcon.dataUrl
    : null;

  return (
    <span
      className="app-message-link-site-icon"
      data-site-icon-host={descriptor?.hostname}
      data-site-icon-state={loadedDataUrl ? 'ready' : remoteIcon.status}
      aria-hidden="true"
    >
      {loadedDataUrl ? (
        <img
          src={loadedDataUrl}
          alt=""
          decoding="async"
          onError={() => setFailedDataUrl(loadedDataUrl)}
        />
      ) : (
        <Globe2 />
      )}
    </span>
  );
});

export function ExternalMessageLink({
  href,
  children,
  showSiteIcon = false,
  tone = 'default',
}: {
  href: string;
  children: ReactNode;
  showSiteIcon?: boolean;
  tone?: 'default' | 'muted';
}) {
  const safeHref = safeExternalHttpHref(href);
  if (!safeHref) return <>{children}</>;

  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noreferrer noopener"
      title={safeHref}
      data-external-message-link="true"
      onClick={(event) => {
        openExternalMessageLink(event, safeHref);
      }}
      className={cn(
        'app-markdown-link break-words [overflow-wrap:anywhere]',
        tone === 'muted' && 'app-markdown-link-muted',
      )}
    >
      {showSiteIcon ? <SiteIcon href={safeHref} /> : null}
      <span>{children}</span>
    </a>
  );
}

export function MessageInlineContent({
  text,
  mentions,
  linksInteractive = true,
  showSiteIcons = true,
  onOpenMention,
}: {
  text: string;
  mentions?: MessageMention[];
  linksInteractive?: boolean;
  showSiteIcons?: boolean;
  onOpenMention?: (mention: MessageMention, anchorRect: DOMRect) => void;
}) {
  const parts = useMemo(() => parseMessageInlineParts(text, mentions), [mentions, text]);
  return parts.map((part) => {
    if (part.type === 'blobEmoji') {
      return (
        <BlobEmojiImage
          key={`blob-${part.start}`}
          emoji={part.emoji}
          className="app-inline-blob-emoji"
        />
      );
    }
    if (part.type === 'notoEmoji') {
      return (
        <NotoEmojiImage
          key={`noto-${part.start}`}
          emoji={part.emoji}
          className="app-inline-blob-emoji"
        />
      );
    }
    if (part.type === 'mention') {
      const canOpenProfile = Boolean(
        onOpenMention
        && part.targetKind === 'person'
        && (part.humanId?.trim() || part.targetIdentityId?.trim()),
      );
      const mention = (
        <span
          className={cn(
            'app-message-mention',
            `app-message-mention-${part.targetKind}`,
            part.targetKind === 'all' && 'app-message-mention-person',
          )}
          data-mention-kind={part.targetKind}
          data-mention-identity={part.targetIdentityId ?? undefined}
          aria-label={part.targetKind === 'all'
            ? `${part.label}, all people in this group`
            : `${part.label}, ${part.targetKind} mention`}
        >
          {part.label}
        </span>
      );
      if (canOpenProfile) {
        return (
          <button
            key={`mention-${part.start}`}
            type="button"
            className="rounded-sm bg-transparent p-0 text-left font-[inherit] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--app-sidebar-accent)]"
            aria-label={`Open ${part.label.replace(/^@/, '')} profile`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenMention?.({
                label: part.label.replace(/^@/, ''),
                targetKind: part.targetKind,
                targetIdentityId: part.targetIdentityId,
                humanId: part.humanId,
              }, event.currentTarget.getBoundingClientRect());
            }}
          >
            {mention}
          </button>
        );
      }
      return (
        <Fragment key={`mention-${part.start}`}>{mention}</Fragment>
      );
    }
    if (part.type === 'link') {
      const label = compactExternalLinkLabel(part.label, part.href);
      if (!linksInteractive) {
        return <Fragment key={`link-${part.start}`}>{label}</Fragment>;
      }
      return (
        <ExternalMessageLink
          key={`link-${part.start}`}
          href={part.href}
          showSiteIcon={showSiteIcons}
        >
          {label}
        </ExternalMessageLink>
      );
    }
    return <Fragment key={`text-${part.start}`}>{part.value}</Fragment>;
  });
}
