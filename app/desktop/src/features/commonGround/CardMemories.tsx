import { useId, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';

import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { MemoryCategoryChip } from '@/features/memory/MemoryCategoryChip';
import { lessonDateLabel } from '@/features/memory/memoryModel';
import { CgButton } from './parts';
import { moveTargets, type CgMoveTarget } from './storeMemories';
import type { CgProfile, CgRoutedMemory } from './types';
import { usePopoverDismiss } from './usePopoverDismiss';

function MoveMenu({ targets, onPick, onClose }: { targets: CgMoveTarget[]; onPick: (target: string | null) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  usePopoverDismiss(ref, '[data-cg-move]', onClose);
  return (
    <div ref={ref} className="cg-mem-menu" role="menu">
      {targets.map((target) => (
        <button key={target.profileId ?? 'none'} type="button" role="menuitem" className={target.profileId ? undefined : 'is-none'} onClick={() => onPick(target.profileId)}>
          {target.label}
        </button>
      ))}
    </div>
  );
}

function RemoveMemoryDialog({ memory, onCancel, onRemove }: { memory: CgRoutedMemory; onCancel: () => void; onRemove: () => void }) {
  const titleId = useId();
  const lineId = useId();
  return (
    <AppDialog titleId={titleId} descriptionId={lineId} onDismiss={onCancel} className="cg-dialog">
      <AppDialogTitle id={titleId}>Remove this memory?</AppDialogTitle>
      <AppDialogDescription id={lineId}>{memory.text}</AppDialogDescription>
      <AppDialogActions>
        <CgButton quiet onClick={onCancel}>Cancel</CgButton>
        <button type="button" className="cg-button is-danger" onClick={onRemove}>Remove</button>
      </AppDialogActions>
    </AppDialog>
  );
}

/** The card page's Memories: what the owner's agent filed to this profile, newest first. */
export function CardMemories({ memories, profiles, profileId, onMove, onRemove }: {
  memories: CgRoutedMemory[];
  profiles: CgProfile[];
  profileId: string;
  onMove: (memoryId: string, target: string | null) => void;
  onRemove: (memoryId: string) => void;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CgRoutedMemory | null>(null);
  if (!memories.length) return null;
  return (
    <section data-cg-memories="">
      <h3 className="cg-msec">Memories</h3>
      <div className="cg-panel">
        {memories.map((memory) => {
          const open = menu === memory.memoryId;
          const date = lessonDateLabel(memory.updatedAt);
          return (
            <div key={memory.memoryId} className="cg-mem" data-memory-id={memory.memoryId}>
              <span className="cg-mem-text">
                <span className="cg-mem-title">{memory.text}</span>
                <span className="cg-mem-sub">
                  <MemoryCategoryChip category={memory.category} className="ml-0" />
                  {date ? <span>{date}</span> : null}
                  {memory.everyProfile ? <span>· Every profile</span> : null}
                </span>
              </span>
              <button type="button" className="cg-line-act" data-cg-move="" aria-haspopup="menu" aria-expanded={open} onClick={() => setMenu(open ? null : memory.memoryId)}>
                <ArrowRight className="h-[13px] w-[13px]" aria-hidden="true" />Move to…
              </button>
              <button type="button" className="cg-line-act" onClick={() => setRemoving(memory)}>
                <X className="h-[13px] w-[13px]" aria-hidden="true" />Remove
              </button>
              {open ? (
                <MoveMenu
                  targets={moveTargets(memory, profiles, profileId)}
                  onClose={() => setMenu(null)}
                  onPick={(target) => { setMenu(null); onMove(memory.memoryId, target); }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {removing ? (
        <RemoveMemoryDialog
          memory={removing}
          onCancel={() => setRemoving(null)}
          onRemove={() => { setRemoving(null); onRemove(removing.memoryId); }}
        />
      ) : null}
    </section>
  );
}
