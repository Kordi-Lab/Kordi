import { Bell, KeyRound, Sparkles, type LucideIcon } from 'lucide-react';

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'configuration'
  | 'auth'
  | 'personalization'
  | 'usage'
  | 'mcp'
  | 'git'
  | 'environments'
  | 'worktrees'
  | 'archived';

export type SettingsControl =
  | { type: 'select'; iconGlyph?: string }
  | { type: 'toggle'; enabled: boolean }
  | { type: 'action'; actionLabel?: string }
  | { type: 'theme' };

export type SettingsItem = {
  label: string;
  value: string;
  hint?: string;
  control?: SettingsControl;
};

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  title: string;
  items: SettingsItem[];
};

export const settingsSections: SettingsSection[] = [
  {
    id: 'auth',
    label: 'Authentication',
    icon: KeyRound,
    title: 'Authentication',
    items: [],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    title: 'Notifications',
    items: [],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Sparkles,
    title: 'Appearance',
    items: [
      {
        label: 'Theme',
        value: 'Obsidian',
        control: { type: 'theme' },
      },
    ],
  },
];

export function normalizeSettingsSectionIdForCloud(sectionId: SettingsSectionId): SettingsSectionId {
  return settingsSections.some((section) => section.id === sectionId)
    ? sectionId
    : 'auth';
}
