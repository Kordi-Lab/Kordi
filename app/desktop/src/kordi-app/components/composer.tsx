import { ModelEffortPicker } from './modelEffortPicker';
import { useEffect, useRef } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  HelpCircle,
  ImagePlus,
  LogIn,
  LogOut,
  RefreshCw,
  Settings2,
  Sparkles,
  Wrench,
} from 'lucide-react';

import { cn } from '@/lib/utils';

export {
  fallbackComposerThinkingValue,
  normalizeComposerThinkingLevels,
} from './composerThinking';
export { ComposerMentionMenu } from './composerMentionMenu';
export { ComposerRuntimeStatus } from './composerRuntimeStatus';
import {
  resolveComposerModelSelection,
  type ComposerModelOption,
  type ComposerProviderOption,
  type ComposerRoute,
} from './composerModelSelection';
import { composerModeOptions, composerModelOptions, composerThinkingOptions } from '../data';
import type {
  ComposerScope,
  ComposerSelectorType,
  DesktopChatSlashCommand,
} from '../types';

export type ComposerAuthOption = {
  providerId: string;
  providerLabel: string;
  methodLabel: string;
  value: string;
  label: string;
  detail?: string | null;
  active: boolean;
};

export type { ComposerModelOption, ComposerProviderOption } from './composerModelSelection';

export type ComposerMentionOption = {
  value: string;
  label: string;
  detail?: string | null;
  targetKind: 'agent' | 'person' | 'all' | 'reference';
  sourceHostId: string;
  nodeId: string;
  runtime: string;
  humanId?: string | null;
  agentId?: string | null;
  ownerName?: string | null;
  avatarImageUrl?: string | null;
  avatarSeed?: string | null;
  unreadCount?: number;
  referenceKind?: 'file' | 'directory' | 'url';
  referencePath?: string | null;
  referenceAction?: 'pick-file' | 'home-path';
  keepMenuOpen?: boolean;
};

function slashCommandDisplayConfig(item: DesktopChatSlashCommand) {
  const value = item.value.toLowerCase();

  if (value.startsWith('/skill:') || value === '/skill') {
    return { icon: Sparkles, iconClassName: 'text-violet-300' };
  }
  if (value === '/model') {
    return { icon: Bot, iconClassName: 'text-slate-300' };
  }
  if (value === '/settings') {
    return { icon: Settings2, iconClassName: 'text-slate-300' };
  }
  if (value === '/login') {
    return { icon: LogIn, iconClassName: 'text-emerald-300' };
  }
  if (value === '/logout') {
    return { icon: LogOut, iconClassName: 'text-rose-300' };
  }
  if (value === '/copy') {
    return { icon: Copy, iconClassName: 'text-slate-300' };
  }
  if (value === '/reload') {
    return { icon: RefreshCw, iconClassName: 'text-slate-300' };
  }
  if (value === '/image') {
    return { icon: ImagePlus, iconClassName: 'text-fuchsia-300' };
  }
  if (value === '/help' || value === '/hotkeys') {
    return { icon: HelpCircle, iconClassName: 'text-slate-300' };
  }
  if (value === '/new' || value === '/resume' || value === '/fork' || value === '/tree') {
    return { icon: FolderOpen, iconClassName: 'text-sky-300' };
  }
  if (value.startsWith('/')) {
    return { icon: Wrench, iconClassName: 'text-slate-300' };
  }

  return { icon: Sparkles, iconClassName: 'text-violet-300' };
}

