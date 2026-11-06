import type { ComposerMentionOption } from '@/kordi-app/components/composer';

// Which chat sends reach an AI model. People-to-people messages always send;
// an agent chat, an @mention of an agent, or "@kordi" in a group asks first.

const KORDI_ALIAS = /(^|\s)@(?:kordi|my\s*kordi)(?=$|[\s:;,.!?—-])/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the draft @mentions one of the agents the composer offers. */
export function draftMentionsAgent(draft: string, options: readonly Pick<ComposerMentionOption, 'value' | 'targetKind'>[]): boolean {
  if (!draft.includes('@')) return false;
  if (KORDI_ALIAS.test(draft)) return true;
  return options.some((option) => option.targetKind === 'agent' && option.value.trim().length > 0
    && new RegExp(`@${escapeRegExp(option.value.trim())}(?=$|[\\s:;,.!?—)-])`, 'iu').test(draft));
}

export function chatSendNeedsAiConsent({
  paneKind,
  draft,
  mentionOptions,
  asksAgent = false,
}: {
  paneKind: 'human' | 'agent' | null;
  draft: string;
  mentionOptions: readonly Pick<ComposerMentionOption, 'value' | 'targetKind'>[];
  /** The draft is an "ask the agent" command that opens an agent session. */
  asksAgent?: boolean;
}): boolean {
  return paneKind === 'agent' || asksAgent || draftMentionsAgent(draft, mentionOptions);
}
