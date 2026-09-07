import { ExternalLink } from 'lucide-react';
import { compactExternalLinkLabel, openExternalMessageLink } from '@/kordi-app/components/messageLinks';
import { digestLinkAction } from './links';

export function DigestRelatedLinks({links}: {links: string[]}) {
  if (!links.length) return null;
  return <div className="digest-related-links" aria-label="Related links">{links.map(href => {
    const url = new URL(href);
    const action=digestLinkAction(href);
    const label=action==='Open Zoom'?url.hostname:compactExternalLinkLabel(href,href);
    return <a key={href} href={href} title={href} target="_blank" rel="noreferrer noopener" onClick={event => openExternalMessageLink(event, href)}>
      <ExternalLink size={15} aria-hidden="true"/><span>{label}</span><strong>{action}</strong>
    </a>;
  })}</div>;
}
