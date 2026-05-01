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

function popoverStyle(anchorRect?: ChatCreatePopoverAnchor | null): CSSProperties {
  const width = 344;
  const fallbackLeft = 76;
  const fallbackTop = 86;
  if (!anchorRect) {
    return { left: fallbackLeft, top: fallbackTop };
  }

  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const anchorCenter = anchorRect.left + anchorRect.width / 2;
  const left = Math.min(Math.max(12, anchorCenter - width / 2), Math.max(12, viewportWidth - width - 12));
  const top = anchorRect.top + anchorRect.height + 12;
  return { left, top };
}

function DialogCard({ children, onClose, anchorRect }: { children: ReactNode; onClose: () => void; anchorRect?: ChatCreatePopoverAnchor | null }) {
  const style = popoverStyle(anchorRect);
  const anchorCenter = anchorRect ? anchorRect.left + anchorRect.width / 2 : 184;
  const arrowLeft = Math.min(Math.max(24, anchorCenter - Number(style.left ?? 0)), 320);

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 cursor-default bg-transparent"
        aria-label="Close create chat"
        onClick={onClose}
      />
      <div
        data-create-surface="popover"
        className="fixed z-50 w-[min(21.5rem,calc(100vw-1.5rem))] rounded-[22px] border border-white/55 bg-white/80 p-3.5 text-slate-950 shadow-[0_24px_60px_rgba(15,23,42,0.28)] backdrop-blur-2xl backdrop-saturate-150"
        style={style}
      >
        <div
          aria-hidden="true"
          className="absolute -top-2.5 h-5 w-5 rotate-45 border-l border-t border-white/55 bg-white/80 backdrop-blur-2xl"
          style={{ left: arrowLeft - 10 }}
        />
        <div className="relative">{children}</div>
      </div>
    </>
  );
}

function CreateDialogHeader({ title, subtitle, onClose }: { title: string; subtitle: string; onClose: () => void }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <div className="text-[15px] font-semibold text-slate-950">{title}</div>
        <div className="mt-0.5 text-[11px] leading-4 text-slate-500">{subtitle}</div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-[12px] text-slate-500 transition hover:bg-slate-950/8 hover:text-slate-950"
        aria-label="Close create chat"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function ChoiceButton({ icon, title, detail, onClick }: { icon: ReactNode; title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[16px] px-3 py-3 text-left transition hover:bg-slate-950/[0.06]"
    >
      <span className="grid h-9 w-9 place-items-center rounded-[14px] bg-slate-950/[0.08] text-slate-800">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-slate-950">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{detail}</span>
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
        subtitle={mode === 'group' ? 'Select at least 2 people. Agents can be invited into sessions later, but not as group members.' : 'Choose who this conversation is with.'}
        onClose={close}
      />

      {mode === 'menu' ? (
        <div className="space-y-2">
          <ChoiceButton icon={<MessageSquare className="h-4 w-4" />} title="Chat with person" detail="Open a direct people conversation." onClick={() => setMode('person')} />
          <ChoiceButton icon={<Bot className="h-4 w-4" />} title="Chat with agent" detail="Start with one Kordi agent." onClick={() => setMode('agent')} />
          <ChoiceButton icon={<Users className="h-4 w-4" />} title="Start group" detail="Create a stable group with people contacts only." onClick={() => setMode('group')} />
        </div>
      ) : null}

      {mode === 'person' ? (
        <div className="space-y-2">
          {personOptions.length > 0 ? personOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                void onStartPerson(option.contact);
                close();
              }}
              className="w-full rounded-[14px] border border-slate-950/10 bg-white/35 px-3 py-2.5 text-left transition hover:border-slate-950/15 hover:bg-white/60"
            >
              <span className="block text-[13px] font-medium text-slate-950">{option.label}</span>
              <span className="mt-0.5 block truncate text-[11px] text-slate-500">{option.detail}</span>
            </button>
          )) : (
            <div className="rounded-[14px] border border-slate-950/10 bg-white/35 px-3 py-3 text-[12px] text-slate-500">No people contacts available.</div>
          )}
          <Button type="button" variant="secondary" className="w-full rounded-[14px]" onClick={() => setMode('menu')}>Back</Button>
        </div>
      ) : null}

      {mode === 'agent' ? (
        <div className="space-y-2">
          {agentOptions.length > 0 ? agentOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                void onStartAgent(option.agent);
                close();
              }}
              className="w-full rounded-[14px] border border-slate-950/10 bg-white/35 px-3 py-2.5 text-left transition hover:border-slate-950/15 hover:bg-white/60"
            >
              <span className="block text-[13px] font-medium text-slate-950">{option.label}</span>
              <span className="mt-0.5 block truncate text-[11px] text-slate-500">{option.detail}</span>
            </button>
          )) : (
            <div className="rounded-[14px] border border-slate-950/10 bg-white/35 px-3 py-3 text-[12px] text-slate-500">No agents available.</div>
          )}
          <Button type="button" variant="secondary" className="w-full rounded-[14px]" onClick={() => setMode('menu')}>Back</Button>
        </div>
      ) : null}

      {mode === 'group' ? (
        <form
          className="space-y-3"
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
            className="w-full rounded-[14px] border border-slate-950/10 bg-white/55 px-3 py-2 text-[13px] text-slate-950 outline-none placeholder:text-slate-500"
          />
          <div className="max-h-64 space-y-1 overflow-auto pr-1">
            {personOptions.length > 0 ? personOptions.map((option) => {
              const selected = selectedContactIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => toggleContact(option.id)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-[14px] border px-3 py-2.5 text-left transition',
                    selected ? 'border-emerald-500/45 bg-emerald-400/15' : 'border-slate-950/10 bg-white/35 hover:border-slate-950/15 hover:bg-white/60',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-slate-950">{option.label}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500">{option.detail}</span>
                  </span>
                  <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px]', selected ? 'border-emerald-500 bg-emerald-400 text-slate-950' : 'border-slate-950/20 text-transparent')}>✓</span>
                </button>
              );
            }) : (
              <div className="rounded-[14px] border border-slate-950/10 bg-white/35 px-3 py-3 text-[12px] text-slate-500">No people contacts available.</div>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1 rounded-[14px]" onClick={() => setMode('menu')}>Back</Button>
            <Button type="submit" className="flex-1 rounded-[14px]" disabled={!canSubmitGroup}>
              {canSubmitGroup ? 'Create group' : 'Select at least 2 people'}
            </Button>
          </div>
        </form>
      ) : null}
    </DialogCard>
  );
}
