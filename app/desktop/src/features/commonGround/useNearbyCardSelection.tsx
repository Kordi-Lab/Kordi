import { useId, useRef, useState } from 'react';

import { AppDialog, AppDialogActions, AppDialogDescription, AppDialogTitle } from '@/components/ui/dialog';
import { CgButton, CgNotice } from './parts';
import type { CgState, CommonGroundStore } from './store';
import type { CgNearbyStore } from './storeNearby';
import type { CgProfile } from './types';

/** The rail and header switch the same Nearby card, with consent before enabling card sharing. */
export function useNearbyCardSelection(state: CgState, store: CommonGroundStore, nearby: CgNearbyStore, off: boolean) {
  const [pending, setPending] = useState<CgProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const working = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  const switchCard = async (profileId: string, share = false) => {
    if (working.current || nearby.getSnapshot().busy) return;
    working.current = true;
    setBusy(true);
    setNotice(null);
    try {
      if (share && !await store.setSharing(true, profileId)) {
        setNotice(store.getSnapshot().notice ?? 'Could not share this card. Try again.');
        return;
      }
      if (await nearby.setProfile(profileId)) {
        setPending(null);
        await store.selectProfile(profileId);
      } else if (share) {
        setNotice('Card sharing is on, but Nearby could not switch cards. Try again.');
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const select = (profileId: string) => {
    if (working.current || nearby.getSnapshot().busy) return;
    const profile = state.profiles.find((item) => item.profileId === profileId);
    if (!profile) return;
    if (off) { void store.selectProfile(profileId); return; }
    if (!profile.hasCard) {
      void store.selectProfile(profileId).then(() => store.open({ name: 'build' }));
    } else if (!profile.sharing) {
      setNotice(null);
      setPending(profile);
    } else {
      void switchCard(profileId);
    }
  };
  const dialog = pending ? (
    <AppDialog titleId={titleId} descriptionId={descriptionId} onDismiss={() => setPending(null)} busy={busy} dismissDisabled={busy} className="cg-dialog cg-nb-dialog">
      <AppDialogTitle id={titleId}>Share {pending.name} nearby?</AppDialogTitle>
      <AppDialogDescription id={descriptionId}>
        This turns on sharing for this card and uses it in Nearby. People nearby will see its shared topics and your rough distance. Your source notes stay private.
      </AppDialogDescription>
      <CgNotice text={notice} />
      <AppDialogActions>
        <CgButton quiet disabled={busy} onClick={() => setPending(null)}>Cancel</CgButton>
        <CgButton disabled={busy} onClick={() => void switchCard(pending.profileId, true)}>Share and switch</CgButton>
      </AppDialogActions>
    </AppDialog>
  ) : null;
  return { select, busy, dialog };
}
