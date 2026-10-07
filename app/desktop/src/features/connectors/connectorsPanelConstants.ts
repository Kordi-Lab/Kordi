import {
  BellRing,
  Calendar,
  Contact,
  GitPullRequest,
  Hash,
  Mail,
  type LucideIcon,
} from 'lucide-react';

import type { ConnectorAuditEntry, ConnectorProviderId } from './connectorsModel';

export const connectorIcons: Record<ConnectorProviderId, LucideIcon> = {
  google_calendar: Calendar,
  gmail: Mail,
  github: GitPullRequest,
  slack: Hash,
  outlook: Mail,
  mac_calendar: Calendar,
  mac_contacts: Contact,
  mac_notification_center: BellRing,
};

// Denser navigation rows (about 40px) than the shared SettingsRow default, applied
// from a wrapper so the shared component stays unchanged.
export const denseNavRowsClass = '[&_.app-settings-row-button]:min-h-8 [&_.app-settings-row-button]:py-0.5 [&_.app-settings-row-button]:gap-2.5 [&_.app-settings-row:not(.app-settings-row-button)]:py-1 [&_.app-settings-section]:pt-4 [&_.app-settings-section:first-child]:pt-2';

export type ConnectorDialog =
  | { kind: 'connect'; providerId: ConnectorProviderId; reauth: boolean }
  | { kind: 'grant'; providerId: ConnectorProviderId }
  | { kind: 'audit'; providerId: ConnectorProviderId; entries: ConnectorAuditEntry[] | null; error: string | null }
  | { kind: 'disconnect'; providerId: ConnectorProviderId };
