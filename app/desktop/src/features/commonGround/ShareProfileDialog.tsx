import { useId, useState } from 'react';
import { Check } from 'lucide-react';

import { AppDialog, AppDialogActions, AppDialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { topicCount } from './format';
import { CgButton, CgNotice } from './parts';
import { profileDesign } from './cardDesign';
import { CardSwatch } from './ProfileCard';
import { sharePreselect, shareableProfiles } from './profiles';
import { roomClosed, type CgState, type CommonGroundStore } from './store';
import type { CgProfile } from './types';

/** "Share which profile?": the profiles with a card, to share another one in a room. */
export function ShareProfileDialog({ profiles, selected, busy, notice, onCancel, onShare }: {
  profiles: CgProfile[];
  selected: string | null;
  busy: boolean;
  notice: string | null;
  onCancel: () => void;
  onShare: (profileId: string) => void;
}) {
  const titleId = useId();
  const shareable = shareableProfiles(profiles);
  const [profileId, setProfileId] = useState(selected ?? shareable[0]?.profileId ?? '');
  const chosen = shareable.find((profile) => profile.profileId === profileId);
  return (
    <AppDialog titleId={titleId} onDismiss={onCancel} busy={busy} dismissDisabled={busy} className="cg-dialog">
      <AppDialogTitle id={titleId}>Share which profile?</AppDialogTitle>
      <form className="cg-form" onSubmit={(event) => { event.preventDefault(); if (chosen) onShare(chosen.profileId); }}>
        <div className="cg-pick-list" role="radiogroup" aria-label="Profiles">
          {shareable.map((profile) => {
            const on = profile.profileId === profileId;
            return (
              <button key={profile.profileId} type="button" role="radio" aria-checked={on} className={cn('cg-pick', on && 'is-on')} onClick={() => setProfileId(profile.profileId)}>
                <CardSwatch design={profileDesign(profile)} />
                <span className="cg-row-text">
                  <span className="cg-row-title">{profile.name}</span>
                  <span className="cg-row-sub">{profile.focus || topicCount(profile.topicCount)}</span>
                </span>
                <span className="cg-check" aria-hidden="true">{on ? <Check className="h-3.5 w-3.5" /> : null}</span>
              </button>
            );
          })}
        </div>
        <CgNotice text={notice} />
        <AppDialogActions>
          <CgButton quiet onClick={onCancel} disabled={busy}>Cancel</CgButton>
          <CgButton type="submit" disabled={busy || !chosen}>Share</CgButton>
        </AppDialogActions>
      </form>
    </AppDialog>
  );
}

/** "Sharing: Work" under a room's hero, with Change while the room is open. */
export function RoomSharing({ code, state, store }: { code: string; state: CgState; store: CommonGroundStore }) {
  const [changing, setChanging] = useState(false);
  const room = state.rooms[code];
  if (!state.profilesOn || !room?.profileId) return null;
  const shared = state.profiles.find((profile) => profile.profileId === room.profileId);
  if (!shared) return null;
  const canChange = !roomClosed(state, code) && shareableProfiles(state.profiles).length > 1;
  return (
    <div className="cg-sharing">
      <span>Sharing: {shared.name}</span>
      {canChange ? <button type="button" className="cg-link" onClick={() => setChanging(true)}>Change</button> : null}
      {changing ? (
        <ShareProfileDialog
          profiles={state.profiles}
          selected={sharePreselect(state.profiles, { kind: room.kind, current: room.profileId })}
          busy={state.busy === 'switch'}
          notice={state.notice}
          onCancel={() => setChanging(false)}
          onShare={(profileId) => {
            if (profileId === room.profileId) return setChanging(false);
            void store.switchRoomProfile(code, profileId).then((ok) => { if (ok) setChanging(false); });
          }}
        />
      ) : null}
    </div>
  );
}
