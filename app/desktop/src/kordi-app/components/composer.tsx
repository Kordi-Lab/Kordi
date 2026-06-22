import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  AtSign,
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
  UserRound,
  Wrench,
} from 'lucide-react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';
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

export type ComposerProviderOption = {
  value: string;
  providerId: string;
  label: string;
  detail?: string | null;
  selectionLabel?: string;
  active?: boolean;
};

export type ComposerModelOption = {
  value: string;
  label: string;
  detail?: string | null;
  provider?: string;
  providerLabel?: string;
  thinkingLevels?: string[];
};

export type ComposerMentionOption = {
  value: string;
  label: string;
  detail?: string | null;
  targetKind: 'bridge-agent' | 'bridge-person';
  bridgeHostId: string;
  nodeId: string;
  runtime: string;
  humanId?: string | null;
  agentId?: string | null;
  ownerName?: string | null;
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
    <div className="app-modal-panel absolute bottom-full left-1/2 z-30 mb-2.5 w-full -translate-x-1/2 overflow-hidden rounded-[24px] border border-[color:var(--app-divider)] px-2 py-2 shadow-[var(--app-shadow-float)] backdrop-blur-2xl">
      <div className="max-h-[min(32rem,62vh)] overflow-y-auto pr-1">
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
                  'flex w-full items-center gap-3 rounded-[16px] px-3 py-2 text-left text-[13px] transition',
                  active ? 'bg-white/[0.06] text-white' : 'text-slate-300 hover:bg-white/[0.03] hover:text-white',
                )}
              >
                <div className="grid h-5 w-5 shrink-0 place-items-center">
                  <Icon className={cn('h-4 w-4', active ? 'text-slate-100' : display.iconClassName)} />
                </div>
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <span className="shrink-0 font-medium">{item.label}</span>
                  {item.detail ? <span className={cn('truncate text-[12px]', active ? 'text-slate-300' : 'text-slate-500')}>{item.detail}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
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
  const [menuThemeClass, setMenuThemeClass] = useState('');

  const updateMenuPosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const anchor = anchorRef.current;
    const container = anchor?.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const viewportPadding = 24;
    const menuWidth = Math.min(
      480,
      Math.max(240, rect.width),
      Math.max(240, window.innerWidth - (viewportPadding * 2)),
    );
    const appShell = anchor.closest('.bridge-app');
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
    <div className={cn('app-composer-mention-menu app-composer-mention-menu-layer fixed overflow-hidden rounded-[18px] border px-1 py-1 shadow-[var(--app-shadow-float)]', menuThemeClass)} style={menuStyle}>
      <div className="max-h-[inherit] overflow-y-auto pr-1">
        <div className="space-y-0.5">
          {items.map((item, index) => {
            const active = index === selectedIndex;
            const Icon = item.targetKind === 'bridge-agent' ? Bot : UserRound;
            return (
              <button
                key={`${item.bridgeHostId}-${item.nodeId}-${item.value}`}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(item.value);
                }}
                className={cn(
                  'app-composer-mention-menu-item flex w-full items-center gap-2 rounded-[12px] px-2 py-1 text-left text-[11px] transition',
                  active && 'app-composer-mention-menu-item-active',
                )}
              >
                <div className="app-composer-mention-menu-icon grid h-5 w-5 shrink-0 place-items-center rounded-full">
                  <Icon className={cn('h-3 w-3', item.targetKind === 'bridge-agent' ? 'text-violet-300' : 'text-sky-300')} />
                </div>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="app-composer-mention-menu-label truncate text-[10px] leading-3.5"><AtSign className="mr-0.5 inline h-2.5 w-2.5 align-[-1px] text-slate-500" />{item.label}</span>
                    <span className={cn('app-composer-mention-menu-kind shrink-0 rounded-full px-1.5 py-0.5 text-[9px]', active && 'app-composer-mention-menu-kind-active')}>
                      {item.targetKind === 'bridge-agent' ? 'agent' : 'person'}
                    </span>
                  </div>
                  {item.detail ? <div className={cn('app-composer-mention-menu-detail truncate text-[10px] leading-3.5', active && 'app-composer-mention-menu-detail-active')}>{item.detail}</div> : null}
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
  if (requested === 'xhigh' && normalizedLevels.includes('high')) return 'high';
  if (normalizedLevels.includes('medium')) return 'medium';
  if (normalizedLevels.includes('default')) return 'default';
  if (normalizedLevels.includes('off')) return 'off';
  return normalizedLevels[0] ?? requested;
}

function normalizeComposerProviderId(providerId: string) {
  const normalized = providerId.trim().toLowerCase();
  return normalized === 'openai-codex' ? 'openai' : normalized;
}

function authChoiceFromComposerProviderOption(option: ComposerProviderOption) {
  return option.value.includes('::') ? option.value.split('::').slice(1).join('::') : null;
}

function providerDisplayLabel(providerId: string) {
  switch (providerId) {
    case 'anthropic':
      return 'Claude';
    case 'openai':
    case 'openai-codex':
      return 'OpenAI';
    case 'google':
      return 'Google Gemini';
    case 'github-copilot':
      return 'GitHub Copilot';
    case 'groq':
      return 'Groq';
    case 'lm-studio':
      return 'LM Studio';
    case 'ollama':
      return 'Ollama';
    case 'openrouter':
      return 'OpenRouter';
    case 'xai':
      return 'xAI';
    default:
      return providerId;
  }
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
  const selectedModelOption = modelOptions.find((option) => option.value === selection.model);
  const parsedSelection = selection.model.split('/');
  const fallbackProviderValue = normalizeComposerProviderId(parsedSelection[0] ?? '');
  const fallbackProviderKnown = Boolean(fallbackProviderValue) && (
    providerOptions.some((option) => normalizeComposerProviderId(option.providerId) === fallbackProviderValue)
    || modelOptions.some((option) => option.provider === fallbackProviderValue)
  );
  const selectedProviderValue = selectedModelOption?.provider ?? (fallbackProviderKnown ? fallbackProviderValue : '');
  const selectedAuthProviderOption = selection.authProvider
    ? providerOptions.find((option) => (
        option.providerId === selection.authProvider
        && authChoiceFromComposerProviderOption(option) === (selection.authChoice ?? null)
      )) ?? null
    : null;
  const selectedProviderOption = selectedAuthProviderOption ?? providerOptions.find(
    (option) => normalizeComposerProviderId(option.providerId) === selectedProviderValue && option.active,
  ) ?? providerOptions.find((option) => normalizeComposerProviderId(option.providerId) === selectedProviderValue) ?? null;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
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
    const appShell = trigger.closest('.bridge-app');
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
  };

  const save = () => {
    onSave({ providerOption: stagedProviderOption, model: stagedModel, thinking: stagedThinkingValue });
    setIsOpen(false);
  };


  const renderMenu = () => (
    <div
      className={cn('app-compact-model-menu app-compact-model-menu-layer overflow-y-auto rounded-[18px] text-[12px] leading-[1.38]', menuThemeClass)}
      style={menuStyle}
    >
      <div className="app-compact-model-menu-header flex items-center justify-between gap-3 px-3.5 py-3">
        <div className="font-medium">Agent Model</div>
      </div>
      <div className="px-2.5 py-2">
        <details className="border-b border-[color:var(--app-divider)] py-1">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-[12px] px-2.5 text-[12px] marker:hidden [&::-webkit-details-marker]:hidden">
            <span className="font-medium">provider</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[11px] text-[color:var(--utility-muted-text)]">{providerSummary}</span>
              <ChevronDown className="app-compact-model-menu-chevron h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
            </span>
          </summary>
          <div className="space-y-1 pb-2 pl-3 pt-1">
            {providerOptions.map((option) => {
              const isSelected = stagedProviderOption?.value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => chooseProvider(option)}
                  className={cn(
                    'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                    isSelected ? 'app-composer-popover-item-active' : '',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{lowerComposerLabel(option.label)}</span>
                    {option.detail ? <span className="block truncate text-[11px] text-[color:var(--utility-muted-text)]">{lowerComposerLabel(option.detail)}</span> : null}
                  </span>
                  <span className={cn('shrink-0 text-[11px] font-medium', isSelected ? 'text-emerald-300' : 'text-transparent')}>selected</span>
                </button>
              );
            })}
          </div>
        </details>
        <details className="border-b border-[color:var(--app-divider)] py-1">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-[12px] px-2.5 text-[12px] marker:hidden [&::-webkit-details-marker]:hidden">
            <span className="font-medium">model</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[11px] text-[color:var(--utility-muted-text)]">{modelSummary}</span>
              <ChevronDown className="app-compact-model-menu-chevron h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
            </span>
          </summary>
          <div className="space-y-1 pb-2 pl-3 pt-1">
            {visibleModelOptions.map((option) => {
              const isSelected = stagedModel === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => chooseModel(option)}
                  className={cn(
                    'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                    isSelected ? 'app-composer-popover-item-active' : '',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{lowerComposerLabel(option.label)}</span>
                    {option.detail ? <span className="block truncate text-[11px] text-[color:var(--utility-muted-text)]">{lowerComposerLabel(option.detail)}</span> : null}
                  </span>
                  <span className={cn('shrink-0 text-[11px] font-medium', isSelected ? 'text-emerald-300' : 'text-transparent')}>selected</span>
                </button>
              );
            })}
          </div>
        </details>
        <details className="py-1">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-[12px] px-2.5 text-[12px] marker:hidden [&::-webkit-details-marker]:hidden">
            <span className="font-medium">thinking level</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[11px] text-[color:var(--utility-muted-text)]">{thinkingSummary}</span>
              <ChevronDown className="app-compact-model-menu-chevron h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
            </span>
          </summary>
          <div className="space-y-1 pb-2 pl-3 pt-1">
            {stagedThinkingLevels.map((value) => {
              const isSelected = stagedThinkingValue === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStagedThinking(value)}
                  className={cn(
                    'app-composer-popover-item flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px]',
                    isSelected ? 'app-composer-popover-item-active' : '',
                  )}
                >
                  <span>{lowerComposerLabel(composerThinkingLabel(value))}</span>
                  <span className={cn('shrink-0 text-[11px] font-medium', isSelected ? 'text-emerald-300' : 'text-transparent')}>selected</span>
                </button>
              );
            })}
          </div>
        </details>
      </div>
      <div className="flex items-center justify-end gap-3 border-t border-[color:var(--app-divider)] px-3.5 py-3">
        <span className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={cancel} className="rounded-full px-3 py-1.5 text-[12px] font-medium text-[color:var(--utility-muted-text)] transition hover:text-[color:var(--utility-foreground)]">cancel</button>
          <button type="button" onClick={save} className="app-compact-model-menu-save rounded-full px-3 py-1.5 text-[12px] font-semibold transition">save</button>
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
        className="relative grid h-9 w-9 shrink-0 place-items-center border-0 bg-transparent text-[color:var(--utility-muted-text)] transition hover:text-[color:var(--utility-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300/60"
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
}) {
  const activeSelector = openSelector?.scope === scope ? openSelector.type : null;
  const selectedModelOption = modelOptions.find((option) => option.value === selection.model);
  const parsedSelection = selection.model.split('/');
  const fallbackProviderValue = normalizeComposerProviderId(parsedSelection[0] ?? '');
  const fallbackModelLabel = parsedSelection.slice(1).join('/').trim() || selection.model;
  const fallbackProviderKnown = Boolean(fallbackProviderValue) && (
    providerOptions.some((option) => normalizeComposerProviderId(option.providerId) === fallbackProviderValue)
    || modelOptions.some((option) => option.provider === fallbackProviderValue)
  );
  const selectedProviderValue = selectedModelOption?.provider ?? (fallbackProviderKnown ? fallbackProviderValue : '');
  const selectedAuthProviderOption = selection.authProvider
    ? providerOptions.find((option) => (
        option.providerId === selection.authProvider
        && authChoiceFromComposerProviderOption(option) === (selection.authChoice ?? null)
      )) ?? null
    : null;
  const selectedProviderOption = selectedAuthProviderOption ?? providerOptions.find(
    (option) => normalizeComposerProviderId(option.providerId) === selectedProviderValue && option.active,
  ) ?? providerOptions.find((option) => normalizeComposerProviderId(option.providerId) === selectedProviderValue) ?? null;
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

  return (
    <div className="relative flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => onToggleSelector(scope, 'provider')}
        className="inline-flex w-[8.75rem] min-w-0 items-center gap-1.5 rounded-full px-1 py-0.5 text-[12px] font-medium text-slate-300 transition hover:text-white"
      >
        <span className="truncate text-left">{selectedProviderLabel || 'Provider'}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', activeSelector === 'provider' ? 'rotate-180 text-slate-300' : '')} />
      </button>
      <button
        type="button"
        onClick={() => onToggleSelector(scope, 'model')}
        className="inline-flex w-[8.5rem] min-w-0 items-center gap-1.5 rounded-full px-1 py-0.5 text-[12px] font-medium text-slate-300 transition hover:text-white"
      >
        <span className="truncate text-left">{selectedModel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', activeSelector === 'model' ? 'rotate-180 text-slate-300' : '')} />
      </button>
      <button
        type="button"
        onClick={() => onToggleSelector(scope, 'thinking')}
        className="inline-flex w-[6.5rem] min-w-0 items-center gap-1.5 rounded-full px-1 py-0.5 text-[12px] font-medium text-slate-300 transition hover:text-white"
      >
        <span className="truncate text-left">{selectedThinkingLabel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', activeSelector === 'thinking' ? 'rotate-180 text-slate-300' : '')} />
      </button>
      {activeSelector && activeSelector !== 'mode' && (
        <div className="absolute bottom-full right-0 z-30 mb-2 max-h-[min(28rem,60vh)] w-[340px] overflow-y-auto rounded-[14px] border border-[color:var(--app-divider)] bg-[var(--app-modal-bg)] px-4 py-3 text-[12px] leading-[1.38] text-[color:var(--utility-foreground)] shadow-[var(--app-shadow-float)] backdrop-blur-xl">
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
              activeOptions.map((option, index) => {
                const isSelected = selection.model === option.value || selectedThinkingValue === option.value;
                return (
                  <Fragment key={option.value}>
                    <button
                      type="button"
                      onClick={() => onSelectValue(scope, activeSelector, option.value)}
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
      )}
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
          className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full outline-none"
          aria-label="Context window"
        >
          <span className="relative h-3.5 w-3.5 shrink-0 rounded-full" style={ringStyle}>
            <span className="absolute inset-[2.15px] rounded-full bg-[color:var(--app-main-bg)]" />
            <span className="absolute inset-0 rounded-full ring-1 ring-[color:var(--app-divider)]" />
          </span>
        </button>
        <div className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-2 w-[264px] -translate-x-1/2 rounded-[14px] border border-[color:var(--app-divider)] bg-[var(--app-modal-bg)] px-4 py-3 text-[12px] leading-[1.38] text-[color:var(--utility-foreground)] opacity-0 shadow-[var(--app-shadow-float)] backdrop-blur-xl transition duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
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
        <div className="absolute bottom-full left-0 z-30 mb-2 min-w-[260px] rounded-[14px] border border-[color:var(--app-divider)] bg-[var(--app-modal-bg)] px-4 py-3 text-[12px] leading-[1.38] text-[color:var(--utility-foreground)] shadow-[var(--app-shadow-float)] backdrop-blur-xl">
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
