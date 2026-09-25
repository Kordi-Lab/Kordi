import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

import {
  applyChatTheme,
  readStoredChatTheme,
  writeStoredChatTheme,
  type ChatTheme,
} from '@/app/themePreference';
import { settingsSections } from '../data';
import { SettingsSelect, SettingsSwitch } from './settingsLayout';
import type { ThemeMode } from '../types';

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'auto', label: 'System' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

const CHAT_THEME_OPTIONS: Array<{ theme: ChatTheme; label: string }> = [
  { theme: 'quiet', label: 'Quiet Signal' },
  { theme: 'midnight', label: 'Midnight Violet' },
  { theme: 'sand', label: 'Warm Sand' },
  { theme: 'ocean', label: 'Ocean Slate' },
];

function ChatThemeSelector() {
  const [chatTheme, setChatTheme] = useState<ChatTheme>(() => readStoredChatTheme());

  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        data-kordi-chat-theme={chatTheme}
        className="app-chat-theme-preview relative h-6 w-9 overflow-hidden rounded-md border border-[color:var(--app-chat-bubble-peer-border)] bg-[image:var(--app-chat-wallpaper)] [background-size:var(--app-chat-wallpaper-size)]"
      >
        <span className="absolute bottom-1 right-1 h-1.5 w-5 rounded-full bg-[color:var(--app-chat-bubble-user-bg)]" />
      </span>
      <SettingsSelect
        label="Chat theme"
        value={chatTheme}
        options={CHAT_THEME_OPTIONS.map((option) => ({ value: option.theme, label: option.label }))}
        onChange={(event) => {
          const theme = event.target.value as ChatTheme;
          setChatTheme(theme);
          writeStoredChatTheme(theme);
          applyChatTheme(theme);
        }}
      />
    </span>
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
    return (
      <SettingsSelect
        label="App appearance"
        value={themeMode}
        options={THEME_OPTIONS.map((option) => ({ value: option.mode, label: option.label }))}
        onChange={(event) => onSelectThemeMode(event.target.value as ThemeMode)}
      />
    );
  }

  if (controlType === 'chat-theme') {
    return <ChatThemeSelector />;
  }

  if (controlType === 'toggle') {
    const enabled = control?.type === 'toggle' ? control.enabled : false;
    return <SettingsSwitch enabled={enabled} label={item.label} onChange={() => undefined} disabled />;
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
