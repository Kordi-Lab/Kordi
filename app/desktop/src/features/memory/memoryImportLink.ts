import { useEffect } from 'react';

// The Memory tab's Import opens account settings on Memory and scrolls to its
// Import section, through a window event the app shell listens for.

export const MEMORY_IMPORT_SETTINGS_EVENT = 'kordi:open-memory-import';
export const MEMORY_IMPORT_SECTION_ID = 'memory-import';

let pendingFocus = false;

/** Asks the app shell to open Settings › Memory at Import. */
export function openMemoryImportSettings() {
  pendingFocus = true;
  window.dispatchEvent(new window.CustomEvent(MEMORY_IMPORT_SETTINGS_EVENT));
}

/** Whether the Import section should scroll into view, once per request. */
export function takeMemoryImportFocus(): boolean {
  const pending = pendingFocus;
  pendingFocus = false;
  return pending;
}

/** Opens account settings on Memory when the Memory tab's Import asks for it. */
export function useMemoryImportSettingsLink(openDialogTab: (tab: 'memory') => void) {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onOpen = () => openDialogTab('memory');
    window.addEventListener(MEMORY_IMPORT_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(MEMORY_IMPORT_SETTINGS_EVENT, onOpen);
  }, [openDialogTab]);
}
