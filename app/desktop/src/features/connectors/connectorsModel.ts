// Connectors let a person link services and Mac-local sources so their agent
// can read updates and, with approval, act in them. Tokens never reach the
// model: Kordi's server (or the owner's Mac) runs each tool call and only the
// results reach the agent. This module is the React-free model for the
// settings surface.

export type ConnectorProviderId =
  | 'google_calendar'
  | 'gmail'
  | 'github'
  | 'slack'
  | 'outlook'
  | 'mac_calendar'
  | 'mac_contacts'
  | 'mac_notification_center';

export type ConnectorKind = 'service' | 'mac_local';
export type ConnectorToolGroup = 'read' | 'act';
export type ConnectorScope = { id: string; label: string; group: ConnectorToolGroup };
export type ConnectorAvailability = 'available' | 'coming_later';

export type ConnectorDefinition = {
  providerId: ConnectorProviderId;
  kind: ConnectorKind;
  name: string;
  /** The company that handles the sign-in, for example "Google". */
  providerName: string;
  summary: string;
  readScopes: ConnectorScope[];
  actScopes: ConnectorScope[];
  actDescription: string;
  availability: ConnectorAvailability;
  experimental?: boolean;
  requiresFullDiskAccess?: boolean;
};

export type ConnectorStatus = 'not_connected' | 'connected' | 'needs_reauth' | 'permission_missing';

export type ConnectorState = {
  providerId: ConnectorProviderId;
  status: ConnectorStatus;
  connectedAt: string | null;
  grantedScopeIds: string[];
  actEnabled: boolean;
  agentIds: string[];
  lastEventAt: string | null;
};

export type ConnectorAgent = { agentId: string; name: string; isDefault: boolean };

export type ConnectorAuditOutcome = 'completed' | 'approved' | 'denied' | 'blocked_background' | 'failed';

export type ConnectorAuditEntry = {
  id: string;
  providerId: ConnectorProviderId;
  at: string;
  agentName: string;
  tool: string;
  group: ConnectorToolGroup;
  outcome: ConnectorAuditOutcome;
  summary: string;
};

function read(id: string, label: string): ConnectorScope {
  return { id, label, group: 'read' };
}

function act(id: string, label: string): ConnectorScope {
  return { id, label, group: 'act' };
}

export const connectorCatalog: ConnectorDefinition[] = [
  {
    providerId: 'google_calendar',
    kind: 'service',
    name: 'Google Calendar',
    providerName: 'Google',
    summary: 'Upcoming events, invitations, and free time.',
    readScopes: [
      read('google_calendar.events.read', 'Read your events and invitations'),
      read('google_calendar.freebusy.read', 'See when you are free'),
    ],
    actScopes: [
      act('google_calendar.invitations.reply', 'Reply to invitations'),
      act('google_calendar.events.write', 'Create and change events'),
    ],
    actDescription: 'Your agent can reply to invitations and create or change events.',
    availability: 'available',
  },
  {
    providerId: 'gmail',
    kind: 'service',
    name: 'Gmail',
    providerName: 'Google',
    summary: 'Mail that needs your attention.',
    readScopes: [
      read('gmail.messages.read', 'Search and read your mail'),
      read('gmail.labels.read', 'Read labels'),
    ],
    actScopes: [
      act('gmail.messages.send', 'Send mail as you'),
      act('gmail.messages.modify', 'Archive and label'),
    ],
    actDescription: 'Your agent can send mail as you, archive, and label.',
    availability: 'available',
  },
  {
    providerId: 'github',
    kind: 'service',
    name: 'GitHub',
    providerName: 'GitHub',
    summary: 'Notifications, reviews, and pull request state.',
    readScopes: [
      read('github.notifications.read', 'Notifications'),
      read('github.pulls.read', 'Pull request state and reviews'),
    ],
    actScopes: [
      act('github.comments.write', 'Comment on issues and pull requests'),
    ],
    actDescription: 'Your agent can comment on issues and pull requests.',
    availability: 'available',
  },
  {
    providerId: 'slack',
    kind: 'service',
    name: 'Slack',
    providerName: 'Slack',
    summary: 'Messages in the channels you choose.',
    readScopes: [
      read('slack.channels.read', 'Channels you choose'),
    ],
    actScopes: [
      act('slack.messages.write', 'Post messages as you'),
    ],
    actDescription: 'Your agent can post messages as you.',
    availability: 'available',
  },
  {
    providerId: 'outlook',
    kind: 'service',
    name: 'Outlook',
    providerName: 'Microsoft',
    summary: 'Microsoft 365 mail and calendar.',
    readScopes: [
      read('outlook.mail.read', 'Search and read your mail'),
      read('outlook.calendar.read', 'Read your events'),
    ],
    actScopes: [],
    actDescription: '',
    availability: 'coming_later',
  },
  {
    providerId: 'mac_calendar',
    kind: 'mac_local',
    name: 'Calendar and Reminders',
    providerName: 'macOS',
    summary: 'Calendars and reminders on this Mac.',
    readScopes: [
      read('mac_calendar.events.read', 'Read calendars on this Mac'),
      read('mac_calendar.reminders.read', 'Read reminders'),
    ],
    actScopes: [
      act('mac_calendar.reminders.write', 'Create reminders'),
    ],
    actDescription: 'Your agent can create reminders on this Mac.',
    availability: 'available',
  },
  {
    providerId: 'mac_contacts',
    kind: 'mac_local',
    name: 'Contacts',
    providerName: 'macOS',
    summary: 'Names and details of people you know.',
    readScopes: [
      read('mac_contacts.read', 'Read names, emails, and phone numbers'),
    ],
    actScopes: [],
    actDescription: '',
    availability: 'available',
  },
  {
    providerId: 'mac_notification_center',
    kind: 'mac_local',
    name: 'Notification Center',
    providerName: 'macOS',
    summary: 'Recent notifications on this Mac.',
    readScopes: [
      read('mac_notification_center.read', 'Recent notifications on this Mac (bounded window)'),
    ],
    actScopes: [],
    actDescription: '',
    availability: 'available',
    experimental: true,
    requiresFullDiskAccess: true,
  },
];