export function ComposerSlashMenu({
  items,
  selectedIndex,
  onSelect,
}: {
  items: DesktopChatSlashCommand[];
  selectedIndex: number;
  onSelect: (value: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="app-transient-surface app-modal-panel absolute bottom-full left-1/2 z-30 mb-2.5 w-full -translate-x-1/2 overflow-hidden rounded-[18px] border px-2 py-2">
      <div className="app-transient-scroll max-h-[min(32rem,62vh)] overflow-y-auto pr-1">
        <div className="space-y-0.5">
          {items.map((item, index) => {
            const active = index === selectedIndex;
            const display = slashCommandDisplayConfig(item);
            const Icon = display.icon;

            return (
              <button
                key={item.value}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(item.value);
                }}
                className={cn(
                  'app-transient-row app-transient-action-row flex w-full items-center gap-3 rounded-[12px] px-3 py-2 text-left transition',
                  active && 'app-transient-row-selected',
                )}
              >
                <div className="grid h-5 w-5 shrink-0 place-items-center">
                  <Icon className={cn('h-4 w-4', active ? 'text-slate-100' : display.iconClassName)} />
                </div>
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <span className="app-transient-action-label shrink-0">{item.label}</span>
                  {item.detail ? <span className="app-transient-metadata truncate">{item.detail}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function composerThinkingLabel(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]/g, '');
  return composerThinkingOptions.find((option) => option.value.replace(/[\s_-]/g, '') === normalized)?.label
    ?? (normalized === 'auto' || normalized === 'thinking'
      ? 'Default'
      : normalized === 'extrahigh'
        ? 'Extra High'
        : value);
}

export type CompactComposerModelMenuSaveInput = ComposerRoute;

export function CompactComposerModelMenu({ scope, selection, providerOptions = [],
  modelOptions = composerModelOptions.map((value) => ({ value, label: value })),
  defaultOpen = false, onSave, confirmAccountChanges = true,
}: {
  scope: ComposerScope;
  selection: { mode: string; model: string; thinking: string; authProvider?: string | null; authChoice?: string | null };
  providerOptions?: ComposerProviderOption[];
  modelOptions?: ComposerModelOption[];
  defaultOpen?: boolean;
  confirmAccountChanges?: boolean;
  onSave: (input: CompactComposerModelMenuSaveInput) => void | boolean | Promise<void | boolean>;
}) {
  return <div className="min-w-0 max-w-full" data-compact-model-menu="true" data-composer-scope={scope}>
    <ModelEffortPicker selection={selection} providerOptions={providerOptions} modelOptions={modelOptions}
      defaultOpen={defaultOpen} onApply={onSave} confirmAccountChanges={confirmAccountChanges} />
  </div>;
}

export function ComposerModelControls({ scope, selection, onSelectValue, onSelectProviderChoice,
  providerOptions = [], modelOptions = composerModelOptions.map((value) => ({ value, label: value })),
  onSelectRoute, onSignIn, confirmAccountChanges = false,
}: {
  scope: ComposerScope;
  selection: { mode: string; model: string; thinking: string; authProvider?: string | null; authChoice?: string | null };
  openSelector: { scope: ComposerScope; type: ComposerSelectorType } | null;
  onToggleSelector: (scope: ComposerScope, type: ComposerSelectorType) => void;
  onSelectValue: (scope: ComposerScope, type: ComposerSelectorType, value: string) => void | boolean | Promise<unknown>;
  authLabel: string;
  authOptions: ComposerAuthOption[];
  onSelectAuthChoice: (scope: ComposerScope, providerId: string, choice: string) => void;
  onSelectProviderChoice: (scope: ComposerScope, option: ComposerProviderOption) => void | boolean | Promise<unknown>;
  providerOptions?: ComposerProviderOption[];
  modelOptions?: ComposerModelOption[];
  compact?: boolean;
  confirmAccountChanges?: boolean;
  onSelectRoute?: (scope: ComposerScope, route: ComposerRoute, type: 'provider' | 'model' | 'thinking') => void | boolean | Promise<void | boolean>;
  onSignIn?: () => void;
}) {
  return <div className="min-w-0 max-w-full" data-composer-model-controls={scope}>
    <ModelEffortPicker selection={selection} providerOptions={providerOptions} modelOptions={modelOptions}
      onSignIn={onSignIn} confirmAccountChanges={confirmAccountChanges}
      onApply={async (route, type) => {
        if (onSelectRoute) return onSelectRoute(scope, route, type);
        const current = resolveComposerModelSelection({ selection, providerOptions, modelOptions });
        if (route.providerOption && route.providerOption.value !== current.selectedProviderOption?.value) {
          if (await onSelectProviderChoice(scope, route.providerOption) === false) return false;
        }
        if (route.model !== selection.model && await onSelectValue(scope, 'model', route.model) === false) return false;
        if (route.thinking !== selection.thinking && await onSelectValue(scope, 'thinking', route.thinking) === false) return false;
      }} />
  </div>;
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
  const modeMenuRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (activeSelector !== 'mode' || typeof document === 'undefined') return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (modeMenuRootRef.current?.contains(target)) return;
      onToggleSelector(scope, 'mode');
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onToggleSelector(scope, 'mode');
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [activeSelector, onToggleSelector, scope]);

  return (
    <div ref={modeMenuRootRef} className="relative">
      <button
        type="button"
        onClick={() => onToggleSelector(scope, 'mode')}
        className="app-mode-tab inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition"
      >
        <span>{selection.mode}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', activeSelector === 'mode' ? 'rotate-180' : '')} />
      </button>
      {activeSelector === 'mode' && (
        <div className="app-transient-surface absolute bottom-full left-0 z-30 mb-2 min-w-[260px] rounded-[16px] border px-3 py-3 text-[12px] leading-[1.38]">
          <div className="pb-2 text-[12px] font-medium text-[color:var(--utility-foreground)]">Compose mode</div>
          <div className="space-y-1">
            {activeOptions.map((option) => {
              const isSelected = selection.mode === option;

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onSelectValue(scope, 'mode', option)}
                  className={cn(
                    'app-composer-popover-item flex w-full items-center justify-between px-3 py-2 text-left text-[13px]',
                    isSelected ? 'app-composer-popover-item-active' : '',
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
