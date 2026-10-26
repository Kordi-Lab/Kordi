import type { NavId } from '@/kordi-app/types';
import type { CloudAccountSettingsTabId } from '@/pages/cloudAccountSettingsNav';

export type HelpAction =
  | { kind: 'navigate'; page: NavId }
  | { kind: 'settings'; tab: CloudAccountSettingsTabId }
  | { kind: 'grounding' | 'support' | 'updates' | 'permissions' };
