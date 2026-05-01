import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Bot, MessageSquare, Users, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  buildChatCreateAgentOptions,
  buildChatCreatePersonOptions,
  canCreateGroup,
  groupDefaultName,
} from '@/features/chat/chatCreateFlows';
import type { Agent, Contact } from '@/kordi-app/types';
import type { CreateChatGroupRequest } from '@/app/kordiShellSlots.types';
import { cn } from '@/lib/utils';

export type ChatCreatePopoverAnchor = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ChatCreateDialogProps = {
  isOpen: boolean;
  contacts: Contact[];
  agents: Agent[];
  onClose: () => void;
  onStartPerson: (contact: Contact) => Promise<void> | void;
  onStartAgent: (agent: Agent) => Promise<void> | void;
  onCreateGroup: (request: CreateChatGroupRequest) => Promise<void> | void;
  initialMode?: 'menu' | 'person' | 'agent' | 'group';
  anchorRect?: ChatCreatePopoverAnchor | null;
};

type CreateMode = 'menu' | 'person' | 'agent' | 'group';
type PopoverPlacement = 'right' | 'left' | 'floating';
type PopoverStyle = CSSProperties & {
  '--app-create-enter-x'?: string;
  '--app-popover-origin'?: string;
};

type PopoverGeometry = {
  style: PopoverStyle;
  arrowStyle: CSSProperties;
  placement: PopoverPlacement;
};

function popoverGeometry(anchorRect?: ChatCreatePopoverAnchor | null): PopoverGeometry {
  const width = 284;
  const gap = 10;
  const margin = 10;
  const fallbackLeft = 92;
  const fallbackTop = 74;

  if (!anchorRect) {
    return {
      placement: 'floating',
      arrowStyle: { top: 18 },
      style: {
        left: fallbackLeft,
        top: fallbackTop,
        '--app-create-enter-x': '-6px',
        '--app-popover-origin': 'left 22px',
      },
    };
  }

  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const rightLeft = anchorRect.left + anchorRect.width + gap;
  const leftLeft = anchorRect.left - width - gap;
  const canFitRight = rightLeft + width <= viewportWidth - margin;
  const canFitLeft = leftLeft >= margin;
  const placement: PopoverPlacement = canFitRight || !canFitLeft ? 'right' : 'left';
  const unclampedLeft = placement === 'right' ? rightLeft : leftLeft;
  const left = Math.min(Math.max(margin, unclampedLeft), Math.max(margin, viewportWidth - width - margin));
  const top = Math.min(Math.max(margin, anchorRect.top - 4), Math.max(margin, viewportHeight - 220));
  const anchorCenterY = anchorRect.top + anchorRect.height / 2;
  const arrowTop = Math.min(Math.max(18, anchorCenterY - top - 6), 54);

  return {
    placement,
    arrowStyle: { top: arrowTop },
    style: {
      left,
      top,
      '--app-create-enter-x': placement === 'right' ? '-8px' : '8px',
      '--app-popover-origin': placement === 'right' ? 'left 22px' : 'right 22px',
    },
  };
}

function DialogCard({ children, onClose, anchorRect }: { children: ReactNode; onClose: () => void; anchorRect?: ChatCreatePopoverAnchor | null }) {
  const { style, arrowStyle, placement } = popoverGeometry(anchorRect);

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 cursor-default bg-transparent"
        aria-label="Close create chat"
        onClick={onClose}
      />
      <div
        data-create-surface="side-popover"
        data-popover-placement={placement}
        className="app-chat-create-popover app-chat-create-popover-enter fixed z-50 w-[min(17.75rem,calc(100vw-1.25rem))] overflow-hidden rounded-[18px] p-2.5 backdrop-blur-2xl backdrop-saturate-150"
        style={style}
      >
        {placement !== 'floating' ? (
          <div
            aria-hidden="true"
            className={cn(
              'app-chat-create-popover-arrow absolute h-3.5 w-3.5 rotate-45',
              placement === 'right' ? '-left-[0.45rem]' : '-right-[0.45rem]',
            )}
            style={arrowStyle}
          />
        ) : null}
        <div className="relative">{children}</div>
      </div>
    </>
  );
}

