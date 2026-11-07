import { useCallback, useEffect, useRef, useState } from 'react';

import type { CloudGroupInvitation, CloudGroupInvitationCreateInput } from '@/features/cloud/authClient';
import { copyTextWhenReady } from '@/features/chat/copyTextWhenReady';
import { GroupInviteNotice } from './groupInviteNotice';

/** How long "Invite link copied" stays before it fades. */
export const GROUP_INVITE_NOTICE_MS = 4_000;

/** Started by Create group during its click, so the link can reach the clipboard. */
export type GroupInviteHandle = {
  /** The group exists: make its link, copy it and show the notice. */
  created: (groupId: string, groupTitle: string) => void;
  /** The group was not created: drop the pending copy. */
  cancel: () => void;
};

type Notice = { id: number; url: string; copied: boolean };
type CreateInvitation = (input: CloudGroupInvitationCreateInput) => Promise<CloudGroupInvitation>;

function pendingText() {
  let resolve!: (value: string) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

/**
 * A new group's invitation link: made right after Create group, copied, and
 * offered once in a short notice with Share…. A link or copy that fails stays
 * quiet; the link is always in Group Info › Add people.
 */
export function useGroupInviteAutoCopy(createInvitation: CreateInvitation | undefined) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const begin = useCallback((): GroupInviteHandle | null => {
    if (!createInvitation) return null;
    const link = pendingText();
    const copied = copyTextWhenReady(link.promise).then(() => true, () => false);
    return {
      cancel: () => link.reject(new Error('The group was not created.')),
      created: (groupId, groupTitle) => {
        void (async () => {
          let url: string;
          try {
            url = (await createInvitation({ groupId, groupSpaceId: groupId, groupTitle })).inviteUrl;
          } catch (error) {
            link.reject(error);
            return;
          }
          link.resolve(url);
          const wasCopied = await copied;
          if (live.current) setNotice({ id: Date.now(), url, copied: wasCopied });
        })();
      },
    };
  }, [createInvitation]);

  const dismiss = useCallback(() => setNotice(null), []);
  const element = notice
    ? <GroupInviteNotice key={notice.id} url={notice.url} copied={notice.copied} durationMs={GROUP_INVITE_NOTICE_MS} onDismiss={dismiss} />
    : null;
  return { begin, notice: element };
}

