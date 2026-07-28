import { KeyRound, Sparkles, type LucideIcon } from 'lucide-react';

export type SettingsSectionId =
  | 'general'
  | 'appearance'
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
  hint: string;
  control?: SettingsControl;
};

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  title: string;
  description: string;
  items: SettingsItem[];
};

export const settingsSections: SettingsSection[] = [
  {
    id: 'auth',
    label: 'Authentication',
    icon: KeyRound,
    title: 'Authentication',
    description: 'Connect Kordi to cloud accounts or local model servers and manage saved access.',
    items: [],
  },
  {
    id: 'appearance',
    label: 'Theme',
    icon: Sparkles,
    title: 'Theme',
    description: 'Choose the primary interface palette.',
    items: [
      {
        label: 'Theme',
        value: 'Obsidian',
        hint: 'Primary interface palette for the app.',
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
