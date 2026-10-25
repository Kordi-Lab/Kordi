import { useId, useRef, useState } from 'react';
import { Check, Minus, Plus, Trash2 } from 'lucide-react';

import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { MemoryCategoryChip } from '@/features/memory/MemoryCategoryChip';
import { lessonDateLabel } from '@/features/memory/memoryModel';
import { CgButton } from './parts';
import { cardChoices, type CgCardChoice } from './storeMemories';
import type { CgProfile, CgRoutedMemory } from './types';
import { usePopoverDismiss } from './usePopoverDismiss';

/** Add to card…: the other cards as a checklist; a checked card already has the memory. */
function CardChecklist({ choices, onPick, onClose }: { choices: CgCardChoice[]; onPick: (profileId: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  usePopoverDismiss(ref, '[data-cg-add-card]', onClose);
  return (
    <div ref={ref} className="cg-mem-menu" role="menu">
      {choices.map((choice) => (
        <button
          key={choice.profileId}
          type="button"
          role="menuitemcheckbox"
          aria-checked={choice.on}
          disabled={choice.on}
          className="cg-mem-check"
          onClick={() => onPick(choice.profileId)}
        >
          <span className="cg-mem-tick">{choice.on ? <Check className="h-[13px] w-[13px]" aria-hidden="true" /> : null}</span>
          {choice.label}
        </button>
      ))}
    </div>
  );
}

function DeleteMemoryDialog({ memory, onCancel, onDelete }: { memory: CgRoutedMemory; onCancel: () => void; onDelete: () => void }) {
  const titleId = useId();
  const lineId = useId();
  return (
    <AppDialog titleId={titleId} descriptionId={lineId} onDismiss={onCancel} className="cg-dialog">
      <AppDialogTitle id={titleId}>Delete this memory?</AppDialogTitle>
      <AppDialogDescription id={lineId}>{memory.text}</AppDialogDescription>
      <AppDialogActions>
        <CgButton quiet onClick={onCancel}>Cancel</CgButton>
        <button type="button" className="cg-button is-danger" onClick={onDelete}>Delete</button>
      </AppDialogActions>
    </AppDialog>
  );
}

/**
 * The card page's Memories: the owner's memories on this card, newest first. With several cards per
 * memory (`cardsEnabled`, `memoryVersion` 3) a memory can be added to other cards or removed from this one.
 */
export function CardMemories({ memories, profiles, profileId, cardsEnabled = false, onAddToCard, onRemoveFromCard, onDelete }: {
  memories: CgRoutedMemory[];
  profiles: CgProfile[];
  profileId: string;
  cardsEnabled?: boolean;
  onAddToCard: (memoryId: string, target: string) => void;
  onRemoveFromCard: (memoryId: string) => void;
  onDelete: (memoryId: string) => void;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CgRoutedMemory | null>(null);
  if (!memories.length) return null;
  return (
    <section data-cg-memories="">
      <h3 className="cg-msec">Memories</h3>
      <div className="cg-panel">
        {memories.map((memory) => {
          const open = menu === memory.memoryId;
          const date = lessonDateLabel(memory.updatedAt);
          const choices = cardsEnabled ? cardChoices(memory, profiles, profileId) : [];
          return (
            <div key={memory.memoryId} className="cg-mem" data-memory-id={memory.memoryId}>
              <span className="cg-mem-text">
                <span className="cg-mem-title">{memory.text}</span>
                <span className="cg-mem-sub">
                  <MemoryCategoryChip category={memory.category} className="ml-0" />
                  {date ? <span>{date}</span> : null}
                  {memory.everyProfile ? <span>· Every card</span> : null}
                </span>
              </span>
              {choices.length ? (
                <button type="button" className="cg-line-act" data-cg-add-card="" aria-haspopup="menu" aria-expanded={open} onClick={() => setMenu(open ? null : memory.memoryId)}>
                  <Plus className="h-[13px] w-[13px]" aria-hidden="true" />Add to card…
                </button>
              ) : null}
              {cardsEnabled ? (
                <button type="button" className="cg-line-act" data-cg-remove-card="" onClick={() => onRemoveFromCard(memory.memoryId)}>
                  <Minus className="h-[13px] w-[13px]" aria-hidden="true" />Remove from card
                </button>
              ) : null}
              <button type="button" className="cg-line-act" data-cg-delete-memory="" onClick={() => setDeleting(memory)}>
                <Trash2 className="h-[13px] w-[13px]" aria-hidden="true" />Delete
              </button>
              {open ? (
                <CardChecklist
                  choices={choices}
                  onClose={() => setMenu(null)}
                  onPick={(target) => { setMenu(null); onAddToCard(memory.memoryId, target); }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {deleting ? (
        <DeleteMemoryDialog
          memory={deleting}
          onCancel={() => setDeleting(null)}
          onDelete={() => { setDeleting(null); onDelete(deleting.memoryId); }}
        />
      ) : null}
    </section>
  );
}
