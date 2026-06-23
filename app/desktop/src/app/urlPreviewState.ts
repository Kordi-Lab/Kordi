import type { DetailTab, NavId, ThemeMode, ContactClass } from '@/kordi-app/types';

export type KordiUrlPreviewState = {
  enabled: boolean;
  themeMode?: Exclude<ThemeMode, 'auto'>;
  activeNav?: NavId;
  activeDetailTab?: DetailTab;
  activeConvId?: string;
  activeContactGroup?: ContactClass;
  activeContactId?: string;
  activeAgentId?: string;
  activeSettingsSectionId?: string;
};

const VALID_NAV_IDS = new Set<NavId>(['chats', 'contacts', 'projects', 'agents', 'bridge', 'settings']);
const VALID_DETAIL_TABS = new Set<DetailTab>(['info', 'context', 'artifacts', 'tasks']);
const VALID_CONTACT_GROUPS = new Set<ContactClass>(['my-agents', 'other-users-agents', 'other-users']);

function cleanParam(value: string | null): string | undefined {
  const clean = value?.trim();
  return clean || undefined;
}

function enabledFromParams(params: URLSearchParams): boolean {
  const explicit = cleanParam(params.get('kordi-preview'))?.toLowerCase();
  const alias = cleanParam(params.get('preview'))?.toLowerCase();
  return explicit === '1' || explicit === 'true' || explicit === 'ui' || alias === 'ui';
}

function navFromParams(params: URLSearchParams): NavId | undefined {
  const value = cleanParam(params.get('view') ?? params.get('nav')) as NavId | undefined;
  return value && VALID_NAV_IDS.has(value) ? value : undefined;
}

function detailTabFromParams(params: URLSearchParams): DetailTab | undefined {
  const value = cleanParam(params.get('detail') ?? params.get('tab')) as DetailTab | undefined;
  return value && VALID_DETAIL_TABS.has(value) ? value : undefined;
}

function contactGroupFromParams(params: URLSearchParams): ContactClass | undefined {
  const value = cleanParam(params.get('contactGroup')) as ContactClass | undefined;
  return value && VALID_CONTACT_GROUPS.has(value) ? value : undefined;
}

function themeFromParams(params: URLSearchParams): Exclude<ThemeMode, 'auto'> | undefined {
  const value = cleanParam(params.get('theme'))?.toLowerCase();
  return value === 'light' || value === 'dark' ? value : undefined;
}

export function parseKordiUrlPreviewState(input: string | URLSearchParams): KordiUrlPreviewState {
  const params = typeof input === 'string' ? new URLSearchParams(input.startsWith('?') ? input.slice(1) : input) : input;
  const enabled = enabledFromParams(params);
  if (!enabled) return { enabled: false };

  return {
    enabled: true,
    themeMode: themeFromParams(params),
    activeNav: navFromParams(params),
    activeDetailTab: detailTabFromParams(params),
    activeConvId: cleanParam(params.get('session') ?? params.get('chat')),
    activeContactGroup: contactGroupFromParams(params),
    activeContactId: cleanParam(params.get('contact')),
    activeAgentId: cleanParam(params.get('agent')),
    activeSettingsSectionId: cleanParam(params.get('settings')),
  };
}

export function readKordiUrlPreviewState(): KordiUrlPreviewState {
  if (typeof window === 'undefined') return { enabled: false };
  return parseKordiUrlPreviewState(window.location.search);
}
