import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, X } from 'lucide-react';
import { modelDisplayName, modelEffortLabel } from '@/lib/modelDisplayName';
import { cn } from '@/lib/utils';
import { composerThinkingLevelsIncludingCurrent } from './composerThinking';
import {
  composerModelsForProvider, composerProviderOptionUsable, normalizeComposerProviderId,
  providerDisplayLabel, resolveComposerModelSelection, resolveComposerRoutePick,
  type ComposerModelOption, type ComposerProviderOption, type ComposerRoute, type ComposerRoutePick,
} from './composerModelSelection';

type View = 'model' | 'all' | 'thinking' | 'provider' | 'confirm';
type PickType = 'provider' | 'model' | 'thinking';
export type ModelEffortPickerProps = {
  selection: { model: string; thinking: string; authProvider?: string | null; authChoice?: string | null };
  providerOptions: ComposerProviderOption[];
  modelOptions: ComposerModelOption[];
  onApply: (route: ComposerRoute, type: PickType) => void | boolean | Promise<void | boolean>;
  confirmAccountChanges?: boolean;
  defaultOpen?: boolean;
  onSignIn?: () => void;
};

export function ModelEffortPicker({ selection, providerOptions, modelOptions, onApply,
  confirmAccountChanges = false, defaultOpen = false, onSignIn }: ModelEffortPickerProps) {
  const id = useId();
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const busyRef = useRef(false);
  const [view, setView] = useState<View | null>(defaultOpen ? 'model' : null);
  const [position, setPosition] = useState<CSSProperties>({});
  const [light, setLight] = useState(false);
  const [query, setQuery] = useState('');
  const [effortDraft, setEffortDraft] = useState<{ model: string; selection: string; value: string } | null>(null);
  const draftEffort = effortDraft?.model === selection.model && effortDraft.selection === selection.thinking
    ? effortDraft.value : selection.thinking;
  const setDraftEffort = (value: string) => setEffortDraft({ model: selection.model, selection: selection.thinking, value });
  const [pending, setPending] = useState<{ route: ComposerRoute; type: PickType } | null>(null);
  const [accountModel, setAccountModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ route: ComposerRoute; type: PickType } | null>(null);
  const resolved = resolveComposerModelSelection({ selection, providerOptions, modelOptions });
  const account = resolved.selectedProviderOption;
  const name = modelDisplayName(selection.model, resolved.selectedModelOption?.label);
  const levels = composerThinkingLevelsIncludingCurrent(
    resolved.selectedModelOption?.thinkingLevels ?? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], selection.thinking,
  ).filter((value) => !['default', 'auto', 'thinking'].includes(value));
  const uniqueLevels = [...new Set(levels)];
  const effortIndex = Math.max(0, uniqueLevels.indexOf(draftEffort));
  const defaultModel = composerModelsForProvider(account?.providerId ?? resolved.selectedProviderValue, modelOptions)[0];
  const requestedModel = modelOptions.find((option) => option.value === accountModel);
  const accountProvider = requestedModel?.provider ?? account?.providerId ?? resolved.selectedProviderValue;
  const accounts = accountProvider
    ? providerOptions.filter((option) => normalizeComposerProviderId(option.providerId) === normalizeComposerProviderId(accountProvider))
    : providerOptions;
  const visibleModels = modelOptions.filter((option) => view !== 'all'
    || `${modelDisplayName(option.value, option.label)} ${option.providerLabel ?? option.provider ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const shortModels = visibleModels.slice(0, 5);
  if (resolved.selectedModelOption && !shortModels.includes(resolved.selectedModelOption)) shortModels.push(resolved.selectedModelOption);

  const close = useCallback(() => {
    setView(null); setPending(null); setAccountModel(null); setError(null); setRetry(null);
    returnFocusRef.current?.focus();
  }, []);
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || !view) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(view === 'thinking' ? 232 : 288, window.innerWidth - 24);
    const above = rect.top > (view === 'thinking' ? 140 : 330);
    const shell = trigger.closest('.kordi-app');
    setLight(Boolean(shell?.classList.contains('theme-light')));
    const tokens: Record<string, string> = {};
    const styles = window.getComputedStyle(trigger);
    // Portals must inherit the active conversation palette, not the body's default.
    for (const token of ['--app-accent', '--app-palette-accent-ink', '--app-transient-surface-bg', '--app-transient-border',
      '--app-transient-text', '--app-transient-muted-text', '--app-transient-hover-bg',
      '--app-transient-selected-bg', '--app-transient-divider', '--app-transient-shadow', '--app-control-bg']) {
      const value = styles.getPropertyValue(token).trim();
      if (value) tokens[token] = value;
    }
    setPosition({ ...tokens, width, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      top: above ? rect.top - 8 : rect.bottom + 8,
      maxHeight: Math.max(80, above ? rect.top - 20 : window.innerHeight - rect.bottom - 20),
      transform: above ? 'translateY(-100%)' : 'none' });
  }, [view]);
  useEffect(() => {
    if (!view) return;
    updatePosition();
    const observer = new window.MutationObserver(updatePosition);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-kordi-chat-theme'] });
    const shell = triggerRef.current?.closest('.kordi-app');
    if (shell) observer.observe(shell, { attributes: true });
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const focus = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('input,button:not(:disabled)')?.focus());
    return () => { observer.disconnect(); window.cancelAnimationFrame(focus); window.removeEventListener('resize', updatePosition); window.removeEventListener('scroll', updatePosition, true); };
  }, [view, updatePosition]);
  useEffect(() => {
    if (!view) return;
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? []);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('pointerdown', pointer, true); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', key, true); };
  }, [view, close]);

  const apply = async (route: ComposerRoute, type: PickType) => {
    if (busyRef.current) return;
    const focusedControl = menuRef.current?.contains(document.activeElement)
      ? document.activeElement as HTMLElement : null;
    busyRef.current = true; setSaving(true); setError(null); setRetry(null);
    try {
      if (await onApply(route, type) === false) throw new Error('Unable to change the model route. Try again.');
      setPending(null);
      if (type !== 'thinking') close();
      else window.requestAnimationFrame(() => {
        if (focusedControl && menuRef.current?.contains(focusedControl)) focusedControl.focus();
      });
    } catch (reason) {
      setDraftEffort(selection.thinking);
      setError(reason instanceof Error ? reason.message : 'Unable to change the model route.');
      setRetry({ route, type });
    } finally { busyRef.current = false; setSaving(false); }
  };
  const submit = (route: ComposerRoute, type: PickType) => {
    if (confirmAccountChanges && account?.value !== route.providerOption?.value) {
      setPending({ route, type }); setView('confirm');
    } else void apply(route, type);
  };
  const pick = (choice: ComposerRoutePick) => {
    if (choice.type !== 'provider' && (!composerProviderOptionUsable(account)
      || (choice.type === 'model' && modelOptions.find((option) => option.value === choice.value)?.provider
        && normalizeComposerProviderId(modelOptions.find((option) => option.value === choice.value)!.provider!) !== normalizeComposerProviderId(account!.providerId)))) {
      setAccountModel(choice.type === 'model' ? choice.value : selection.model); setView('provider'); return;
    }
    const route = resolveComposerRoutePick({ selection, providerOptions, modelOptions, pick: choice });
    if (route) submit(route, choice.type);
    else { setView('provider'); setError('Choose a signed-in account.'); }
  };
  const reset = () => pick({ type: 'thinking', value: 'default' });
  const commitEffort = (value: string) => {
    if (value && value !== selection.thinking) pick({ type: 'thinking', value });
  };
  const modelRow = (option: ComposerModelOption) => <button key={option.value} type="button" className="app-transient-action-row app-model-picker-row"
    disabled={saving} aria-pressed={option.value === selection.model} onClick={() => pick({ type: 'model', value: option.value })}>
    <span>{modelDisplayName(option.value, option.label)}<small className="app-transient-metadata">{option.providerLabel ?? providerDisplayLabel(option.provider ?? '')}</small></span>
    {option.value === selection.model ? <Check size={14} aria-hidden="true" /> : null}
  </button>;
  const menu = <div ref={menuRef} id={id} role="dialog" aria-label={view === 'thinking' ? 'Thinking effort' : view === 'provider' ? 'Choose account' : view === 'confirm' ? 'Change shared account' : 'Select model'}
    aria-busy={saving} className={cn('app-transient-surface app-transient-scroll app-compact-model-menu app-composer-model-menu-layer app-model-picker', light && 'app-compact-model-menu-light', view === 'thinking' && 'app-model-picker-effort')} style={position}>
    {view === 'thinking' ? <>
      <div className="app-effort-heading"><div className="app-effort-identity"><strong>{modelEffortLabel(draftEffort)}</strong>
        <button type="button" onClick={() => setView('model')}><span className="truncate">{name}</span><ChevronRight size={11} aria-hidden="true" /></button></div>
        <button type="button" className="app-effort-reset" onClick={reset} disabled={saving || !composerProviderOptionUsable(account)} aria-label="Reset effort to model default"><RotateCcw size={14} /></button></div>
      {uniqueLevels.length > 1 ? <div className="app-effort-track" style={{ '--effort-fill': `${uniqueLevels.includes(draftEffort) ? 5 + effortIndex / (uniqueLevels.length - 1) * 90 : 0}%` } as CSSProperties}>
        <div className="app-effort-fill" /><div className="app-effort-dots" aria-hidden="true">{uniqueLevels.map((level) => <i key={level} />)}</div>
        <input type="range" aria-label="Thinking effort" aria-valuetext={modelEffortLabel(draftEffort)} min={0} max={uniqueLevels.length - 1} step={1} value={effortIndex}
          disabled={saving || !composerProviderOptionUsable(account)}
          onChange={(event) => setDraftEffort(uniqueLevels[Number(event.target.value)])}
          onPointerUp={(event) => commitEffort(uniqueLevels[Number(event.currentTarget.value)])}
          onKeyUp={(event) => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) commitEffort(uniqueLevels[Number(event.currentTarget.value)]); }}
          onBlur={() => { if (draftEffort !== selection.thinking) commitEffort(draftEffort); }} />
      </div> : null}
    </> : <>
      <div className="app-model-picker-heading">{view !== 'model' ? <button type="button" onClick={() => { setPending(null); setView('model'); }} aria-label="Back to models"><ChevronLeft size={16} /></button> : null}
        <strong>{view === 'provider' ? 'Choose account' : view === 'confirm' ? 'Change shared account?' : 'Select model'}</strong>
        <button type="button" onClick={close} aria-label="Close model picker"><X size={15} /></button></div>
      {view === 'confirm' && pending ? <>
        <p className="app-model-picker-message">Use {pending.route.providerOption?.selectionLabel ?? pending.route.providerOption?.label} for future agent replies in this conversation?</p>
        <div className="app-model-picker-actions"><button type="button" onClick={close}>Cancel</button><button type="button" disabled={saving} onClick={() => void apply(pending.route, pending.type)}>Change account</button></div>
      </> : view === 'provider' ? <>
        {account?.unavailable ? <p role="status" className="app-model-picker-message">Account unavailable. Choose a signed-in account.</p> : null}
        {accounts.map((option) => <button key={option.value} type="button" className="app-transient-action-row app-model-picker-row" disabled={saving || !composerProviderOptionUsable(option)} title={option.disabledReason}
          onClick={() => {
            const route = resolveComposerRoutePick({ selection: { ...selection, model: accountModel ?? selection.model }, providerOptions, modelOptions, pick: { type: 'provider', option } });
            if (route) submit(route, 'provider');
          }}><span>{option.selectionLabel ?? option.label}{option.detail ? <small className="app-transient-metadata">{option.detail}</small> : null}</span>{account?.value === option.value ? <Check size={14} /> : null}</button>)}
        {!accounts.some(composerProviderOptionUsable) ? <p className="app-model-picker-message">No signed-in account for {providerDisplayLabel(accountProvider)}.</p> : null}
        {onSignIn ? <button type="button" className="app-transient-action-row app-model-picker-row" onClick={onSignIn}>Sign in</button> : null}
      </> : <>
        {account?.unavailable ? <button type="button" className="app-transient-action-row app-model-picker-row" onClick={() => { setAccountModel(null); setView('provider'); }}>Account unavailable<ChevronRight size={14} /></button> : null}
        {view === 'all' ? <input className="app-model-picker-search" aria-label="Find a model" placeholder="Find a model…" value={query} onChange={(event) => setQuery(event.target.value)} />
          : <button type="button" className="app-transient-action-row app-model-picker-row" disabled={saving || !defaultModel} onClick={() => {
            if (!defaultModel) return;
            if (!composerProviderOptionUsable(account)) { setAccountModel(defaultModel.value); setView('provider'); return; }
            const route = resolveComposerRoutePick({ selection: { ...selection, thinking: 'default' }, providerOptions, modelOptions, pick: { type: 'model', value: defaultModel.value } });
            if (route) submit({ ...route, thinking: 'default' }, 'model');
          }}><span>Default{defaultModel ? <small className="app-transient-metadata">{modelDisplayName(defaultModel.value, defaultModel.label)}</small> : null}</span></button>}
        <div className="app-model-picker-list">{(view === 'all' ? visibleModels : shortModels).map(modelRow)}
          {!visibleModels.length ? <p className="app-model-picker-message">{query ? 'No models found.' : 'No models available.'}</p> : null}</div>
        {view !== 'all' && modelOptions.length > 5 ? <button type="button" className="app-transient-action-row app-model-picker-row" onClick={() => { setQuery(''); setView('all'); }}>More models<ChevronRight size={14} /></button> : null}
        <div className="app-model-picker-divider" />
        <button type="button" className="app-transient-action-row app-model-picker-row app-model-picker-account" onClick={() => { setAccountModel(null); setView('provider'); }}>{account?.selectionLabel ?? account?.label ?? 'Choose account'}<ChevronRight size={14} /></button>
      </>}
    </>}
    {error ? <div role="alert" className="app-model-picker-message">{error}{retry ? <button type="button" onClick={() => void apply(retry.route, retry.type)} disabled={saving}>Retry</button> : null}</div> : null}
  </div>;
  if (onSignIn && !account?.unavailable && !providerOptions.some(composerProviderOptionUsable)) {
    return <div className="flex items-center gap-2 text-xs" data-composer-sign-in="true"><span>No account</span>
      <button type="button" className="app-button-quiet rounded-full px-2 py-1" onClick={onSignIn}>Sign in</button></div>;
  }
  return <div className="app-model-effort-pill" ref={triggerRef}>
    <button type="button" aria-haspopup="dialog" aria-expanded={view !== null && view !== 'thinking'} aria-controls={id}
      aria-label={`Select model, current ${name}${account?.unavailable ? ', Account unavailable' : ''}`}
      onClick={(event) => { returnFocusRef.current = event.currentTarget; setView(view === 'model' ? null : 'model'); setError(null); }}>
      <span className="truncate">{account?.unavailable ? 'Account unavailable' : name}</span></button>
    <button type="button" aria-haspopup="dialog" aria-expanded={view === 'thinking'} aria-controls={id} aria-label={`Adjust effort, current ${modelEffortLabel(selection.thinking)}`}
      onClick={(event) => { returnFocusRef.current = event.currentTarget; setView(view === 'thinking' ? null : 'thinking'); setError(null); }}>
      {modelEffortLabel(selection.thinking)}<ChevronDown size={12} aria-hidden="true" /></button>
    {view ? typeof document !== 'undefined' ? createPortal(menu, document.body) : menu : null}
  </div>;
}
