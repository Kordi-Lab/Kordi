import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

import {
  applyChatTheme,
  readStoredChatTheme,
  writeStoredChatTheme,
  type ChatTheme,
} from '@/app/themePreference';
import { cn } from '@/lib/utils';
import { settingsSections } from '../data';
import type { ThemeMode } from '../types';

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; detail: string }> = [
  { mode: 'auto', label: 'System', detail: 'Match your device' },
  { mode: 'light', label: 'Light', detail: 'Always use light appearance' },
  { mode: 'dark', label: 'Dark', detail: 'Always use dark appearance' },
];

const CHAT_THEME_OPTIONS: Array<{ theme: ChatTheme; label: string; detail: string }> = [
  { theme: 'quiet', label: 'Quiet Signal', detail: 'Calm neutrals with restrained blue signals' },
  { theme: 'midnight', label: 'Midnight Violet', detail: 'Deep violet surfaces with a subtle star field' },
  { theme: 'sand', label: 'Warm Sand', detail: 'Low-glare earth tones with warm message color' },
  { theme: 'ocean', label: 'Ocean Slate', detail: 'Cool mineral surfaces with a quiet ripple pattern' },
];

function ThemePreview({ mode, selected }: { mode: ThemeMode; selected: boolean }) {
  const dark = mode === 'dark';
  const surfaceClass = dark ? 'bg-[#51545a]' : 'bg-[#f1f2f4]';
  const panelClass = dark ? 'border-white/10 bg-[#24272d]' : 'border-slate-900/8 bg-white';
  const strongLineClass = dark ? 'bg-white/24' : 'bg-slate-900/16';
  const softLineClass = dark ? 'bg-white/12' : 'bg-slate-900/8';

  return (
    <div
      className={cn(
        'app-settings-theme-preview relative h-24 overflow-hidden rounded-[12px] border transition-none',
        mode === 'auto' ? 'bg-slate-100' : surfaceClass,
        selected ? 'border-emerald-300/85 ring-2 ring-emerald-400/70 ring-offset-1 ring-offset-transparent' : 'border-white/12',
      )}
      aria-hidden="true"
    >
      {mode === 'auto' ? (
        <>
          <div className="absolute inset-y-0 left-0 w-1/2 bg-[#f1f2f4]" />
          <div className="absolute inset-y-0 right-0 w-1/2 bg-[#51545a]" />
        </>
      ) : null}
      <div className={cn(
        'absolute left-[18%] right-[18%] top-3 h-1.5 rounded-full',
        mode === 'auto' ? 'bg-slate-500/25' : strongLineClass,
      )} />
      <div className={cn(
        'absolute inset-x-3 bottom-2 top-7 overflow-hidden rounded-[9px] border',
        mode === 'auto' ? 'border-slate-500/10 bg-white' : panelClass,
      )}>
        {mode === 'auto' ? <div className="absolute inset-y-0 right-0 w-1/2 bg-[#24272d]" /> : null}
        <div className={cn(
          'relative h-7 border-b px-2 py-2',
          mode === 'auto' ? 'border-slate-500/10' : dark ? 'border-white/8' : 'border-slate-900/8',
        )}>
          <div className={cn('h-1.5 w-1/3 rounded-full', mode === 'auto' ? 'bg-slate-500/20' : strongLineClass)} />
        </div>
        <div className="relative space-y-2 px-2 py-2">
          <div className={cn('h-1.5 w-2/5 rounded-full', mode === 'auto' ? 'bg-slate-500/20' : strongLineClass)} />
          <div className={cn('h-1.5 w-3/5 rounded-full', mode === 'auto' ? 'bg-slate-500/12' : softLineClass)} />
        </div>
      </div>
    </div>
  );
}

function ThemeModeSelector({ themeMode, onSelectThemeMode }: { themeMode: ThemeMode; onSelectThemeMode: (mode: ThemeMode) => void }) {
  return (
    <div className="w-full" role="radiogroup" aria-label="Theme mode">
      <div className="grid grid-cols-3 gap-3">
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
              className="app-settings-theme-option group min-w-0 rounded-[14px] bg-transparent p-1 text-center outline-none transition-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-emerald-300/80"
            >
              <ThemePreview mode={option.mode} selected={selected} />
              <div className={cn('mt-2 text-[12px] font-medium leading-4', selected ? 'text-white' : 'text-slate-400 group-hover:text-slate-200')}>
                {option.label}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChatThemePreview({ theme, selected }: { theme: ChatTheme; selected: boolean }) {
  return (
    <div
      data-kordi-chat-theme={theme}
      className={cn(
        'app-chat-theme-preview relative h-24 overflow-hidden rounded-[12px] border bg-[image:var(--app-chat-wallpaper)] [background-size:var(--app-chat-wallpaper-size)]',
        selected
          ? 'border-[color:var(--app-chat-accent)] ring-2 ring-[color:var(--app-chat-accent)] ring-offset-1 ring-offset-transparent'
          : 'border-[color:var(--app-chat-bubble-peer-border)]',
      )}
      aria-hidden="true"
    >
      <div className="absolute inset-x-0 top-0 flex h-7 items-center gap-1.5 border-b border-[color:var(--app-chat-bubble-peer-border)] bg-[color:var(--app-chat-bubble-peer-bg)] px-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#847ac4]" />
        <span className="h-1.5 w-12 rounded-full bg-[color:var(--app-chat-bubble-peer-text)] opacity-45" />
      </div>
      <div className="absolute bottom-8 left-2 h-3 w-[48%] rounded-[8px_8px_8px_3px] bg-[color:var(--app-chat-bubble-peer-bg)]" />
      <div className="absolute bottom-3 right-2 h-3 w-[58%] rounded-[8px_8px_3px_8px] bg-[color:var(--app-chat-bubble-user-bg)]" />
      <span className="absolute bottom-[15px] right-4 h-1 w-10 rounded-full bg-[color:var(--app-chat-bubble-user-text)] opacity-55" />
    </div>
  );
}

function ChatThemeSelector() {
  const [chatTheme, setChatTheme] = useState<ChatTheme>(() => readStoredChatTheme());

  return (
    <div className="w-full" role="radiogroup" aria-label="Chat theme">
      <div className="grid grid-cols-2 gap-3">
        {CHAT_THEME_OPTIONS.map((option) => {
          const selected = chatTheme === option.theme;
          return (
            <button
              key={option.theme}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.label + ' chat theme'}
              title={option.detail}
              onClick={() => {
                setChatTheme(option.theme);
                writeStoredChatTheme(option.theme);
                applyChatTheme(option.theme);
              }}
              className="group min-w-0 rounded-[14px] bg-transparent p-1 text-center outline-none transition-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-[color:var(--app-chat-accent)]"
            >
              <ChatThemePreview theme={option.theme} selected={selected} />
              <div className={cn(
                'mt-2 truncate text-[12px] leading-4 text-[color:var(--utility-foreground)]',
                selected ? 'font-semibold' : 'font-medium opacity-65 group-hover:opacity-90',
              )}>
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

  if (controlType === 'chat-theme') {
    return <ChatThemeSelector />;
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
        <button type="button" className="app-button-quiet app-settings-action-button rounded-xl px-2.5 py-1 text-[12px] font-medium">
          {control?.type === 'action' ? (control.actionLabel ?? 'Set') : 'Set'}
        </button>
      </div>
    );
  }

  return (
    <button type="button" className="app-input-shell app-settings-control flex min-w-[232px] items-center justify-between gap-3 rounded-[14px] px-3 py-2 text-left transition">
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