export function connectorDefinition(providerId: ConnectorProviderId): ConnectorDefinition {
  const definition = connectorCatalog.find((entry) => entry.providerId === providerId);
  if (!definition) throw new Error(`Unknown connector: ${providerId}`);
  return definition;
}

/** Tool groups a single run may receive. Background runs only ever read. */
export function connectorToolGroupsForRun(
  state: ConnectorState,
  run: { startedByPerson: boolean },
): ConnectorToolGroup[] {
  if (state.status !== 'connected') return [];
  if (!state.actEnabled || !run.startedByPerson) return ['read'];
  return ['read', 'act'];
}

export function hasGrantedActScopes(definition: ConnectorDefinition, state: ConnectorState): boolean {
  return definition.actScopes.length > 0
    && definition.actScopes.every((scope) => state.grantedScopeIds.includes(scope.id));
}

export function disconnectConsequences(definition: ConnectorDefinition): string[] {
  return [
    `Kordi removes the sign-in token for ${definition.name}.`,
    `Stored events from ${definition.name} are deleted.`,
    'Copies your agent made from them are queued for removal. Lessons your agent already saved are managed under Memory.',
  ];
}

function agentCountLabel(state: ConnectorState, agents: ConnectorAgent[]): string {
  const granted = agents.filter((agent) => state.agentIds.includes(agent.agentId)).length;
  if (agents.length > 0 && granted === agents.length) return 'All agents';
  if (granted === 0) return 'No agents';
  return granted === 1 ? '1 agent' : `${granted} agents`;
}

export function connectorStatusLabel(
  definition: ConnectorDefinition,
  state: ConnectorState | undefined,
  agents: ConnectorAgent[],
): string {
  if (definition.availability === 'coming_later') return 'Not yet available';
  const status = state?.status ?? 'not_connected';
  if (status === 'needs_reauth') return 'Sign in again';
  if (status === 'permission_missing') {
    return definition.requiresFullDiskAccess ? 'Needs Full Disk Access' : 'Needs permission';
  }
  if (status !== 'connected' || !state) return 'Not connected';
  const access = state.actEnabled ? 'Can act' : 'Read only';
  return ['Connected', access, agentCountLabel(state, agents)].join(' · ');
}

/** Short status value for the connector list; the detail view adds agent grants. */
export function connectorListValue(
  definition: ConnectorDefinition,
  state: ConnectorState | undefined,
): string {
  if (definition.availability === 'coming_later') return 'Coming later';
  const status = state?.status ?? 'not_connected';
  if (status === 'needs_reauth') return 'Sign in again';
  if (status === 'permission_missing') {
    return definition.requiresFullDiskAccess ? 'Needs Full Disk Access' : 'Needs permission';
  }
  if (status !== 'connected' || !state) return 'Not connected';
  return state.actEnabled ? 'Connected · Can act' : 'Connected · Read only';
}
