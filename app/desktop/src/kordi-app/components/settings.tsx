import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { settingsSections } from '../data';
import type { ThemeMode } from '../types';

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; detail: string }> = [
  { mode: 'auto', label: 'Auto', detail: 'Match macOS' },
  { mode: 'light', label: 'Light', detail: 'Bright surfaces' },
  { mode: 'dark', label: 'Dark', detail: 'Dim surfaces' },
];

function ThemePreview({ mode, selected }: { mode: ThemeMode; selected: boolean }) {
  const surfaceClass = mode === 'dark'
    ? 'from-[#273057] via-[#14205a] to-[#08122d]'
    : 'from-[#f7f3e7] via-[#d9ecf2] to-[#8fb6de]';
  const railClass = mode === 'dark' ? 'bg-[#060a18]/92' : 'bg-[#fff8e8]/94';
  const panelClass = mode === 'dark' ? 'bg-[#17224a]/86' : 'bg-white/86';
  const dotClass = mode === 'dark' ? 'bg-[#ffb84d]' : 'bg-[#ff6157]';

  return (
    <div
      className={cn(
        'relative h-[46px] overflow-hidden rounded-[11px] border bg-gradient-to-br shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] transition',
        mode === 'auto' ? 'from-[#f5f0e3] via-[#d8edf2] to-[#07112d]' : surfaceClass,
        selected ? 'border-emerald-300/85 ring-2 ring-emerald-400/70 ring-offset-1 ring-offset-transparent' : 'border-white/12',
      )}
      aria-hidden="true"
    >
      {mode === 'auto' ? (
        <>
          <div className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-br from-[#fff8e7] via-[#d8edf2] to-[#8fb5dc]" />
          <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-br from-[#273057] via-[#14205a] to-[#08122d]" />
          <div className="absolute inset-y-1 left-1 w-[calc(50%-6px)] rounded-[8px] bg-white/76" />
          <div className="absolute inset-y-1 right-1 w-[calc(50%-6px)] rounded-[8px] bg-[#081126]/78" />
        </>
      ) : (
        <>
          <div className={cn('absolute inset-y-1 left-1 w-4 rounded-[7px]', railClass)} />
          <div className={cn('absolute inset-y-1 right-1 left-6 rounded-[8px]', panelClass)} />
        </>
      )}
      <div className="absolute left-2 top-2 h-1.5 w-8 rounded-full bg-emerald-400/85" />
      <div className="absolute right-2 top-2 h-1.5 w-5 rounded-full bg-sky-400/70" />
      <div className="absolute bottom-2 left-2 flex gap-1">
        <span className={cn('h-1.5 w-1.5 rounded-full', dotClass)} />
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </div>
      <div className={cn('absolute bottom-2 right-2 h-2 w-6 rounded-full', mode === 'dark' ? 'bg-white/16' : 'bg-slate-900/12')} />
    </div>
  );
}

function ThemeModeSelector({ themeMode, onSelectThemeMode }: { themeMode: ThemeMode; onSelectThemeMode: (mode: ThemeMode) => void }) {
  return (
    <div className="min-w-[278px]" role="radiogroup" aria-label="Theme mode">
      <div className="grid grid-cols-3 gap-2">
        {THEME_OPTIONS.map((option) => {
          const selected = themeMode === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${option.label} theme`}
              title={option.detail}
              onClick={() => onSelectThemeMode(option.mode)}
              className={cn(
                'group rounded-[14px] p-1 text-center outline-none transition focus-visible:ring-2 focus-visible:ring-emerald-300/80',
                selected ? 'bg-emerald-400/10' : 'hover:bg-white/[0.04]',
              )}
            >
              <ThemePreview mode={option.mode} selected={selected} />
              <div className={cn('mt-1 text-[11px] font-medium leading-4', selected ? 'text-white' : 'text-slate-400 group-hover:text-slate-200')}>
                {option.label}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SettingsValueControl({
  item,
  themeMode,
  onSelectThemeMode,
}: {
  item: (typeof settingsSections)[number]['items'][number];
  themeMode: ThemeMode;
  onSelectThemeMode: (mode: ThemeMode) => void;
}) {
  const control = item.control;
  const controlType = control?.type ?? 'select';

  if (controlType === 'theme') {
    return <ThemeModeSelector themeMode={themeMode} onSelectThemeMode={onSelectThemeMode} />;
  }

  if (controlType === 'toggle') {
    const enabled = control?.type === 'toggle' ? control.enabled : false;
    return (
      <div
        className={cn(
          'app-settings-toggle relative h-9 w-[66px] rounded-full transition',
          enabled ? 'bg-emerald-500' : 'app-input-shell',
        )}
      >
        <div
          className={cn(
            'absolute top-1 h-7 w-7 rounded-full bg-white shadow-sm transition',
            enabled ? 'left-[31px]' : 'left-1',
          )}
        />
      </div>
    );
  }

  if (controlType === 'action') {
    return (
      <div className="app-settings-action-row flex items-center justify-end gap-2.5">
        <div className="text-[12px] font-medium text-slate-300">{item.value}</div>
        <button className="app-control-chip app-settings-action-button rounded-xl px-2.5 py-1 text-[12px] font-medium transition">
          {control?.type === 'action' ? (control.actionLabel ?? 'Set') : 'Set'}
        </button>
      </div>
    );
  }

  return (
    <button className="app-input-shell app-settings-control flex min-w-[232px] items-center justify-between gap-3 rounded-[14px] px-3 py-2 text-left transition">
      <div className="flex items-center gap-3">
        {control?.type === 'select' && control.iconGlyph && (
          <div className="app-settings-control-icon grid h-6 w-6 place-items-center rounded-[10px] bg-slate-900 text-[13px] font-bold text-amber-400">
            {control.iconGlyph}
          </div>
        )}
        <div className="text-[13px] font-medium">{item.value}</div>
      </div>
      <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
    </button>
  );
}
