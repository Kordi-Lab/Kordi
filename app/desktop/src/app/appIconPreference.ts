import { isTauriRuntime } from '@/features/cloud/loginWindow';

export const KORDI_APP_ICON_STORAGE_KEY = 'kordi.appIcon.v1';

// Keep in sync with scripts/kordi-app-icons/icons.mjs and the iOS picker.
export const KORDI_APP_ICONS = [
  { key: 'white', label: 'White' },
  { key: 'frosted', label: 'Frosted Glass' },
  { key: 'rice', label: 'Rice Paper' },
  { key: 'coral', label: 'Coral' },
  { key: 'sakura', label: 'Sakura' },
  { key: 'butter', label: 'Butter' },
  { key: 'mint', label: 'Mint' },
  { key: 'sky', label: 'Sky' },
  { key: 'lavender', label: 'Lavender' },
  { key: 'night', label: 'Night' },
  { key: 'midnight', label: 'Midnight' },
  { key: 'forest', label: 'Forest' },
  { key: 'plum', label: 'Plum' },
  { key: 'cocoa', label: 'Cocoa' },
  { key: 'slate', label: 'Slate' },
  { key: 'night-sakura', label: 'Night Sakura' },
  { key: 'midnight-sky', label: 'Midnight Sky' },
] as const;

export type AppIconKey = (typeof KORDI_APP_ICONS)[number]['key'];
export const DEFAULT_APP_ICON: AppIconKey = 'white';

export function isAppIconKey(value: unknown): value is AppIconKey {
  return KORDI_APP_ICONS.some((icon) => icon.key === value);
}

export function appIconPreviewUrl(key: AppIconKey): string {
  return `/app-icons/${key}.png`;
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
