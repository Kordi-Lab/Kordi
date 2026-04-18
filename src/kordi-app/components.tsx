import { useState, type ReactNode } from 'react';
import {
  ArrowRightLeft,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Sparkles,
  SquareArrowOutUpRight,
  Undo2,
  User,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { composerModeOptions, composerModelOptions, composerThinkingOptions, contactRequests, settingsSections } from './data';
import type {
  ComposerScope,
  ComposerSelectorType,
  Contact,
  ConversationType,
  EditFilePreview,
  Message,
  ThemeMode,
} from './types';

export function TypeBadge({ type }: { type: ConversationType }) {
  if (type === 'person') {
    return (
      <Badge variant="secondary" className="app-badge-neutral gap-1 rounded-full px-2.5 py-1">
        <User className="h-3 w-3" />
        Human
      </Badge>
    );
  }
  if (type === 'owned-agent') {
    return (
      <Badge className="app-badge-owned gap-1 rounded-full px-2.5 py-1">
        <Sparkles className="h-3 w-3" />
        My agent
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="app-badge-neutral gap-1 rounded-full px-2.5 py-1">
      <Bot className="h-3 w-3" />
      External agent
    </Badge>
  );
}

export function StatusPill({ children }: { children: ReactNode }) {
  return (
    <div className="app-control-chip inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium [&_svg]:opacity-80">
      {children}
    </div>
  );
}

export function MessageBubble({ msg, onOpenSource }: { msg: Message; onOpenSource?: (file: EditFilePreview) => void }) {
  const [isEditExpanded, setIsEditExpanded] = useState(true);

  if (msg.role === 'system') {
    return (
      <div className="flex justify-center py-2">
        <div className="rounded-full border bg-muted px-3 py-1 text-xs text-muted-foreground">{msg.text}</div>
      </div>
    );
  }

  if (msg.role === 'action') {
    return (
      <div className="my-2 max-w-xl rounded-2xl border bg-card p-4 shadow-sm">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <ArrowRightLeft className="h-4 w-4" />
          {msg.sender}
        </div>
        <div className="text-sm">{msg.text}</div>
        <div className="mt-2 text-xs text-muted-foreground">{msg.detail}</div>
        <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock3 className="h-3 w-3" />
            {msg.time}
          </span>
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Trace visible
          </span>
        </div>
      </div>
    );
  }

  if (msg.role === 'edit' && msg.edit) {
    const primaryFile = msg.edit.files[0];

    return (
      <div className="flex flex-col items-start gap-1 py-1">
        <div className="text-xs text-muted-foreground">
          {msg.sender} • {msg.time}
        </div>
        <div className="app-detail-sheet w-full max-w-[680px]">
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="text-[14px] font-medium text-white/92">{msg.text}</div>
            <button className="inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-400 transition hover:text-slate-200">
              <Undo2 className="h-3.5 w-3.5" />
              Undo
            </button>
          </div>
          {primaryFile && (
            <>
              <div className="app-code-toolbar flex items-center justify-between border-t border-white/10 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5 text-[12px]">
                  <span className="truncate font-medium text-white/88">{primaryFile.path}</span>
                  <span className="font-medium text-emerald-400">+{primaryFile.additions}</span>
                  <span className="font-medium text-rose-400">-{primaryFile.deletions}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-400">
                  <button
                    type="button"
                    onClick={() => onOpenSource?.(primaryFile)}
                    className="app-icon-button grid h-6.5 w-6.5 place-items-center rounded-lg transition"
                    aria-label={`Open ${primaryFile.path}`}
                    title={`Open ${primaryFile.path}`}
                  >
                    <SquareArrowOutUpRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditExpanded((expanded) => !expanded)}
                    className="app-icon-button grid h-6.5 w-6.5 place-items-center rounded-lg transition"
                    aria-label={isEditExpanded ? 'Collapse diff preview' : 'Expand diff preview'}
                    title={isEditExpanded ? 'Collapse diff preview' : 'Expand diff preview'}
                  >
                    <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', isEditExpanded ? '' : 'rotate-180')} />
                  </button>
                </div>
              </div>
              {isEditExpanded && (
                <div className="app-code-panel px-0 py-2.5">
                  <div className="font-mono text-[11px] leading-6.5">
                    {primaryFile.lines.map((line, index) => (
                      <div
                        key={`${line.kind}-${line.oldNumber ?? 'n'}-${line.newNumber ?? 'n'}-${index}`}
                        className={cn(
                          'grid grid-cols-[48px_48px_minmax(0,1fr)] items-start px-4',
                          line.kind === 'remove' ? 'bg-rose-400/12' : '',
                          line.kind === 'add' ? 'bg-emerald-400/12' : '',
                        )}
                      >
                        <div className={cn('select-none pr-3 text-right', line.kind === 'remove' ? 'text-rose-300' : 'text-slate-500')}>
                          {line.oldNumber ?? ''}
                        </div>
                        <div className={cn('select-none pr-3 text-right', line.kind === 'add' ? 'text-emerald-300' : 'text-slate-500')}>
                          {line.newNumber ?? ''}
                        </div>
                        <code
                          className={cn(
                            'block min-w-0 overflow-hidden text-ellipsis whitespace-pre-wrap break-words',
                            line.kind === 'remove' ? 'text-rose-100' : line.kind === 'add' ? 'text-emerald-100' : 'text-slate-200',
                          )}
                        >
                          {line.text}
                        </code>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {msg.detail && <div className="border-t border-white/10 px-4 py-2.5 text-[11px] text-slate-400">{msg.detail}</div>}
        </div>
      </div>
    );
  }

  const isUser = msg.role === 'user';
  const align = isUser ? 'items-end' : 'items-start';
  const bubble = isUser ? 'app-chat-bubble-user' : msg.role === 'owned-agent' ? 'app-chat-bubble-peer' : 'app-chat-bubble-peer';

  return (
    <div className={`flex flex-col ${align} gap-1 py-1`}>
      <div className="text-xs text-muted-foreground">
        {msg.sender} • {msg.time}
      </div>
      <div className={`max-w-xl rounded-2xl px-4 py-3 text-sm shadow-sm ${bubble}`}>{msg.text}</div>
    </div>
  );
}

export function BridgeChip({ bridge }: { bridge: string }) {
  return <Badge variant="outline" className="app-control-chip rounded-full">{bridge}</Badge>;
}

export function SettingsValueControl({
  item,
  themeMode,
  onToggleTheme,
}: {
  item: (typeof settingsSections)[number]['items'][number];
  themeMode: ThemeMode;
  onToggleTheme: () => void;
}) {
  const controlType = item.control?.type ?? 'select';

  if (controlType === 'theme') {
    const isLightTheme = themeMode === 'light';
    return (
      <button
        type="button"
        onClick={onToggleTheme}
        className="app-input-shell flex min-w-[260px] items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-left transition"
      >
        <div className="flex items-center gap-3">
          <div
            className={cn('grid h-7 w-7 place-items-center rounded-lg text-[12px] font-semibold', isLightTheme ? 'bg-white text-slate-900' : 'bg-slate-950 text-slate-100')}
          >
            {isLightTheme ? 'L' : 'D'}
          </div>
          <div>
            <div className="text-[14px] font-medium">{isLightTheme ? 'Light mode' : 'Dark mode'}</div>
            <div className="text-[11px] text-slate-400">{isLightTheme ? 'Switch to dark' : 'Switch to light'}</div>
          </div>
        </div>
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
      </button>
    );
  }

  if (controlType === 'toggle') {
    const enabled = item.control?.enabled ?? false;
    return (
      <div
        className={cn(
          'relative h-10 w-[74px] rounded-full transition',
          enabled ? 'bg-emerald-500' : 'app-input-shell',
        )}
      >
        <div
          className={cn(
            'absolute top-1 h-8 w-8 rounded-full bg-white shadow-sm transition',
            enabled ? 'left-[34px]' : 'left-1',
          )}
        />
      </div>
    );
  }

  if (controlType === 'action') {
    return (
      <div className="flex items-center justify-end gap-2.5">
        <div className="text-[13px] font-medium text-slate-300">{item.value}</div>
        <button className="app-control-chip rounded-xl px-3 py-1.5 text-[13px] font-medium transition">
          {item.control?.actionLabel ?? 'Set'}
        </button>
      </div>
    );
  }

  return (
    <button className="app-input-shell flex min-w-[260px] items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-left transition">
      <div className="flex items-center gap-3">
        {item.control?.iconGlyph && (
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-slate-900 text-[14px] font-bold text-amber-400">
            {item.control.iconGlyph}
          </div>
        )}
        <div className="text-[14px] font-medium">{item.value}</div>
      </div>
      <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
    </button>
  );
}

export function ComposerModelControls({
  scope,
  selection,
  openSelector,
  onToggleSelector,
  onSelectValue,
}: {
  scope: ComposerScope;
  selection: { mode: string; model: string; thinking: string };
  openSelector: { scope: ComposerScope; type: ComposerSelectorType } | null;
  onToggleSelector: (scope: ComposerScope, type: ComposerSelectorType) => void;
  onSelectValue: (scope: ComposerScope, type: ComposerSelectorType, value: string) => void;
}) {
  const activeSelector = openSelector?.scope === scope ? openSelector.type : null;
  const activeOptions = activeSelector === 'model' ? composerModelOptions : composerThinkingOptions;

  return (
    <div className="relative flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onToggleSelector(scope, 'model')}
        className="inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 text-[12px] font-medium text-slate-300 transition hover:text-white"
      >
        <span>{selection.model}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-slate-500 transition-transform', activeSelector === 'model' ? 'rotate-180 text-slate-300' : '')} />
      </button>
      <button
        type="button"
        onClick={() => onToggleSelector(scope, 'thinking')}
        className="inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 text-[12px] font-medium text-slate-300 transition hover:text-white"
      >
        <span>{selection.thinking}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-slate-500 transition-transform', activeSelector === 'thinking' ? 'rotate-180 text-slate-300' : '')} />
      </button>
      {activeSelector && activeSelector !== 'mode' && (
        <div className="app-modal-panel absolute bottom-full right-0 z-30 mb-2 w-[300px] rounded-[24px] border border-[color:var(--app-divider)] p-2.5 shadow-[var(--app-shadow-float)] backdrop-blur-2xl">
          <div className="px-2 pb-2 pt-1 text-[12px] font-medium text-slate-400">
            {activeSelector === 'model' ? 'Provider / Model' : 'Thinking level'}
          </div>
          <div className="space-y-1">
            {activeOptions.map((option) => {
              const isSelected = activeSelector === 'model' ? selection.model === option : selection.thinking === option;

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onSelectValue(scope, activeSelector, option)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-[18px] px-3 py-2 text-left text-[13px] transition',
                    isSelected ? 'app-list-item-active text-white' : 'app-list-item text-slate-300 hover:text-white',
                  )}
                >
                  <span>{option}</span>
                  {isSelected && <Check className="h-4 w-4 text-white" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function ComposerModeControl({
  scope,
  selection,
  openSelector,
  onToggleSelector,
  onSelectValue,
}: {
  scope: ComposerScope;
  selection: { mode: string; model: string; thinking: string };
  openSelector: { scope: ComposerScope; type: ComposerSelectorType } | null;
  onToggleSelector: (scope: ComposerScope, type: ComposerSelectorType) => void;
  onSelectValue: (scope: ComposerScope, type: ComposerSelectorType, value: string) => void;
}) {
  const activeSelector = openSelector?.scope === scope ? openSelector.type : null;
  const activeOptions = composerModeOptions[scope];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onToggleSelector(scope, 'mode')}
        className="app-mode-tab inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition"
      >
        <span>{selection.mode}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', activeSelector === 'mode' ? 'rotate-180' : '')} />
      </button>
      {activeSelector === 'mode' && (
        <div className="app-modal-panel absolute bottom-full left-0 z-30 mb-2 min-w-[260px] rounded-[24px] border border-[color:var(--app-divider)] p-2.5 shadow-[var(--app-shadow-float)] backdrop-blur-2xl">
          <div className="px-2 pb-2 pt-1 text-[12px] font-medium text-slate-400">Compose mode</div>
          <div className="space-y-1">
            {activeOptions.map((option) => {
              const isSelected = selection.mode === option;

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onSelectValue(scope, 'mode', option)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-[18px] px-3 py-2 text-left text-[13px] transition',
                    isSelected ? 'app-list-item-active text-white' : 'app-list-item text-slate-300 hover:text-white',
                  )}
                >
                  <span>{option}</span>
                  {isSelected && <Check className="h-4 w-4 text-white" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function ContactRow({ contact, active, onSelect }: { contact: Contact; active: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition ${
        active ? 'app-list-item-active text-white' : 'app-list-item text-white'
      }`}
    >
      <Avatar className="h-10 w-10 border border-white/10">
        <AvatarFallback className={active ? 'bg-slate-100 text-slate-950' : 'bg-slate-800 text-slate-100'}>{contact.initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{contact.name}</span>
          <span className={`text-[11px] ${active ? 'text-slate-100' : 'text-slate-300'}`}>{contact.entityType}</span>
        </div>
        <div className={`truncate text-xs ${active ? 'text-slate-100' : 'text-slate-300'}`}>{contact.subtitle}</div>
      </div>
      <ChevronRight className={`h-4 w-4 ${active ? 'text-slate-200' : 'text-slate-500'}`} />
    </button>
  );
}

export function ContactRequestRow({
  request,
  active,
  onReview,
}: {
  request: (typeof contactRequests)[number];
  active: boolean;
  onReview: () => void;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl px-3 py-3 transition',
        active ? 'app-list-item-active text-white' : 'app-list-item bg-transparent text-white',
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar className="h-10 w-10 border border-white/10">
          <AvatarFallback className={active ? 'bg-slate-100 text-slate-950' : 'bg-slate-800 text-slate-100'}>{request.initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="truncate text-sm font-medium">{request.title}</div>
            <div className="shrink-0 text-[11px] text-slate-400">{request.time}</div>
          </div>
          <div className={`mt-1 text-xs ${active ? 'text-slate-100' : 'text-slate-300'}`}>{request.detail}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" className="h-8 rounded-xl px-3 text-[11px]" onClick={onReview}>
              Review details
            </Button>
            <Button className="h-8 rounded-xl px-3 text-[11px]">Accept</Button>
            <Button variant="secondary" className="h-8 rounded-xl px-3 text-[11px]">
              Reject
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
