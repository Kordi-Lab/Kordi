// @ts-expect-error The repository's bird generator is plain JavaScript without types.
import { birdSvg } from '../../../../scripts/kordi-birds/birds.mjs';
import type { PersonalAgentEntry } from '../../src/features/personalAgent/personalAgentStore';
import type { Conversation, Message } from '../../src/kordi-app/types';
import type { MessageEventSource } from '../../src/kordi-app/types/message';

// Synthetic people and agents for the login-free Personal agent preview (#2091).
// Nothing here is real account data.

const ACCOUNT = 'acct_preview_alex';
export const KORDI_SESSION = `session:self-agent:${ACCOUNT}:personal:cloud-agent:${ACCOUNT}`;
export const RESEARCH_SESSION = `session:self-agent:${ACCOUNT}:personal:cloud_agent_research`;
export const INBOX_SESSION = `session:self-agent:${ACCOUNT}:personal:cloud_agent_inbox`;

/** A bird avatar drawn locally, so the preview needs no avatar server. */
function bird(species: string, palette: string) {
  const svg = (birdSvg as (key: string, options: Record<string, unknown>) => string)(species, { palette, radius: 0, size: 128, idPrefix: `preview-${species}` });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const AVATARS = { robin: bird('robin', 'sky'), owl: bird('owl', 'lavender'), kingfisher: bird('kingfisher', 'mint') };

export const previewPersonalAgents: PersonalAgentEntry[] = [
  { agentId: `cloud-agent:${ACCOUNT}`, conversationId: 'conv-kordi', sessionId: KORDI_SESSION, proactive: true, name: "Alex's Kordi", localAgentId: 'desktop:local-agent', avatarSeed: 'preview-robin', profileImageUrl: AVATARS.robin, isDefault: true },
  { agentId: 'cloud_agent_research', conversationId: 'conv-research', sessionId: RESEARCH_SESSION, proactive: true, name: 'Research agent', localAgentId: 'cloud-agent:cloud_agent_research', avatarSeed: 'preview-owl', profileImageUrl: AVATARS.owl, isDefault: false },
  { agentId: 'cloud_agent_inbox', conversationId: 'conv-inbox', sessionId: INBOX_SESSION, proactive: true, name: 'Inbox helper', localAgentId: 'cloud-agent:cloud_agent_inbox', avatarSeed: 'preview-kingfisher', profileImageUrl: AVATARS.kingfisher, isDefault: false },
];

function participants(agentName: string, agentSeed: string) {
  return [
    { id: 'human:preview-alex', name: 'Me', kind: 'human' as const, role: 'self', source: 'local' },
    { id: `agent:${agentSeed}`, name: agentName, kind: 'agent' as const, role: 'delegate', source: 'local', avatarKey: agentSeed },
  ];
}

export function agentTurn(sessionId: string, id: string, sender: string, seed: string, text: string, time: string, timestampMs: number, eventSources: MessageEventSource[] = []): Message {
  return {
    id, entryId: id, role: 'owned-agent', sender, senderType: 'agent', senderAvatarSeed: seed, text: '', time, timestampMs,
    ...(eventSources.length ? { eventSources } : {}),
    turn: {
      id: `turn:${id}`, sessionId, prompt: '', status: 'complete', message: 'Complete', assistantText: text,
      thinkingText: '', tools: [], completed: true, succeeded: true, startedAtMs: timestampMs, completedAtMs: timestampMs,
    },
  };
}

export function userMessage(id: string, text: string, time: string, timestampMs: number): Message {
  return { id, entryId: id, role: 'user', sender: 'Me', isOwnMessage: true, text, time, timestampMs };
}

function chat(id: string, name: string, agentName: string, seed: string, messages: Message[], overrides: Partial<Conversation> = {}): Conversation & { _updatedAtMs?: number } {
  const last = messages[messages.length - 1];
  return {
    id, canonicalSessionId: id, name, type: 'owned-agent', subtitle: '', unread: 0,
    desktopRuntimeBacked: true, desktopRuntimeTranscriptLoaded: true, collaborationSources: ['Local'], trust: 'Owned', directness: 'Agent chat',
    participants: ['Me', agentName], canonicalParticipants: participants(agentName, seed),
    updatedAtLabel: last?.time, messages, _updatedAtMs: last?.timestampMs ?? 0,
    ...overrides,
  } as Conversation & { _updatedAtMs?: number };
}

const today = (hours: number, minutes: number) => new Date(2026, 9, 25, hours, minutes).getTime();

export function previewConversations(proactiveOff = false) {
  const kordiMessages = proactiveOff ? [
    userMessage('k-ask', 'Anything new from my connectors?', '15:02', today(15, 2)),
    agentTurn(KORDI_SESSION, 'k-answer', "Alex's Kordi", 'preview-robin', 'Sam asked on Airbnb about a 1 pm check-in tomorrow. Lab sync moved to 10 am Thursday, and Mei wants your review on #412 before it.', '15:02', today(15, 2) + 1, [
      { eventId: 'cnevt_airbnb', provider: 'gmail', title: 'Airbnb · Sam' },
      { eventId: 'cnevt_lab', provider: 'google_calendar', title: 'Lab sync' },
      { eventId: 'cnevt_pr', provider: 'github', title: '#412 review requested' },
    ]),
  ] : [
    agentTurn(KORDI_SESSION, 'k-airbnb', "Alex's Kordi", 'preview-robin', "Sam asked on Airbnb if they can check in at 1 pm tomorrow. You're free then.", '09:12', today(9, 12), [
      { eventId: 'cnevt_airbnb', provider: 'gmail', title: 'Airbnb · Sam' },
    ]),
    agentTurn(KORDI_SESSION, 'k-lab', "Alex's Kordi", 'preview-robin', 'Lab sync moved to 10 am Thursday. Mei wants your review on #412 before it.', '14:40', today(14, 40), [
      { eventId: 'cnevt_lab', provider: 'google_calendar', title: 'Lab sync' },
      { eventId: 'cnevt_pr', provider: 'github', title: '#412 review requested' },
    ]),
  ];
  const personal = (agentId: string) => ({ metadata: { personalAgent: { agentId } } });
  return [
    chat(KORDI_SESSION, "Alex's Kordi", "Alex's Kordi", 'preview-robin', kordiMessages, { unread: proactiveOff ? 0 : 2, ...personal(previewPersonalAgents[0]!.agentId) }),
    chat(RESEARCH_SESSION, 'Research agent', 'Research agent', 'preview-owl', [
      agentTurn(RESEARCH_SESSION, 'r-papers', 'Research agent', 'preview-owl', 'Two new papers cite your workshop draft. Priya shared both in the reading group.', '11:20', today(11, 20), [
        { eventId: 'cnevt_scholar', provider: 'gmail', title: 'Citation alert · Priya' },
        { eventId: 'cnevt_slack', provider: 'slack', title: '#reading-group' },
      ]),
    ], { unread: 1, ...personal('cloud_agent_research') }),
    chat(INBOX_SESSION, 'Inbox helper', 'Inbox helper', 'preview-kingfisher', [], personal('cloud_agent_inbox')),
    chat('session:direct-agent:preview-figure', 'Figure script fix', "Alex's Kordi", 'preview-robin', [
      userMessage('f-ask', "The figure script crashes on the new dataset, KeyError: 'timestamp'.", '12:01', today(12, 1)),
      agentTurn('session:direct-agent:preview-figure', 'f-fix', "Alex's Kordi", 'preview-robin', 'The new dataset names the column date. I patched the loader to accept both and re-ran it.', '12:05', today(12, 5)),
    ]),
    chat('session:direct-agent:preview-lisbon', 'Trip to Lisbon', 'Research agent', 'preview-owl', [
      userMessage('l-ask', 'Find flights to Lisbon for the conference week.', 'Tue', today(9, 0) - 86_400_000 * 5),
      agentTurn('session:direct-agent:preview-lisbon', 'l-answer', 'Research agent', 'preview-owl', 'Three options under €900.', 'Tue', today(9, 1) - 86_400_000 * 5),
    ]),
  ];
}