function CreateDialogHeader({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="mb-2 flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold leading-5 text-[color:var(--utility-foreground)]">{title}</div>
        <div className="mt-px text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">{subtitle}</div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="app-chat-create-close grid h-6 w-6 shrink-0 place-items-center rounded-[9px] transition"
        aria-label="Close create chat"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ChoiceButton({ icon, title, detail, onClick }: { icon: ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="app-chat-create-choice flex w-full items-center gap-2 rounded-[13px] px-2 py-2 text-left transition"
    >
      <span className="app-chat-create-icon grid h-7 w-7 shrink-0 place-items-center rounded-[10px]">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-semibold leading-4 text-[color:var(--utility-foreground)]">{title}</span>
        <span className="mt-px block truncate text-[10.5px] leading-4 text-[color:var(--utility-muted-text)]">{detail}</span>
      </span>
    </button>
  );
}

export function ChatCreateDialog({
  isOpen,
  contacts,
  agents,
  onClose,
  onStartPerson,
  onStartAgent,
  onCreateGroup,
  initialMode = 'menu',
  anchorRect = null,
}: ChatCreateDialogProps) {
  const [mode, setMode] = useState<CreateMode>(initialMode);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const personOptions = useMemo(() => buildChatCreatePersonOptions(contacts), [contacts]);
  const agentOptions = useMemo(() => buildChatCreateAgentOptions(agents), [agents]);
  const selectedPeople = personOptions.filter((option) => selectedContactIds.includes(option.id));
  const defaultGroupName = groupDefaultName(selectedPeople.map((option) => option.label));
  const canSubmitGroup = canCreateGroup(selectedContactIds);

  if (!isOpen) return null;

  const close = () => {
    setMode('menu');
    setSelectedContactIds([]);
    setGroupName('');
    onClose();
  };

  const toggleContact = (contactId: string) => {
    setSelectedContactIds((current) => (
      current.includes(contactId)
        ? current.filter((id) => id !== contactId)
        : [...current, contactId]
    ));
  };

  return (
    <DialogCard onClose={close} anchorRect={anchorRect}>
      <CreateDialogHeader
        title={mode === 'menu' ? 'Start a chat' : mode === 'person' ? 'Chat with person' : mode === 'agent' ? 'Chat with agent' : 'Start group'}
        subtitle={mode === 'group' ? 'Select at least 2 people. Agents are added later.' : 'Choose who this conversation is with.'}
        onClose={close}
      />

      {mode === 'menu' ? (
        <div className="space-y-1">
          <ChoiceButton icon={<MessageSquare className="h-3.5 w-3.5" />} title="Chat with person" detail="Direct people conversation" onClick={() => setMode('person')} />
          <ChoiceButton icon={<Bot className="h-3.5 w-3.5" />} title="Chat with agent" detail="Start with one Kordi agent" onClick={() => setMode('agent')} />
          <ChoiceButton icon={<Users className="h-3.5 w-3.5" />} title="Start group" detail="Stable group with people only" onClick={() => setMode('group')} />
        </div>
      ) : null}

      {mode === 'person' ? (
        <div className="space-y-2">
          <div className="app-chat-create-option-list max-h-[min(18rem,calc(100vh-8rem))] space-y-1 overflow-auto pr-1">
            {personOptions.length > 0 ? personOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  void onStartPerson(option.contact);
                  close();
                }}
                className="app-chat-create-list-item w-full rounded-[12px] border px-2.5 py-2 text-left transition"
              >
                <span className="block truncate text-[12.5px] font-medium leading-4 text-[color:var(--utility-foreground)]">{option.label}</span>
                <span className="mt-px block truncate text-[10.5px] text-[color:var(--utility-muted-text)]">{option.detail}</span>
              </button>
            )) : (
              <div className="app-chat-create-empty rounded-[12px] border px-2.5 py-2.5 text-[11px]">No people contacts available.</div>
            )}
          </div>
          <Button type="button" variant="secondary" className="h-8 w-full rounded-[12px] text-[12px]" onClick={() => setMode('menu')}>Back</Button>
        </div>
      ) : null}

      {mode === 'agent' ? (
        <div className="space-y-2">
          <div className="app-chat-create-option-list max-h-[min(18rem,calc(100vh-8rem))] space-y-1 overflow-auto pr-1">
            {agentOptions.length > 0 ? agentOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  void onStartAgent(option.agent);
                  close();
                }}
                className="app-chat-create-list-item w-full rounded-[12px] border px-2.5 py-2 text-left transition"
              >
                <span className="block truncate text-[12.5px] font-medium leading-4 text-[color:var(--utility-foreground)]">{option.label}</span>
                <span className="mt-px block truncate text-[10.5px] text-[color:var(--utility-muted-text)]">{option.detail}</span>
              </button>
            )) : (
              <div className="app-chat-create-empty rounded-[12px] border px-2.5 py-2.5 text-[11px]">No agents available.</div>
            )}
          </div>
          <Button type="button" variant="secondary" className="h-8 w-full rounded-[12px] text-[12px]" onClick={() => setMode('menu')}>Back</Button>
        </div>
      ) : null}

      {mode === 'group' ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmitGroup) return;
            void onCreateGroup({ contactIds: selectedContactIds, name: groupName.trim() || null });
            close();
          }}
        >
          <input
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder={defaultGroupName || 'Group name (optional)'}
            className="app-input-shell h-8 w-full rounded-[12px] px-2.5 text-[12px] outline-none"
          />
          <div className="app-chat-create-option-list max-h-[min(14.5rem,calc(100vh-10rem))] space-y-1 overflow-auto pr-1">
            {personOptions.length > 0 ? personOptions.map((option) => {
              const selected = selectedContactIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => toggleContact(option.id)}
                  className={cn(
                    'app-chat-create-list-item flex w-full items-center justify-between gap-2 rounded-[12px] border px-2.5 py-2 text-left transition',
                    selected && 'app-chat-create-list-item-selected',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium leading-4 text-[color:var(--utility-foreground)]">{option.label}</span>
                    <span className="mt-px block truncate text-[10.5px] text-[color:var(--utility-muted-text)]">{option.detail}</span>
                  </span>
                  <span className={cn('app-chat-create-check grid h-[1.125rem] w-[1.125rem] shrink-0 place-items-center rounded-full border text-[9px]', selected && 'app-chat-create-check-selected')}>✓</span>
                </button>
              );
            }) : (
              <div className="app-chat-create-empty rounded-[12px] border px-2.5 py-2.5 text-[11px]">No people contacts available.</div>
            )}
          </div>
          <div className="flex gap-1.5">
            <Button type="button" variant="secondary" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" onClick={() => setMode('menu')}>Back</Button>
            <Button type="submit" className="h-8 flex-1 rounded-[12px] px-3 text-[12px]" disabled={!canSubmitGroup}>
              {canSubmitGroup ? 'Create group' : 'Pick 2 people'}
            </Button>
          </div>
        </form>
      ) : null}
    </DialogCard>
  );
}
