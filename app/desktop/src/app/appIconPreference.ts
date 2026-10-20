import { isTauriRuntime } from '@/features/cloud/loginWindow';

export const KORDI_APP_ICON_STORAGE_KEY = 'kordi.appIcon.v1';

// Keep in sync with scripts/kordi-app-icons/icons.mjs and the iOS picker.
export const KORDI_APP_ICONS = [
  { key: 'white', label: 'White', bg: '#ffffff' },
  { key: 'frosted', label: 'Frosted Glass', bg: '#f3f1ee', frosted: true },
  { key: 'rice', label: 'Rice Paper', bg: '#fbf5ea' },
  { key: 'coral', label: 'Coral', bg: '#ff8a6b' },
  { key: 'sakura', label: 'Sakura', bg: '#f9c6d3' },
  { key: 'butter', label: 'Butter', bg: '#ffd96a', beak: '#f08a24' },
  { key: 'mint', label: 'Mint', bg: '#bfe6cf' },
  { key: 'sky', label: 'Sky', bg: '#a9d8f2' },
  { key: 'lavender', label: 'Lavender', bg: '#d6cdf3' },
  { key: 'night', label: 'Night', bg: '#2a2420', bird: '#f4ede1' },
  { key: 'midnight', label: 'Midnight', bg: '#1c2a44', bird: '#f4ede1' },
  { key: 'forest', label: 'Forest', bg: '#1f3a30', bird: '#f4ede1' },
  { key: 'plum', label: 'Plum', bg: '#3a2240', bird: '#f4ede1' },
  { key: 'cocoa', label: 'Cocoa', bg: '#4a3226', bird: '#f4ede1' },
  { key: 'slate', label: 'Slate', bg: '#3b4250', bird: '#f4ede1' },
  { key: 'night-sakura', label: 'Night Sakura', bg: '#2a2420', bird: '#f9c6d3' },
  { key: 'midnight-sky', label: 'Midnight Sky', bg: '#1c2a44', bird: '#a9d8f2' },
] as const;

export type AppIcon = (typeof KORDI_APP_ICONS)[number];
export type AppIconKey = AppIcon['key'];
export const DEFAULT_APP_ICON: AppIconKey = 'white';

export function isAppIconKey(value: unknown): value is AppIconKey {
  return KORDI_APP_ICONS.some((icon) => icon.key === value);
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredAppIcon(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): AppIconKey {
  try {
    const value = storage?.getItem(KORDI_APP_ICON_STORAGE_KEY);
    return isAppIconKey(value) ? value : DEFAULT_APP_ICON;
  } catch {
    return DEFAULT_APP_ICON;
  }
}

export function writeStoredAppIcon(
  key: AppIconKey,
  storage: Pick<Storage, 'setItem'> | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(KORDI_APP_ICON_STORAGE_KEY, key);
  } catch {
    // Ignore unavailable localStorage; the Dock icon still changes for this launch.
  }
}

// Swaps the Dock icon while Kordi runs. The native side keeps development
// profiles on their gray icon and restores the bundle icon for `white`.
export function applyAppIcon(key: AppIconKey): void {
  if (!isTauriRuntime()) return;
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('desktop_set_app_icon', { key }))
    .catch(() => undefined);
}
