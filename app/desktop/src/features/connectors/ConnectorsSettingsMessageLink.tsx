import type { ReactNode } from 'react';
import { Settings } from 'lucide-react';

import { cn } from '@/lib/utils';
import { openConnectorsSettingsLink, parseConnectorsSettingsLink } from './connectorsSettingsLink';

/** A `kordi://settings/connectors` link in a message; opens settings in the app. */
export function ConnectorsSettingsMessageLink({
  href,
  children,
  tone = 'default',
}: {
  href: string;
  children: ReactNode;
  tone?: 'default' | 'muted';
}) {
  if (!parseConnectorsSettingsLink(href)) return <>{children}</>;
  return (
    <a
      href={href}
      data-connectors-settings-link="true"
      title="Open Connectors settings"
      onClick={(event) => {
        if (!openConnectorsSettingsLink(event, href)) event.preventDefault();
      }}
      className={cn('app-markdown-link inline-flex items-center gap-1 break-words', tone === 'muted' && 'app-markdown-link-muted')}
    >
      <Settings className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </a>
  );
}
