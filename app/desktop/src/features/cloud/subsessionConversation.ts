import type { CloudAgentSubsession, AgentSubsessionMessage } from './agentSubsessionTypes';
import type { Conversation, Message, MessageMention, DesktopChatToolSnapshot } from '@/kordi-app/types';
import type { ComposerMentionOption } from '@/kordi-app/components/composer';
import { publicScopedAgentMentionHandle } from '@/lib/identityLabels';
import { mentionHandleForLabel } from '@/features/chat/messageActions/mentionHandles';
import { sentenceCaseAgentThreadTitle } from '@/features/chat/agentThreadTitle';

export function subsessionMentionOptions(record: CloudAgentSubsession, accountId: string): ComposerMentionOption[] {
  return [{
    value: publicScopedAgentMentionHandle(record.ownerDisplayName, record.agentDisplayName),
    label: record.agentDisplayName, detail: `Owner · ${record.ownerAccountId === accountId ? 'You' : record.ownerDisplayName}`,
    targetKind: 'agent', agentId: record.agentId, humanId: record.ownerAccountId,
    sourceHostId: 'cloud', nodeId: record.agentId, runtime: 'cloud', ownerName: record.ownerDisplayName,
    avatarImageUrl: record.agentAvatarUrl,
  }, ...(record.participants ?? []).filter(person => person.accountId !== accountId).map(person => ({
    value: mentionHandleForLabel(person.displayName), label: person.displayName, targetKind: 'person' as const,
    humanId: person.accountId, sourceHostId: 'cloud', nodeId: person.accountId, runtime: 'cloud',
    avatarImageUrl: person.avatarUrl, avatarSeed: person.avatarSeed,
  }))];
}

export function subsessionMentions(text: string, options: ComposerMentionOption[]): MessageMention[] {
  return Array.from(text.matchAll(/(?<![\p{L}\p{N}@])@([\p{L}\p{N}]+)/gu)).flatMap(match => {
    const candidates = options.filter(option => option.value === match[1]);
    // Ambiguous display handles must never select an identity by position.
    if (candidates.length !== 1) return [];
    const option = candidates[0];
    return [{ label: option.value, targetKind: option.targetKind, targetIdentityId: option.agentId ?? option.humanId,
      agentId: option.agentId, humanId: option.humanId, displayText: match[0], displayLabel: option.label,
      startUtf16: match.index, lengthUtf16: match[0].length }];
  });
}

