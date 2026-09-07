import { externalMessageLinks, safeExternalHttpHref } from '@/kordi-app/components/messageLinks';
import type { CalendarEvent, DigestSource } from './types';

export function digestSourceLinks(sourceIds: string[], sources: DigestSource[]): string[] {
  return [...new Set(sources.filter(source => sourceIds.includes(source.id))
    .flatMap(source => externalMessageLinks(source.text).map(link => link.href)))].slice(0, 10);
}

export function digestEventLinks(event: CalendarEvent, sources: DigestSource[]): string[] {
  const links = event.links ?? (event.sourceIds.length
    ? digestSourceLinks(event.sourceIds, sources)
    : externalMessageLinks(event.description).map(link => link.href));
  return [...new Set(links.filter(link => safeExternalHttpHref(link)))].slice(0, 10);
}

export function digestLinkAction(href: string): string {
  const host = new URL(href).hostname.toLowerCase();
  return host === 'zoom.us' || host.endsWith('.zoom.us') ? 'Open Zoom' : 'Open link';
}
