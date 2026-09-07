import { ExternalLink } from 'lucide-react';
import { openExternalMessageLink } from '@/kordi-app/components/messageLinks';
import { digestLinkAction } from './links';

export function DigestRelatedLinks({links}: {links: string[]}) {
  if (!links.length) return null;
  return <div className="digest-related-links" aria-label="Related links">{links.map(href => {
    const url = new URL(href);
    return <a key={href} href={href} target="_blank" rel="noreferrer noopener" onClick={event => openExternalMessageLink(event, href)}>
      <ExternalLink size={15} aria-hidden="true"/><span>{url.hostname}{url.pathname === '/' ? '' : url.pathname}</span><strong>{digestLinkAction(href)}</strong>
    </a>;
  })}</div>;
}
