import { useEffect, useRef, useState } from 'react';

import {
  subscribeConnectorsSettingsLinks,
  takePendingConnectorsProvider,
  type ConnectorsLinkProviderId,
} from './connectorsSettingsLink';

/** A provider a `kordi://settings/connectors` link asked to show. */
export type ConnectorsLinkSelection = {
  providerId: ConnectorsLinkProviderId;
  /** Increases with each link, so the same provider can be shown again. */
  request: number;
};

/**
 * Reads the provider from a Connectors settings link for the account settings
 * dialog. A link that opened the dialog is read when the Connectors tab shows;
 * a link that arrives while the dialog is open switches to that tab.
 */
export function useConnectorsLinkSelection({
  isOpen,
  activeTab,
  showConnectorsTab,
}: {
  isOpen: boolean;
  activeTab: string;
  showConnectorsTab: () => void;
}) {
  const [selection, setSelection] = useState<ConnectorsLinkSelection | null>(null);
  const [wasOpen, setWasOpen] = useState(isOpen);
  const requestRef = useRef(0);
  const showConnectorsTabRef = useRef(showConnectorsTab);
  const isConnectorsTabActive = isOpen && activeTab === 'connectors';

  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (!isOpen) setSelection(null);
  }

  useEffect(() => {
    showConnectorsTabRef.current = showConnectorsTab;
  }, [showConnectorsTab]);

  useEffect(() => {
    const select = () => {
      const providerId = takePendingConnectorsProvider();
      if (!providerId) return;
      requestRef.current += 1;
      setSelection({ providerId, request: requestRef.current });
    };
    if (!isOpen) return undefined;
    let active = true;
    if (isConnectorsTabActive) queueMicrotask(() => { if (active) select(); });
    const unsubscribe = subscribeConnectorsSettingsLinks(() => {
      showConnectorsTabRef.current();
      select();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [isConnectorsTabActive, isOpen]);

  return { selection, clearSelection: () => setSelection(null) };
}
