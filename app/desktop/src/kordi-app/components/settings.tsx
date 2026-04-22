import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { settingsSections } from '../data';
import type { ThemeMode } from '../types';

export function SettingsValueControl({
  item,
  themeMode,
  onToggleTheme,
}: {
  item: (typeof settingsSections)[number]['items'][number];
  themeMode: ThemeMode;
  onToggleTheme: () => void;
}) {
  const control = item.control;
  const controlType = control?.type ?? 'select';

  if (controlType === 'theme') {
    const isLightTheme = themeMode === 'light';
    return (
      <button
        type="button"
        onClick={onToggleTheme}
        className="app-input-shell app-settings-control flex min-w-[232px] items-center justify-between gap-3 rounded-[14px] px-3 py-2 text-left transition"
      >
        <div className="flex items-center gap-3">
          <div
            className={cn('app-settings-control-icon grid h-6 w-6 place-items-center rounded-[10px] text-[11px] font-semibold', isLightTheme ? 'bg-white text-slate-900' : 'bg-slate-950 text-slate-100')}
          >
            {isLightTheme ? 'L' : 'D'}
          </div>
          <div>
            <div className="text-[13px] font-medium">{isLightTheme ? 'Light mode' : 'Dark mode'}</div>
            <div className="text-[11px] text-slate-400">{isLightTheme ? 'Switch to dark' : 'Switch to light'}</div>
          </div>
        </div>
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
      </button>
    );
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
