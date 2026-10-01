import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from '@/features/cloud/avatar';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import { IdentityAvatar } from '@/kordi-app/components/IdentityAvatar';

import { useSafetyActions } from './safetyActions';
import { useCloudBlocks } from './useCloudBlocks';

/** Collapsible list of the person's private blocks, at the end of Contacts. */
export function BlockedAccountsSection() {
  const safety = useSafetyActions();
  const blocks = useCloudBlocks(safety.account);
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!safety.safetyFeaturesAvailable) return null;

  return (
    <section className="app-contacts-blocked-accounts mt-3 border-t border-white/10 pt-1" aria-label="Blocked accounts">
      <button
        type="button"
        className="app-contacts-group-row flex w-full items-center justify-between px-2 py-3 text-left transition-none"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex items-center gap-3">
          {open ? <ChevronDown className="h-4 w-4 text-slate-300" /> : <ChevronRight className="h-4 w-4 text-slate-300" />}
          <span className="text-[13px] font-medium leading-5 text-white">Blocked accounts</span>
        </span>
        <span className="text-[12px] text-slate-400">{blocks.blocks.length}</span>
      </button>
      {open ? (
        <div id={listId} className="grid gap-1 pb-2">
          {blocks.blocks.length === 0 ? (
            <p className="m-0 px-3 py-2 text-[12px] text-slate-400">You haven&apos;t blocked anyone.</p>
          ) : blocks.blocks.map((block) => {
            const name = block.displayName?.trim() || formatKordiHandle(block.kordiId) || 'Kordi user';
            return (
              <div key={block.accountId} className="flex items-center gap-3 px-3 py-2 text-white">
                <IdentityAvatar
                  kind="human"
                  seed={cloudAvatarSeedForAccount(block.accountId, block.avatarUrl)}
                  name={name}
                  imageUrl={cloudAvatarImageUrl(block.avatarUrl)}
                  className="h-8 w-8 border border-white/10"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium leading-5">{name}</div>
                  <div className="truncate text-[11px] leading-4 text-slate-400">{formatKordiHandle(block.kordiId) ?? ''}</div>
                </div>
                <button
                  type="button"
                  className="app-contacts-action-chip app-button-quiet h-8 shrink-0 rounded-full px-3 text-[12px]"
                  aria-label={`Unblock ${name}`}
                  onClick={() => safety.openUnblock({ accountId: block.accountId, name })}
                >
                  Unblock
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