export function subsessionTranscript(record: CloudAgentSubsession, accountId: string): Message[] {
  const live = record.status === 'running' && record.live !== false;
  const { rows, legacyTools } = collapseLegacyToolRows(record.messages.filter(row => !(row.role === 'assistant' && (
    ['queued', 'pending', 'leased'].includes(row.requestState ?? '')
      || record.live === false && row.requestState === 'running' && !row.text.trim()
  ))), live && !record.hasFollowupExecution);
  const result = rows.map((row): Message => {
    const assistant = row.role === 'assistant';
    const agent = assistant || row.senderAgentId === record.agentId;
    const own = row.senderAccountId === accountId;
    const participant = record.participants?.find(person => person.accountId === row.senderAccountId);
    const tools = legacyTools.get(row.id);
    return {
      id: row.id, role: agent ? record.ownerAccountId === accountId ? 'owned-agent' : 'external-agent' : own ? 'user' : 'person',
      sender: agent ? record.agentDisplayName : own ? 'You' : row.senderDisplayName ?? 'Task',
      senderOwnerName: agent ? record.ownerAccountId === accountId ? 'You' : record.ownerDisplayName : undefined,
      senderIdentityId: agent ? record.agentId : row.senderAccountId,
      senderAvatarSeed: agent ? record.agentId : participant?.avatarSeed ?? row.senderAccountId,
      senderProfileImageUrl: agent ? record.agentAvatarUrl : participant?.avatarUrl,
      senderType: agent ? 'agent' : 'human', isOwnMessage: !agent && own, showSenderMeta: true,
      text: row.text, timestampMs: row.timestampMs,
      statusChips: !agent && row.requestState === 'queued' ? ['queued'] : undefined,
      time: row.timestampMs ? new Date(row.timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      mentions: row.mentions,
      turn: assistant && row.requestState && !(record.live === false && row.requestState === 'running') ? execution(row, row.activity?.tools)
        : tools ? execution({ ...row, requestState: 'completed' }, tools) : undefined,
      replyToMessageId: assistant ? row.requestId : undefined,
    };
  });
  const runTools = record.activity?.tools ?? [];
  if (live && !record.hasFollowupExecution || !live && runTools.length > 0) {
    const reversed = [...rows].reverse();
    const lastAnswer = reversed.find(row => row.role === 'assistant' && !row.requestId);
    const last = result.find(row => row.id === lastAnswer?.id);
    const taskBrief = reversed.find(row => row.senderAgentId === record.agentId);
    const progress = execution({ id: `runtime:${record.sessionId}`, role: 'assistant', text: '', timestampMs: 0, requestState: live ? 'running' : 'completed' },
      live ? runTools : runTools.map(settledTool));
    if (last) last.turn = { ...progress, tools: [...(last.turn?.tools ?? []), ...progress.tools], assistantText: last.text };
    else result.splice(result.findIndex(row => row.id === taskBrief?.id) + 1, 0,
      { id: progress.id, role: record.ownerAccountId === accountId ? 'owned-agent' : 'external-agent', senderType: 'agent', sender: record.agentDisplayName,
      senderOwnerName: record.ownerAccountId === accountId ? 'You' : record.ownerDisplayName,
      senderIdentityId: record.agentId, senderProfileImageUrl: record.agentAvatarUrl,
      senderAvatarSeed: record.agentId, text: '', time: '', turn: progress });
  }
  return result;
}

const LEGACY_TOOL_PREFIX = 'tool:';

function settledTool(tool: DesktopChatToolSnapshot): DesktopChatToolSnapshot {
  return tool.status === 'running' ? { ...tool, status: 'completed' } : tool;
}

/**
 * Older Cloud runs stored one "Using <tool>…" message per tool call. Fold each
 * consecutive run of them into the following answer, or into one summary row,
 * so existing threads read like the main transcript.
 */
export function collapseLegacyToolRows(messages: AgentSubsessionMessage[], live: boolean) {
  const rows: AgentSubsessionMessage[] = [];
  const legacyTools = new Map<string, DesktopChatToolSnapshot[]>();
  let pending: AgentSubsessionMessage[] = [];
  const flush = (into?: AgentSubsessionMessage) => {
    if (!pending.length) return;
    const tools = pending.map((row): DesktopChatToolSnapshot => ({ id: row.id.slice(LEGACY_TOOL_PREFIX.length),
      name: /^Using (.+?)…$/u.exec(row.text.trim())?.[1] ?? 'tool', status: 'completed', arguments: '', liveOutput: '', isError: false }));
    const target = into ?? { ...pending[0], id: `tools:${pending[0].id.slice(LEGACY_TOOL_PREFIX.length)}`, text: '' };
    if (!into) rows.push(target);
    legacyTools.set(target.id, tools);
    pending = [];
  };
  for (const row of messages) {
    if (row.role === 'assistant' && row.id.startsWith(LEGACY_TOOL_PREFIX)) { pending.push(row); continue; }
    if (row.role === 'assistant' && !row.requestId) { flush(row); rows.push(row); continue; }
    flush();
    rows.push(row);
  }
  const trailing = pending.length > 0;
  flush();
  // A still-running legacy run shows its latest call as the live tool.
  if (trailing && live) {
    const tools = legacyTools.get(rows[rows.length - 1].id);
    if (tools?.length) tools[tools.length - 1] = { ...tools[tools.length - 1], status: 'running' };
  }
  return { rows, legacyTools };
}

export function subsessionConversation(id: string, record: CloudAgentSubsession | null, accountId: string): Conversation {
  return {
    id, canonicalSessionId: id, agentSubsessionId: id,
    name: record?.title ? sentenceCaseAgentThreadTitle(record.title) : 'Agent session',
    type: record?.ownerAccountId === accountId ? 'owned-agent' : 'external-agent',
    subtitle: record ? `${record.agentDisplayName} · Owner · ${record.ownerAccountId === accountId ? 'You' : record.ownerDisplayName}` : 'Loading conversation…',
    unread: 0, collaborationSources: ['Cloud'], trust: 'Shared', directness: 'Agent session',
    participants: record ? (record.participants ?? []).map(person => person.displayName) : [],
    canonicalParticipants: record ? (record.participants ?? []).map(person => ({
      id: person.accountId, humanId: person.accountId, sourceIdentityId: person.accountId,
      name: person.displayName, kind: 'human' as const, source: 'cloud',
      role: person.accountId === accountId ? 'self' : 'participant',
      avatarKey: person.avatarSeed, profileImageUrl: person.avatarUrl,
    })) : [],
    avatarSeed: record?.agentId,
    profileImageUrl: record?.agentAvatarUrl,
    messages: record ? subsessionTranscript(record, accountId) : [],
  };
}

function execution(row: AgentSubsessionMessage, tools: DesktopChatToolSnapshot[] = []): NonNullable<Message['turn']> {
  const completed = ['completed', 'failed', 'cancelled'].includes(row.requestState ?? '');
  return { id: row.id, sessionId: '', prompt: '', status: row.requestState ?? 'running', message: '',
    assistantText: row.text, thinkingText: '', tools, completed, succeeded: row.requestState === 'completed', replyToMessageId: row.requestId };
}
