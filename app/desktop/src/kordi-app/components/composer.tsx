import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
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
  Menu,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';
import { IdentityAvatar } from './IdentityAvatar';
import {
  normalizeComposerProviderId,
  providerDisplayLabel,
  resolveComposerModelSelection,
  type ComposerModelOption,
  type ComposerProviderOption,
} from './composerModelSelection';
import { composerModeOptions, composerModelOptions, composerThinkingOptions } from '../data';
import type {
  ComposerScope,
  ComposerSelectorType,
  DesktopChatContextWindowStatus,
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
  targetKind: 'agent' | 'person';
  sourceHostId: string;
  nodeId: string;
  runtime: string;
  humanId?: string | null;
  agentId?: string | null;
  ownerName?: string | null;
  avatarImageUrl?: string | null;
  avatarSeed?: string | null;
  unreadCount?: number;
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
                  'app-transient-row flex w-full items-center gap-3 rounded-[12px] px-3 py-2 text-left text-[13px] transition',
                  active && 'app-transient-row-selected',
                )}
              >
                <div className="grid h-5 w-5 shrink-0 place-items-center">
                  <Icon className={cn('h-4 w-4', active ? 'text-slate-100' : display.iconClassName)} />
                </div>
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <span className="shrink-0 font-medium">{item.label}</span>
                  {item.detail ? <span className="app-transient-muted truncate text-[12px]">{item.detail}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function initialComposerMentionMenuThemeClass() {
  if (typeof document === 'undefined') return '';
  return document.querySelector('.kordi-app.theme-light') ? 'app-composer-mention-menu-light' : '';
}

export function ComposerMentionMenu({
  items,
  selectedIndex,
  onSelect,
}: {
  items: ComposerMentionOption[];
  selectedIndex: number;
  onSelect: (value: string) => void;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [menuThemeClass, setMenuThemeClass] = useState(initialComposerMentionMenuThemeClass);

  const updateMenuPosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const anchor = anchorRef.current;
    const container = anchor?.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const viewportPadding = 24;
    const menuWidth = Math.min(
      Math.max(240, rect.width),
      Math.max(240, window.innerWidth - (viewportPadding * 2)),
    );
    const appShell = anchor.closest('.kordi-app') ?? document.querySelector('.kordi-app.theme-light');
    setMenuThemeClass(appShell?.classList.contains('theme-light') ? 'app-composer-mention-menu-light' : '');
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );
    const top = Math.max(viewportPadding, rect.top - 10);
    const availableAbove = Math.max(160, top - viewportPadding);
    setMenuStyle({
      left: `${left}px`,
      top: `${top}px`,
      width: `${menuWidth}px`,
      maxHeight: `min(18rem, ${availableAbove}px)`,
      transform: 'translateY(-100%)',
    });
  }, []);

  useEffect(() => {
    if (items.length === 0) return undefined;
    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [items.length, updateMenuPosition]);

  if (items.length === 0) return null;

  const renderMenu = () => (
    <div className={cn('app-transient-surface app-composer-mention-menu app-composer-mention-menu-layer fixed overflow-hidden rounded-[18px] border px-2 py-2', menuThemeClass)} style={menuStyle}>
      <div className="app-transient-scroll max-h-[inherit] overflow-y-auto pr-1">
        <div className="space-y-0.5">
          {items.map((item, index) => {
            const active = index === selectedIndex;
            return (
              <button
                key={`${item.sourceHostId}-${item.nodeId}-${item.value}`}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(item.value);
                }}
                className={cn(
                  'app-composer-mention-menu-item flex w-full items-center gap-2.5 rounded-[16px] px-2.5 py-2 text-left text-[13px] transition',
                  active && 'app-composer-mention-menu-item-active',
                )}
              >
                <IdentityAvatar
                  kind={item.targetKind === 'agent' ? 'agent' : 'human'}
                  seed={item.avatarSeed ?? item.agentId ?? item.humanId ?? item.nodeId ?? item.label}
                  name={item.label}
                  imageUrl={item.avatarImageUrl}
                  className="app-composer-mention-menu-icon h-7 w-7 shrink-0 border border-[color:var(--app-composer-mention-menu-border)]"
                />
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="app-composer-mention-menu-label truncate text-[13px] font-semibold leading-5"><span className="app-composer-mention-menu-at mr-px">@</span>{item.label}</span>
                    <span className="app-composer-mention-menu-kind shrink-0 rounded-full px-1.5 py-0.5 text-[9px]">
                      {item.targetKind === 'agent' ? 'agent' : 'person'}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <Fragment>
      <span ref={anchorRef} className="pointer-events-none absolute inset-x-0 top-0 h-0" aria-hidden="true" />
      {typeof document !== 'undefined' ? createPortal(renderMenu(), document.body) : renderMenu()}
    </Fragment>
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

export function normalizeComposerThinkingLevels(levels: string[]) {
  const normalized = levels.map((level) => level.trim()).filter(Boolean);
  if (normalized.length === 1 && normalized[0] === 'off') return ['default'];
  return normalized;
}

export function fallbackComposerThinkingValue(levels: string[], requested: string) {
  const normalizedLevels = normalizeComposerThinkingLevels(levels);
  if (normalizedLevels.includes(requested)) return requested;
  if (requested === 'max' && normalizedLevels.includes('xhigh')) return 'xhigh';
  if (requested === 'max' && normalizedLevels.includes('high')) return 'high';
  if (requested === 'xhigh' && normalizedLevels.includes('high')) return 'high';
  if (normalizedLevels.includes('medium')) return 'medium';
  if (normalizedLevels.includes('default')) return 'default';
  if (normalizedLevels.includes('off')) return 'off';
  return normalizedLevels[0] ?? requested;
}

function lowerComposerLabel(value?: string | null) {
  return (value?.trim() || '').toLocaleLowerCase();
}

export type CompactComposerModelMenuSaveInput = {
  providerOption: ComposerProviderOption | null;
  model: string;
  thinking: string;
};

export function CompactComposerModelMenu({
  scope,
  selection,
  providerOptions = [],
  modelOptions = composerModelOptions.map((option) => ({ value: option, label: option })),
  defaultOpen = false,
  onSave,
}: {
  scope: ComposerScope;
  selection: { mode: string; model: string; thinking: string; authProvider?: string | null; authChoice?: string | null };
  providerOptions?: ComposerProviderOption[];
  modelOptions?: ComposerModelOption[];
  defaultOpen?: boolean;
  onSave: (input: CompactComposerModelMenuSaveInput) => void;
}) {
  const {
    selectedModelOption,
    selectedProviderOption,
    selectedProviderValue,
  } = resolveComposerModelSelection({ selection, providerOptions, modelOptions });

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [menuThemeClass, setMenuThemeClass] = useState('');
  const [stagedProviderValue, setStagedProviderValue] = useState(selectedProviderOption?.value ?? '');
  const [stagedModel, setStagedModel] = useState(selection.model);
  const [stagedThinking, setStagedThinking] = useState(selection.thinking);

  useEffect(() => {
    setStagedProviderValue(selectedProviderOption?.value ?? '');
    setStagedModel(selection.model);
    setStagedThinking(selection.thinking);
  }, [selectedProviderOption?.value, selection.model, selection.thinking]);

  const stagedProviderOption = providerOptions.find((option) => option.value === stagedProviderValue) ?? selectedProviderOption ?? null;
  const stagedProviderId = stagedProviderOption?.providerId
    ? normalizeComposerProviderId(stagedProviderOption.providerId)
    : selectedProviderValue;
  const visibleModelOptions = stagedProviderId
    ? modelOptions.filter((option) => (option.provider ?? stagedProviderId) === stagedProviderId)
    : modelOptions;
  const stagedModelOption = modelOptions.find((option) => option.value === stagedModel) ?? selectedModelOption ?? visibleModelOptions[0] ?? null;
  const stagedThinkingLevels = normalizeComposerThinkingLevels(stagedModelOption?.thinkingLevels?.length
    ? stagedModelOption.thinkingLevels
    : composerThinkingOptions.map((option) => option.value));
  const stagedThinkingValue = fallbackComposerThinkingValue(stagedThinkingLevels, stagedThinking);
  const providerSummary = lowerComposerLabel(
    stagedProviderOption?.selectionLabel
      ?? (stagedProviderOption ? [stagedProviderOption.label, stagedProviderOption.detail].filter(Boolean).join(' · ') : null)
      ?? stagedModelOption?.providerLabel
      ?? (stagedProviderId ? providerDisplayLabel(stagedProviderId) : 'provider'),
  );
  const modelSummary = lowerComposerLabel(stagedModelOption?.label ?? stagedModel);
  const thinkingSummary = lowerComposerLabel(composerThinkingLabel(stagedThinkingValue));

  const updateMenuPosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 24;
    const menuWidth = Math.min(352, Math.max(240, window.innerWidth - (viewportPadding * 2)));
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );
    const availableAbove = Math.max(192, rect.top - viewportPadding);
    const appShell = trigger.closest('.kordi-app');
    setMenuThemeClass(appShell?.classList.contains('theme-light') ? 'app-compact-model-menu-light' : '');
    setMenuStyle({
      left: `${left}px`,
      top: `${Math.max(viewportPadding, rect.top)}px`,
      maxHeight: `min(31rem, ${availableAbove}px)`,
      width: 'min(22rem, calc(100vw - 3rem))',
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  const chooseProvider = (option: ComposerProviderOption) => {
    const providerId = normalizeComposerProviderId(option.providerId);
    const firstProviderModel = modelOptions.find((model) => (model.provider ?? providerId) === providerId);
    setStagedProviderValue(option.value);
    if (firstProviderModel && (stagedModelOption?.provider ?? '') !== providerId) {
      setStagedModel(firstProviderModel.value);
      setStagedThinking(fallbackComposerThinkingValue(firstProviderModel.thinkingLevels ?? [], stagedThinking));
    }
  };

  const chooseModel = (option: ComposerModelOption) => {
    setStagedModel(option.value);
    setStagedThinking(fallbackComposerThinkingValue(option.thinkingLevels ?? [], stagedThinking));
  };

  const cancel = () => {
    setStagedProviderValue(selectedProviderOption?.value ?? '');
    setStagedModel(selection.model);
    setStagedThinking(selection.thinking);
    setIsOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  };

  const save = () => {
    onSave({ providerOption: stagedProviderOption, model: stagedModel, thinking: stagedThinkingValue });
    setIsOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return undefined;
    const closeWithoutSaving = () => {
      setStagedProviderValue(selectedProviderOption?.value ?? '');
      setStagedModel(selection.model);
      setStagedThinking(selection.thinking);
      setIsOpen(false);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeWithoutSaving();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeWithoutSaving();
      queueMicrotask(() => triggerRef.current?.focus());
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isOpen, selectedProviderOption?.value, selection.model, selection.thinking]);

  const renderMenu = () => (
    <div
      ref={menuRef}
      role="dialog"
      aria-label="Agent model"
      className={cn('app-transient-surface app-transient-scroll app-compact-model-menu app-compact-model-menu-layer overflow-y-auto rounded-[18px] p-2.5 text-[12px] leading-[1.38]', menuThemeClass)}
      style={menuStyle}
    >
      <div className="app-compact-model-menu-header mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-5">Agent model</div>
        </div>
        <button
          type="button"
          onClick={cancel}
          className="app-button-quiet app-chat-create-close grid h-6 w-6 shrink-0 place-items-center rounded-[9px] p-0"
          aria-label="Close agent model"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="space-y-1">
        <details className="app-compact-model-menu-section">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-[10px] px-2.5 text-[12px] marker:hidden transition [&::-webkit-details-marker]:hidden">
            <span className="font-medium">provider</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="app-transient-muted min-w-0 truncate text-[11px]">{providerSummary}</span>
              <ChevronDown className="app-compact-model-menu-chevron h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
            </span>
          </summary>
          <div className="space-y-1 px-1 pb-1 pt-1">
            {providerOptions.map((option) => {
              const isSelected = stagedProviderOption?.value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => chooseProvider(option)}
                  className={cn(
                    'app-composer-popover-item app-compact-model-menu-option flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                    isSelected ? 'app-composer-popover-item-active' : '',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{lowerComposerLabel(option.label)}</span>
                    {option.detail ? <span className="app-transient-muted block truncate text-[11px]">{lowerComposerLabel(option.detail)}</span> : null}
                  </span>
                  <span className={cn('shrink-0 text-[11px] font-medium', isSelected ? 'app-transient-muted' : 'text-transparent')}>selected</span>
                </button>
              );
            })}
          </div>
        </details>
        <details className="app-compact-model-menu-section">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-[10px] px-2.5 text-[12px] marker:hidden transition [&::-webkit-details-marker]:hidden">
            <span className="font-medium">model</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="app-transient-muted min-w-0 truncate text-[11px]">{modelSummary}</span>
              <ChevronDown className="app-compact-model-menu-chevron h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
            </span>
          </summary>
          <div className="space-y-1 px-1 pb-1 pt-1">
            {visibleModelOptions.map((option) => {
              const isSelected = stagedModel === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => chooseModel(option)}
                  className={cn(
                    'app-composer-popover-item app-compact-model-menu-option flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                    isSelected ? 'app-composer-popover-item-active' : '',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{lowerComposerLabel(option.label)}</span>
                    {option.detail ? <span className="app-transient-muted block truncate text-[11px]">{lowerComposerLabel(option.detail)}</span> : null}
                  </span>
                  <span className={cn('shrink-0 text-[11px] font-medium', isSelected ? 'app-transient-muted' : 'text-transparent')}>selected</span>
                </button>
              );
            })}
          </div>
        </details>
        <details className="app-compact-model-menu-section">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-[10px] px-2.5 text-[12px] marker:hidden transition [&::-webkit-details-marker]:hidden">
            <span className="font-medium">thinking level</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="app-transient-muted min-w-0 truncate text-[11px]">{thinkingSummary}</span>
              <ChevronDown className="app-compact-model-menu-chevron h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
            </span>
          </summary>
          <div className="space-y-1 px-1 pb-1 pt-1">
            {stagedThinkingLevels.map((value) => {
              const isSelected = stagedThinkingValue === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStagedThinking(value)}
                  className={cn(
                    'app-composer-popover-item app-compact-model-menu-option flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                    isSelected ? 'app-composer-popover-item-active' : '',
                  )}
                >
                  <span>{lowerComposerLabel(composerThinkingLabel(value))}</span>
                  <span className={cn('shrink-0 text-[11px] font-medium', isSelected ? 'app-transient-muted' : 'text-transparent')}>selected</span>
                </button>
              );
            })}
          </div>
        </details>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1">
        <span className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={cancel} className="app-button-quiet rounded-[10px] px-3 py-1.5 text-[12px] font-medium">cancel</button>
          <button type="button" onClick={save} className="app-button-primary rounded-[10px] px-3 py-1.5 text-[12px] font-semibold transition">save</button>
        </span>
      </div>
    </div>

  );
  return (
    <div className="relative shrink-0" data-compact-model-menu="true" data-composer-scope={scope}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!isOpen) updateMenuPosition();
          setIsOpen((current) => !current);
        }}
        className="app-button-quiet relative grid h-9 w-9 shrink-0 place-items-center rounded-[10px] p-0"
        title="model route"
        aria-label="model route"
        aria-expanded={isOpen}
        data-compact-model-trigger="bare"
      >
        <Menu className="h-[18px] w-[18px] text-slate-400" strokeWidth={2.25} aria-hidden="true" />
      </button>
      {isOpen ? (typeof document !== 'undefined' ? createPortal(renderMenu(), document.body) : renderMenu()) : null}
    </div>
  );
}

