import { useEffect } from 'react';

import {
  CONNECTORS_LINK_PROVIDER_IDS,
  CONNECTORS_SETTINGS_LINK_EVENT,
  applyConnectorsSettingsTarget,
  type ConnectorsSettingsTarget,
} from '@/features/connectors/connectorsSettingsLink';

/** Opens account settings on the Connectors tab when a message link asks for it. */
export function useConnectorsSettingsLinks(openDialogTab: (tab: ConnectorsSettingsTarget['tab']) => void) {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onLink = (event: Event) => {
      const detail = (event as CustomEvent<Partial<ConnectorsSettingsTarget> | null>).detail;
      if (detail?.tab !== 'connectors') return;
      const providerId = CONNECTORS_LINK_PROVIDER_IDS.find((id) => id === detail.providerId) ?? null;
      applyConnectorsSettingsTarget({ tab: 'connectors', providerId }, openDialogTab);
    };
    window.addEventListener(CONNECTORS_SETTINGS_LINK_EVENT, onLink);
    return () => window.removeEventListener(CONNECTORS_SETTINGS_LINK_EVENT, onLink);
  }, [openDialogTab]);
}
