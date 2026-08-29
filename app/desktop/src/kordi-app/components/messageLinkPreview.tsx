import { memo, useEffect, useMemo, useState } from 'react';

import { isNativeDesktopShell } from '@/lib/desktop';
import {
  firstExternalMessageLink,
  openExternalMessageLink,
  safeExternalHttpHref,
} from './messageLinks';
import { SiteIcon } from './messageInlineContent';
import {
  shouldLoadAvatarThroughNativeProxy,
  useRemoteAvatarImage,
} from './remoteAvatarImage';
import {
  loadLinkPreviewMetadata,
  readCachedLinkPreview,
  type LinkPreviewMetadata,
} from './linkPreviewMetadata';

function cleanLinkLabel(label: string, href: string): string | null {
  const text = label
    .replace(/:blob:[A-Za-z0-9_-]+:/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text && text !== href && !safeExternalHttpHref(text) ? text.slice(0, 200) : null;
}

function fallbackTitle(href: string, label: string) {
  const labelTitle = cleanLinkLabel(label, href);
  if (labelTitle) return labelTitle;
  const url = new URL(href);
  const segments = decodedPath(url).split('/').filter(Boolean);
  const leaf = (segments[segments.length - 1] ?? '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return leaf && !/^[a-f\d]{20,}$/i.test(leaf)
    ? leaf.slice(0, 120)
    : url.hostname.replace(/^www\./i, '');
}

function decodedPath(url: URL) {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

function compactPath(href: string) {
  const path = decodedPath(new URL(href)).replace(/\/{2,}/g, '/');
  return path && path !== '/' ? path.slice(0, 120) : null;
}

function LinkPreviewCard({ href, label }: { href: string; label: string }) {
  const [metadata, setMetadata] = useState<LinkPreviewMetadata | null>(() => readCachedLinkPreview(href));
  const [failed, setFailed] = useState(false);
  const canLoad = isNativeDesktopShell() && new URL(href).protocol.toLowerCase() === 'https:';

  useEffect(() => {
    if (metadata || !canLoad) return;
    let active = true;
    void loadLinkPreviewMetadata(href)
      .then((value) => {
        if (!active) return;
        setMetadata(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => { active = false; };
  }, [canLoad, href, metadata]);

  const hostname = useMemo(() => new URL(href).hostname.replace(/^www\./i, ''), [href]);
  const title = metadata?.title ?? fallbackTitle(href, label);
  const description = metadata?.description ?? compactPath(href);
  const imageUrl = metadata?.imageUrl ?? null;
  const remoteImage = useRemoteAvatarImage(imageUrl, shouldLoadAvatarThroughNativeProxy(imageUrl));
  const imageDataUrl = remoteImage.status === 'ready' ? remoteImage.dataUrl : null;
  const state = metadata ? 'ready' : failed ? 'failed' : canLoad ? 'loading' : 'idle';

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="app-message-link-preview"
      data-link-preview-state={state}
      aria-label={`Open ${title} on ${hostname}`}
      onClick={(event) => { openExternalMessageLink(event, href); }}
    >
      <span className="app-message-link-preview-copy">
        <span className="app-message-link-preview-site">{metadata?.siteName ?? hostname}</span>
        <span className="app-message-link-preview-title">{title}</span>
        {description ? <span className="app-message-link-preview-description">{description}</span> : null}
      </span>
      <span className="app-message-link-preview-artwork" aria-hidden="true">
        {imageDataUrl ? (
          <img src={imageDataUrl} alt="" decoding="async" />
        ) : (
          <SiteIcon href={href} />
        )}
      </span>
    </a>
  );
}

export const MessageLinkPreview = memo(function MessageLinkPreview({ text }: { text: string }) {
  const link = useMemo(() => firstExternalMessageLink(text), [text]);
  return link ? <LinkPreviewCard key={link.href} href={link.href} label={link.label} /> : null;
});
