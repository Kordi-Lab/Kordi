import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { ErrorLine, withoutTryAgain } from '@/components/ui/errors';
import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from '@/features/cloud/avatar';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';
import { settingsType } from '@/kordi-app/components/settingsType';
import { cn } from '@/lib/utils';

import { useSafetyActions } from './safetyActions';
import type { CloudBlockedAccount } from './safetyTypes';

function blockedAccountName(block: CloudBlockedAccount): string {
  return block.displayName?.trim() || formatKordiHandle(block.kordiId) || 'Kordi user';
}

/** Settings › Blocked: the people the signed-in account blocked, with Unblock. */
export function BlockedAccountsPanel() {
  const safety = useSafetyActions();
  const { blocks, refreshBlocks } = safety;
  // Opening the page reloads the list, so a block from another device shows up.
  useEffect(() => { void refreshBlocks(); }, [refreshBlocks]);

  return (
    <div className="app-cloud-account-settings-section max-w-[680px] py-1">
      <h2 className={cn('m-0', settingsType.heading)}>Blocked</h2>
      {safety.blocksError && blocks.length === 0 ? (
        <ErrorLine className="mt-4" action={{ label: 'Try again', onClick: () => { void refreshBlocks(); } }}>
          {withoutTryAgain(safety.blocksError)}
        </ErrorLine>
      ) : !safety.blocksLoaded && blocks.length === 0 ? (
        <div className="grid min-h-32 place-items-center text-[12px] text-slate-400" role="status">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="grid min-h-32 place-items-center text-center">
          <div className="text-[13px] font-medium text-white">No one blocked</div>
        </div>
      ) : (
        <ul className="m-0 mt-3 list-none divide-y divide-[color:var(--app-divider)] p-0" aria-label="Blocked">
          {blocks.map((block) => {
            const name = blockedAccountName(block);
            const handle = formatKordiHandle(block.kordiId);
            return (
              <li key={block.accountId} className="flex items-center gap-3 py-2.5">
                <IdentityAvatar
                  kind="human"
                  seed={cloudAvatarSeedForAccount(block.accountId, block.avatarUrl)}
                  name={name}
                  imageUrl={cloudAvatarImageUrl(block.avatarUrl)}
                  cornerRadius="50%"
                  className="h-9 w-9 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className={cn('truncate', settingsType.rowTitle)}>{name}</div>
                  {handle && handle !== name ? <p className={cn('m-0 mt-0.5 truncate', settingsType.description)}>{handle}</p> : null}
                </div>
                <Button
                  variant="secondary"
                  className="h-7 shrink-0 rounded-full px-2.5 text-[12px]"
                  aria-label={`Unblock ${name}`}
                  onClick={() => safety.openUnblock({ accountId: block.accountId, name })}
                >
                  Unblock
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
