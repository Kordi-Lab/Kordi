import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { useEffect, useRef } from 'react';

import { rememberPairLink } from './pairLink';

// The launch link is read once per process; a remount must not redeem it again.
let launchRead = false;

/**
 * Opens Contacts for `kordi://common-ground/pair/<code>` links, from launch or while running.
 * The code waits in `pairLink` until the Grounding page redeems it.
 */
export function useCommonGroundPairLinks(openContacts: () => void) {
  const open = useRef(openContacts);
  useEffect(() => { open.current = openContacts; });

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const receive = (urls: string[] | null | undefined) => {
      if (disposed) return;
      if (urls?.map((url) => rememberPairLink(url)).includes(true)) open.current();
    };
    if (!launchRead) {
      launchRead = true;
      void getCurrent().then(receive).catch(() => undefined);
    }
    void onOpenUrl(receive)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