export function ComposerModelControls({
  scope,
  selection,
  openSelector,
  onToggleSelector,
  onSelectValue,
  authLabel,
  authOptions,
  onSelectAuthChoice,
  onSelectProviderChoice,
  providerOptions = [],
  modelOptions = composerModelOptions.map((option) => ({ value: option, label: option })),
  compact = false,
}: {
  scope: ComposerScope;
  selection: { mode: string; model: string; thinking: string; authProvider?: string | null; authChoice?: string | null };
  openSelector: { scope: ComposerScope; type: ComposerSelectorType } | null;
  onToggleSelector: (scope: ComposerScope, type: ComposerSelectorType) => void;
  onSelectValue: (scope: ComposerScope, type: ComposerSelectorType, value: string) => void;
  authLabel: string;
  authOptions: ComposerAuthOption[];
  onSelectAuthChoice: (scope: ComposerScope, providerId: string, choice: string) => void;
  onSelectProviderChoice: (scope: ComposerScope, option: ComposerProviderOption) => void;
  providerOptions?: ComposerProviderOption[];
  modelOptions?: ComposerModelOption[];
  compact?: boolean;
}) {
  const activeSelector = openSelector?.scope === scope ? openSelector.type : null;
  const selectorTriggerRefs = useRef<Partial<Record<ComposerSelectorType, HTMLButtonElement | null>>>({});
  const selectorMenuRef = useRef<HTMLDivElement | null>(null);
  const [selectorMenuStyle, setSelectorMenuStyle] = useState<CSSProperties>({});
  const [selectorMenuThemeClass, setSelectorMenuThemeClass] = useState('');
  const {
    fallbackModelLabel,
    selectedModelOption,
    selectedProviderOption,
    selectedProviderValue,
  } = resolveComposerModelSelection({ selection, providerOptions, modelOptions });
  const selectedProviderLabel = selectedProviderOption?.selectionLabel
    ?? (selectedProviderOption ? [selectedProviderOption.label, selectedProviderOption.detail].filter(Boolean).join(' · ') : null)
    ?? selectedModelOption?.providerLabel
    ?? (selectedProviderValue ? providerDisplayLabel(selectedProviderValue) : 'Provider');
  const filteredModelOptions = selectedProviderValue
    ? modelOptions.filter((option) => (option.provider ?? selectedProviderValue) === selectedProviderValue)
    : modelOptions;
  const selectedThinkingLevels = normalizeComposerThinkingLevels(selectedModelOption?.thinkingLevels?.length
    ? selectedModelOption.thinkingLevels
    : composerThinkingOptions.map((option) => option.value));
  const thinkingOptions = selectedThinkingLevels.map((value) => ({
    value,
    label: composerThinkingLabel(value),
    detail: null,
  }));
  const activeOptions = activeSelector === 'provider'
    ? providerOptions
    : activeSelector === 'model'
      ? filteredModelOptions
      : thinkingOptions;
  const selectedModel = selectedModelOption?.label ?? fallbackModelLabel;
  const selectedThinkingValue = fallbackComposerThinkingValue(selectedThinkingLevels, selection.thinking);
  const selectedThinkingLabel = composerThinkingLabel(selectedThinkingValue);

  const updateSelectorMenuPosition = useCallback((selectorType: ComposerSelectorType | null = activeSelector) => {
    if (typeof window === 'undefined' || !selectorType || selectorType === 'mode') return;
    const trigger = selectorTriggerRefs.current[selectorType]
      ?? selectorTriggerRefs.current.model
      ?? selectorTriggerRefs.current.provider
      ?? selectorTriggerRefs.current.thinking;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 16;
    const menuWidth = Math.min(340, Math.max(240, window.innerWidth - (viewportPadding * 2)));
    const left = Math.min(
      Math.max(viewportPadding, rect.right - menuWidth),
      Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );
    const availableAbove = Math.max(160, rect.top - viewportPadding);
    const appShell = trigger.closest('.kordi-app');
    setSelectorMenuThemeClass(appShell?.classList.contains('theme-light') ? 'app-compact-model-menu-light' : '');
    setSelectorMenuStyle({
      left: `${left}px`,
      top: `${Math.max(viewportPadding, rect.top)}px`,
      width: `${menuWidth}px`,
      maxHeight: `min(28rem, ${availableAbove}px)`,
      transform: 'translateY(calc(-100% - 0.5rem))',
    });
  }, [activeSelector]);

  useEffect(() => {
    if (!activeSelector || activeSelector === 'mode') return undefined;
    updateSelectorMenuPosition(activeSelector);
    const handleUpdate = () => updateSelectorMenuPosition(activeSelector);
    window.addEventListener('resize', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);
    return () => {
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
    };
  }, [activeSelector, updateSelectorMenuPosition]);

  useEffect(() => {
    if (!activeSelector || activeSelector === 'mode' || typeof document === 'undefined') return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const clickedTrigger = Object.values(selectorTriggerRefs.current).some((trigger) => trigger?.contains(target));
      if (selectorMenuRef.current?.contains(target) || clickedTrigger) return;
      onToggleSelector(scope, activeSelector);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onToggleSelector(scope, activeSelector);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [activeSelector, onToggleSelector, scope]);

  const renderSelectorMenu = () => (
    <div ref={selectorMenuRef} className={cn('app-transient-surface app-transient-scroll app-composer-model-menu-layer fixed z-[2147483000] overflow-y-auto rounded-[16px] border px-3 py-3 text-[12px] leading-[1.38]', selectorMenuThemeClass)} style={selectorMenuStyle}>
      <div className="pb-2 text-[12px] font-medium text-[color:var(--utility-foreground)]">
        {activeSelector === 'provider'
          ? 'Provider'
          : activeSelector === 'model'
            ? 'Model'
            : activeSelector === 'thinking'
              ? 'Thinking level'
              : 'Auth profile / API'}
      </div>
      <div className="space-y-1">
        {activeSelector === 'auth' ? (
          authOptions.length > 0 ? (
            authOptions.map((option, index) => {
              const showProviderHeader = index === 0 || authOptions[index - 1]?.providerId !== option.providerId;

              return (
                <Fragment key={`${option.providerId}-${option.value}`}>
                  {showProviderHeader ? (
                    <div className="pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--utility-muted-text)] first:pt-0">
                      {option.providerLabel}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onSelectAuthChoice(scope, option.providerId, option.value)}
                    className={cn(
                      'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                      option.active ? 'app-composer-popover-item-active' : '',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="truncate">{option.label}</div>
                      <div className="truncate text-[11px] text-[color:var(--utility-muted-text)]">
                        {[option.methodLabel, option.detail].filter(Boolean).join(' • ')}
                      </div>
                    </div>
                    <span className={cn('shrink-0 text-[11px] font-medium', option.active ? 'text-[color:var(--utility-foreground)]' : 'text-transparent')}>
                      Current
                    </span>
                  </button>
                </Fragment>
              );
            })
          ) : (
            <div className="rounded-[18px] py-2 text-[12px] text-[color:var(--utility-muted-text)]">
              No saved auth options yet.
            </div>
          )
        ) : activeSelector === 'provider' ? (
          providerOptions.map((option) => {
            const isSelected = selectedProviderOption?.value === option.value;

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onSelectProviderChoice(scope, option)}
                className={cn(
                  'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                  isSelected ? 'app-composer-popover-item-active' : '',
                )}
              >
                <div className="min-w-0">
                  <div className="truncate">{option.label}</div>
                  {option.detail ? <div className="truncate text-[11px] text-[color:var(--utility-muted-text)]">{option.detail}</div> : null}
                </div>
                <span className={cn('shrink-0 text-[11px] font-medium', isSelected ? 'text-[color:var(--utility-foreground)]' : 'text-transparent')}>
                  Selected
                </span>
              </button>
            );
          })
        ) : (
          activeOptions.map((option) => {
            const isSelected = selection.model === option.value || selectedThinkingValue === option.value;
            return (
              <Fragment key={option.value}>
                <button
                  type="button"
                  onClick={() => {
                    if (activeSelector === 'model' || activeSelector === 'thinking') {
                      onSelectValue(scope, activeSelector, option.value);
                    }
                  }}
                  className={cn(
                    'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                    isSelected ? 'app-composer-popover-item-active' : '',
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate">{option.label}</div>
                    {option.detail ? <div className="truncate text-[11px] text-[color:var(--utility-muted-text)]">{option.detail}</div> : null}
                  </div>
                  <span className={cn('shrink-0 text-[11px] font-medium', isSelected ? 'text-[color:var(--utility-foreground)]' : 'text-transparent')}>
                    Selected
                  </span>
                </button>
              </Fragment>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <div className={cn('relative flex items-center gap-1.5', compact ? 'min-w-0 max-w-full flex-nowrap justify-end' : 'shrink-0')}>
      <button
        ref={(node) => { selectorTriggerRefs.current.provider = node; }}
        type="button"
        onClick={() => {
          updateSelectorMenuPosition('provider');
          onToggleSelector(scope, 'provider');
        }}
        className={cn('app-button-quiet inline-flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[12px] font-medium', compact ? 'w-[5.75rem]' : 'w-[8.75rem]')}
        aria-expanded={activeSelector === 'provider'}
      >
        <span className="truncate text-left">{selectedProviderLabel || 'Provider'}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', activeSelector === 'provider' ? 'rotate-180 text-slate-300' : '')} />
      </button>
      <button
        ref={(node) => { selectorTriggerRefs.current.model = node; }}
        type="button"
        onClick={() => {
          updateSelectorMenuPosition('model');
          onToggleSelector(scope, 'model');
        }}
        className={cn('app-button-quiet inline-flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[12px] font-medium', compact ? 'w-[5.75rem]' : 'w-[8.5rem]')}
        aria-expanded={activeSelector === 'model'}
      >
        <span className="truncate text-left">{selectedModel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', activeSelector === 'model' ? 'rotate-180 text-slate-300' : '')} />
      </button>
      <button
        ref={(node) => { selectorTriggerRefs.current.thinking = node; }}
        type="button"
        onClick={() => {
          updateSelectorMenuPosition('thinking');
          onToggleSelector(scope, 'thinking');
        }}
        className={cn('app-button-quiet inline-flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[12px] font-medium', compact ? 'w-[4.75rem]' : 'w-[6.5rem]')}
        aria-expanded={activeSelector === 'thinking'}
      >
        <span className="truncate text-left">{selectedThinkingLabel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', activeSelector === 'thinking' ? 'rotate-180 text-slate-300' : '')} />
      </button>
      {activeSelector && activeSelector !== 'mode'
        ? (typeof document !== 'undefined' ? createPortal(renderSelectorMenu(), document.body) : renderSelectorMenu())
        : null}
    </div>
  );
}

function formatCompactTokenCount(value: number) {
  if (value < 1_000) return `${value}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

function deriveComposerContextPercent(status?: DesktopChatContextWindowStatus | null) {
  if (!status) return null;
  if (typeof status.usedTokens === 'number' && status.contextWindow > 0) {
    return Math.max(0, Math.min(100, (status.usedTokens / status.contextWindow) * 100));
  }
  if (typeof status.usedPercent === 'number') {
    return Math.max(0, Math.min(100, status.usedPercent));
  }
  return null;
}

function deriveComposerContextUsedTokens(status?: DesktopChatContextWindowStatus | null) {
  if (!status) return null;
  if (typeof status.usedTokens === 'number') {
    return Math.max(0, status.usedTokens);
  }
  if (typeof status.usedPercent === 'number' && status.contextWindow > 0) {
    return Math.round((status.usedPercent / 100) * status.contextWindow);
  }
  return null;
}

export function ComposerRuntimeStatus({
  contextStatus,
  cacheText,
}: {
  contextStatus?: DesktopChatContextWindowStatus | null;
  cacheText?: string | null;
}) {
  const contextPercent = deriveComposerContextPercent(contextStatus);
  const usedTokens = deriveComposerContextUsedTokens(contextStatus);
  const totalTokens = contextStatus?.contextWindow ?? 0;
  const usedPercentLabel = contextPercent === null ? '—' : `${Math.round(contextPercent)}%`;
  const leftPercentLabel = contextPercent === null ? '—' : `${Math.max(0, Math.round(100 - contextPercent))}%`;
  const thresholdPercent = contextStatus?.compactionThresholdPercent ?? 90;
  const isCompressionReady = contextPercent !== null && contextPercent >= thresholdPercent;
  const isNearCompression = contextPercent !== null && contextPercent >= Math.max(0, thresholdPercent - 10);
  const ringColor = isCompressionReady
    ? 'color-mix(in oklab, #f97316 88%, var(--utility-foreground))'
    : isNearCompression
      ? 'color-mix(in oklab, #facc15 82%, var(--utility-foreground))'
      : 'color-mix(in oklab, var(--utility-muted-text) 92%, transparent)';
  const ringStyle = contextPercent === null
    ? { background: 'color-mix(in oklab, var(--utility-muted-text) 20%, transparent)' }
    : {
        background: `conic-gradient(${ringColor} ${contextPercent * 3.6}deg, color-mix(in oklab, var(--utility-muted-text) 20%, transparent) 0deg)`,
      };

  if (!contextStatus) {
    return <div className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />;
  }

  return (
    <div className="flex shrink-0 items-center overflow-visible text-[11px] text-[color:var(--utility-muted-text)]">
      <div className="group relative shrink-0">
        <button
          type="button"
          className="app-button-quiet inline-flex h-[18px] w-[18px] items-center justify-center rounded-full p-0"
          aria-label="Context window"
        >
          <span className="relative h-3.5 w-3.5 shrink-0 rounded-full" style={ringStyle}>
            <span className="absolute inset-[2.15px] rounded-full bg-[color:var(--app-main-bg)]" />
            <span className="absolute inset-0 rounded-full ring-1 ring-[color:var(--app-divider)]" />
          </span>
        </button>
        <div className="app-transient-surface pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-2 w-[264px] -translate-x-1/2 rounded-[16px] border px-4 py-3 text-[12px] leading-[1.38] opacity-0 transition duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
          <div className="font-medium text-[color:var(--utility-foreground)]">Context window:</div>
          <div className="mt-1 text-[11px] text-[color:var(--utility-foreground)]">{usedPercentLabel} used ({leftPercentLabel} left)</div>
          <div className="mt-1 text-[11px] text-[color:var(--utility-foreground)]">
            {usedTokens === null ? '—' : formatCompactTokenCount(usedTokens)} / {formatCompactTokenCount(totalTokens)} tokens used
          </div>
          {contextStatus.autoCompaction ? (
            <div className="mt-3 space-y-1 text-[11px] text-[color:var(--utility-foreground)]">
              <div>Auto-compresses before Kordi responds once usage reaches {thresholdPercent}%.</div>
              {isCompressionReady ? (
                <div className="rounded-md border border-orange-400/35 bg-orange-400/10 px-2 py-1 text-orange-200">
                  Send your next message to compress this conversation first.
                </div>
              ) : isNearCompression ? (
                <div className="rounded-md border border-yellow-400/30 bg-yellow-400/10 px-2 py-1 text-yellow-100">
                  Near the compression threshold. Kordi will compress before a future response.
                </div>
              ) : (
                <div className="text-[color:var(--utility-muted-text)]">Plenty of context remains.</div>
              )}
            </div>
          ) : (
            <div className="mt-3 text-[11px] text-[color:var(--utility-foreground)]">Automatic compaction is off</div>
          )}
          {cacheText ? (
            <div className="mt-3 border-t border-[color:var(--app-divider)] pt-3 text-[11px] leading-[1.45] text-[color:var(--utility-muted-text)]">
              <div className="mb-1 font-medium text-[color:var(--utility-foreground)]">Cache hit rate:</div>
              <div>{cacheText}</div>
            </div>
          ) : null}
        </div>
      </div>
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
