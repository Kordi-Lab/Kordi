import { transcriptMessageIsOwnHuman, transcriptMessageIsPeerHuman } from '@/kordi-app/components/transcriptMessageHumanRole';
import type { Message, MessageSourceReference } from '@/kordi-app/types';
import { generatedAvatarSeedForLabel, isSelfReferenceName, isValidAvatarSeed } from '@/lib/identityLabels';

type SourceAvatarKind = 'human' | 'agent';

function clean(value?: string | null) {
  return value?.trim() ?? '';
}

type SourceAvatarFields = Pick<
  MessageSourceReference,
  'senderKind' | 'senderAvatarSeed' | 'senderProfileImageUrl' | 'senderIsSelf'
>;

export type SourceQuoteAvatar = {
  kind: SourceAvatarKind;
  seed: string;
  imageUrl: string | null;
  isSelf: boolean;
};

/** Copies the avatar a transcript row shows for its sender into a quote of that row. */
export function sourceAvatarFieldsForMessage(message: Message): SourceAvatarFields {
  const ownHuman = transcriptMessageIsOwnHuman(message);
  const peerHuman = transcriptMessageIsPeerHuman(message, ownHuman);
  const human = ownHuman || peerHuman;
  return {
    senderKind: human ? 'human' : 'agent',
    senderAvatarSeed: clean(message.senderAvatarSeed) || null,
    senderProfileImageUrl: clean(message.senderProfileImageUrl) || null,
    senderIsSelf: ownHuman || (!human && message.role === 'owned-agent'),
  };
}

/** Fills a stored quote's missing avatar from the quoted message when it is loaded. */
export function withKnownSourceAvatar(
  source: MessageSourceReference,
  known?: MessageSourceReference | null,
): MessageSourceReference {
  if (source.senderKind || !known?.senderKind || known.messageId !== source.messageId) return source;
  return {
    ...source,
    senderKind: known.senderKind,
    senderAvatarSeed: known.senderAvatarSeed,
    senderProfileImageUrl: known.senderProfileImageUrl,
    senderIsSelf: known.senderIsSelf,
  };
}

export function sourceQuoteAvatar(
  source: MessageSourceReference,
  local: { selfDisplayName?: string | null; profileAvatarSeed: string; agentAvatarSeed: string },
): SourceQuoteAvatar {
  const label = clean(source.senderLabel);
  const kind: SourceAvatarKind = source.senderKind ?? 'human';
  const isSelf = source.senderIsSelf
    ?? (kind === 'human' && (isSelfReferenceName(label) || (Boolean(label) && label === clean(local.selfDisplayName))));
  if (isSelf) {
    return kind === 'agent'
      ? { kind, seed: local.agentAvatarSeed, imageUrl: null, isSelf: false }
      : { kind, seed: local.profileAvatarSeed, imageUrl: null, isSelf: true };
  }
  const seed = clean(source.senderAvatarSeed);
  return {
    kind,
    seed: isValidAvatarSeed(seed) ? seed : generatedAvatarSeedForLabel(kind, label),
    imageUrl: clean(source.senderProfileImageUrl) || null,
    isSelf: false,
  };
}
