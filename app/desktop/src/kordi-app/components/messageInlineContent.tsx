import { Fragment, memo, useMemo, useState, type ReactNode } from 'react';
import { Globe2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { MessageMention } from '../types';
import {
  openExternalMessageLink,
  parseMessageInlineParts,
  safeExternalHttpHref,
  siteIconDescriptorForHref,
} from './messageLinks';
import {
  shouldLoadAvatarThroughNativeProxy,
  useRemoteAvatarImage,
} from './remoteAvatarImage';

const SiteIcon = memo(function SiteIcon({ href }: { href: string }) {
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
  showSiteIcons = true,
}: {
  text: string;
  mentions?: MessageMention[];
  showSiteIcons?: boolean;
}) {
  const parts = useMemo(() => parseMessageInlineParts(text, mentions), [mentions, text]);
  return parts.map((part) => {
    if (part.type === 'mention') {
      return (
        <span
          key={`mention-${part.start}`}
          className={cn('app-message-mention', `app-message-mention-${part.targetKind}`)}
          data-mention-kind={part.targetKind}
          data-mention-identity={part.targetIdentityId ?? undefined}
          aria-label={`${part.label}, ${part.targetKind} mention`}
        >
          {part.label}
        </span>
      );
    }
    if (part.type === 'link') {
      return (
        <ExternalMessageLink
          key={`link-${part.start}`}
          href={part.href}
          showSiteIcon={showSiteIcons}
        >
          {part.label}
        </ExternalMessageLink>
      );
    }
    return <Fragment key={`text-${part.start}`}>{part.value}</Fragment>;
  });
}
