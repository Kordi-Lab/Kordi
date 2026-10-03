// Copy for the AI access section and the PiP switch at group creation.
import type { ConversationParticipant } from '@/kordi-app/types';

export const AI_ACCESS_COPY = {
  title: 'AI access',
  channelLabel: 'Channel',
  channelUnavailable: 'AI access isn\'t available for this channel.',
  scopeLabel: 'What agents can see',
  mentionsLabel: 'Only messages sent to them',
  recentLabel: 'Recent messages',
  mentionsHelp: 'When someone asks an agent here, it gets that message, the message it replies to or quotes, and that person\'s earlier requests to it with its replies. It can\'t read the rest of this conversation.',
  recentHelp: 'When someone asks an agent here, it can also read recent messages and search this conversation\'s history.',
  scopeNote: 'This covers agents that people ask here. To keep your own messages away from other people\'s AI, use “Don\'t let AI use my messages.”',
  nonManager: 'Only group owners and admins can change this.',
  confirmTitle: 'Let agents read recent messages?',
  confirmBody: 'When someone asks an agent in this group, it will be able to read recent messages and search the group\'s history. Everyone here will see a notice. Messages from people who turned on “Don\'t let AI use my messages” stay left out.',
  optOutLabel: 'Don\'t let AI use my messages',
  optOutHelp: 'When this is on, other people\'s agents, PiP, and other members\' digests and private assistants leave out the messages you send here. Messages you send to an agent yourself, including in its task threads, are still used for that request. Everyone here can see that this is on.',
  optOutFootnote: 'Kordi\'s servers and up-to-date Kordi apps apply this. It doesn\'t remove what an AI already received, and people here can still read, copy, or forward your messages.',
  turnedOnBy: 'Turned on by',
  noOne: 'No one',
  pipLabel: 'PiP plan helper',
  footer: 'When you ask someone else\'s agent here, it works in a workspace kept separate for you. Open “About this reply” on an agent\'s message to see who runs it and where it ran.',
  createPipLabel: 'Add PiP, the plan helper',
  createPipFailure: 'The group was created, but PiP couldn\'t be turned on. You can turn it on in AI access.',
} as const;

/** The section title; in a group with several channels it names the channel. */
export function aiAccessTitle(channelName?: string | null): string {
  const name = channelName?.trim();
  return name ? `${AI_ACCESS_COPY.title} for ${name}` : AI_ACCESS_COPY.title;
}

function providerName(provider: string | null | undefined) {
  return provider?.trim() || 'an AI provider';
}

export function pipHelpText(provider: string | null | undefined): string {
  return `PiP reads new messages here to spot plans and keep a plan card up to date. It uses ${providerName(provider)} through Kordi's account. PiP only suggests answers and decisions; people confirm them.`;
}

export function createPipHelpText(provider: string | null | undefined): string {
  return `PiP reads new messages in this group to help plan events, using ${providerName(provider)} through Kordi's account. You can change this later in AI access.`;
}

function keyVariants(value: string | null | undefined): string[] {
  const key = value?.trim() ?? '';
  if (!key) return [];
  return key.startsWith('human:') ? [key, key.slice('human:'.length)] : [key];
}

/** Display names by account id, for "Turned on by". The signed-in member reads "You". */
export function aiAccessMemberNames(participants: readonly ConversationParticipant[]): Map<string, string> {
  const names = new Map<string, string>();
  participants.forEach((participant) => {
    if (participant.kind === 'agent') return;
    const isSelf = participant.role === 'self' || participant.source === 'local';
    const name = isSelf ? 'You' : participant.publicName?.trim() || participant.name.trim();
    if (!name) return;
    [participant.humanId, participant.sourceIdentityId, participant.id]
      .flatMap(keyVariants)
      .forEach((key) => { if (!names.has(key)) names.set(key, name); });
  });
  return names;
}

export function turnedOnByText(
  accountIds: readonly string[],
  names: ReadonlyMap<string, string>,
  currentAccountId?: string | null,
): string {
  if (accountIds.length === 0) return AI_ACCESS_COPY.noOne;
  return accountIds
    .map((id) => (id === currentAccountId ? 'You' : names.get(id) ?? 'A member'))
    .join(', ');
}
