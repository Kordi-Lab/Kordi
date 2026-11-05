import { useEffect } from 'react';

import { USAGE_SETTINGS_LINK_EVENT } from '@/features/cloud/usageLimitNotice';

/** Opens account settings on the Usage tab when a chat line asks for it. */
export function useUsageSettingsLink(openDialogTab: (tab: 'usage') => void) {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onLink = () => openDialogTab('usage');
    window.addEventListener(USAGE_SETTINGS_LINK_EVENT, onLink);
    return () => window.removeEventListener(USAGE_SETTINGS_LINK_EVENT, onLink);
  }, [openDialogTab]);
}
