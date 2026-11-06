import type { ReactNode } from 'react';

import type { Message } from '@/kordi-app/types';

import { blockedMessageRevealKey, shouldCollapseBlockedMessage } from './blockedMessageAuthor';
import { revealBlockedMessage, useRevealedBlockedMessageKeys } from './blockedMessageReveal';
import { useSafetyActions } from './safetyActions';

export const BLOCKED_MESSAGE_LABEL = 'Message from a blocked account';

/** In a group chat, shows one collapsed row for a blocked account's message until the viewer opens it. */
export function BlockedMessageGate({
  message,
  groupConversation,
  children,
}: {
  message: Message;
  groupConversation: boolean;
  children: ReactNode;
}) {
  const { blockedAccountIds } = useSafetyActions();
  const revealedKeys = useRevealedBlockedMessageKeys();
  if (!shouldCollapseBlockedMessage({ message, groupConversation, blockedAccountIds, revealedKeys })) return children;
  const key = blockedMessageRevealKey(message);
  return (
    <div
      className="flex justify-center px-2 py-1 text-center text-[11px] font-normal leading-4 text-[color:var(--utility-muted-text)]"
      data-blocked-message="true"
    >
      <button
        type="button"
        className="cursor-pointer rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        disabled={!key}
        onClick={() => revealBlockedMessage(key)}
      >
        {BLOCKED_MESSAGE_LABEL}
      </button>
    </div>
  );
}
