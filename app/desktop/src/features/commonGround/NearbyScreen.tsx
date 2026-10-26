import { useState, type ReactNode } from 'react';
import { ChevronDown, MapPin, MoreHorizontal } from 'lucide-react';

import { profileDesign } from './cardDesign';
import type { CgHost } from './host';
import { NearbyDeviceLocation } from './NearbyDeviceLocation';
import { NearbyConsentDialog, NearbyRequestDialog } from './NearbyDialogs';
import { NbMenuButton } from './NearbyMenu';
import { NearbyAlerts, NearbyNeeds, NearbyOpenTo, NearbyPeople } from './NearbySections';
import { checkItems, locationLine, nearbyCards, NO_PHONE_LINE, pausedLine, pauseUntil, type CgNearbyPhase } from './nearbyFormat';
import { needInput, needPatch } from './nearbyRequest';
import { CgNotice } from './parts';
import { CardSwatch } from './ProfileCard';
import type { CgState, CommonGroundStore } from './store';
import type { CgNearbyState, CgNearbyStore } from './storeNearby';
import type { CgNeed } from './typesNearby';
import { useNearby } from './useNearby';
import { WalletShell } from './WalletShell';

/** "Sharing: Work" for the card Nearby shares; it opens the cards that can be shared. */
function NearbyChip({ state, nb, nearby }: { state: CgState; nb: CgNearbyState; nearby: CgNearbyStore }) {
  const profile = state.profiles.find((item) => item.profileId === nb.settings?.profileId);
  if (!profile) return null;
  const cards = nearbyCards(state.profiles);
  const choices = (cards.some((card) => card.profileId === profile.profileId) ? cards : [profile, ...cards]).map((card): [string, string] => [card.profileId, card.name]);
  return (
    <NbMenuButton id="card" label="Card" className="cg-share-chip is-menu" align="right" items={checkItems(choices, profile.profileId, (id) => void nearby.setProfile(id))}>
      <CardSwatch design={profileDesign(profile)} className="is-chip" />
      <span>Sharing: <b>{profile.name}</b></span>
      <ChevronDown className="cg-nb-caret" aria-hidden="true" />
    </NbMenuButton>
  );
}

function MoreMenu({ nearby }: { nearby: CgNearbyStore }) {
  return (
    <NbMenuButton
      id="more"
      label="More"
      iconOnly
      className="cg-nb-iconbtn"
      align="right"
      items={[
        { key: 'hour', label: 'Pause for 1 hour', onSelect: () => void nearby.pause(pauseUntil('hour')) },
        { key: 'tomorrow', label: 'Pause until tomorrow', onSelect: () => void nearby.pause(pauseUntil('tomorrow')) },
        { key: 'off', label: 'Turn off', danger: true, separated: true, onSelect: () => void nearby.turnOff() },
      ]}
    >
      <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
    </NbMenuButton>
  );
}

function StatusLine({ phase, nb, nearby }: { phase: CgNearbyPhase; nb: CgNearbyState; nearby: CgNearbyStore }) {
  if (phase === 'paused' && nb.settings?.pausedUntil) {
    return (
      <div className="cg-nb-status">
        {pausedLine(nb.settings.pausedUntil)}
        <button type="button" className="cg-link cg-nb-resume" onClick={() => void nearby.pause(null)}>Resume</button>
      </div>
    );
  }
  if (phase === 'no-phone') return <div className="cg-nb-status">{NO_PHONE_LINE}</div>;
  const location = nb.results?.location ?? nb.settings?.location;
  return location ? <div className="cg-nb-status">{locationLine(location)}</div> : null;
}

function NearbyOff({ busy, onTurnOn }: { busy: boolean; onTurnOn: () => void }) {
  return (
    <div className="cg-nb-off">
      <span className="cg-nb-mark" aria-hidden="true"><MapPin /></span>
      <h2>Nearby</h2>
      <p>See people near you who share a card.</p>
      <button type="button" className="cg-mbtn is-primary" disabled={busy} onClick={onTurnOn}>Turn on</button>
    </div>
  );
}

/**
 * Grounding › Nearby: people around the account's latest device location, requests, and alerts.
 */
export function NearbyScreen({ state, store, host }: { state: CgState; store: CommonGroundStore; host: CgHost }) {
  const [nb, nearby] = useNearby(store, { poll: true, needs: true });
  const [consent, setConsent] = useState<{ failed: boolean } | null>(null);
  const [editing, setEditing] = useState<{ need: CgNeed | null; failed: boolean } | null>(null);
  const phase = nearby.phase();
  const off = phase === 'off';
  const settings = nb.settings;
  const shell = (body: ReactNode, on: boolean) => (
    <WalletShell
      state={state}
      store={store}
      owner={host.self}
      title="Nearby"
      onBack={() => store.back()}
      chip={on ? <NearbyChip state={state} nb={nb} nearby={nearby} /> : undefined}
      actions={on ? <MoreMenu nearby={nearby} /> : null}
      center={!on}
    >
      {body}
    </WalletShell>
  );

  if (!nb.loaded) return shell(null, false);
  if (!settings) return shell(<CgNotice text={nb.notice ?? 'Could not open Nearby.'} />, false);
  const turnOn = async (profileId: string, background: boolean) => {
    const ok = await nearby.turnOn(profileId, background);
    setConsent(ok ? null : { failed: true });
  };
  const consentDialog = consent ? (
    <NearbyConsentDialog
      profiles={state.profiles}
      initialProfileId={settings.profileId ?? state.profileId}
      busy={nb.busy === 'enable'}
      notice={consent.failed ? nb.notice : null}
      onCancel={() => setConsent(null)}
      onTurnOn={(profileId, background) => void turnOn(profileId, background)}
    />
  ) : null;
  if (off) {
    return shell(
      <>
        <NearbyOff busy={nb.busy === 'enable'} onTurnOn={() => setConsent({ failed: false })} />
        {consent ? null : <CgNotice text={nb.notice} />}
        {consentDialog}
      </>,
      false,
    );
  }

  const finish = (ok: boolean) => setEditing((current) => (ok ? null : current && { ...current, failed: true }));
  const need = editing?.need ?? null;
  return shell(
    <div className="cg-nb">
      <StatusLine phase={phase} nb={nb} nearby={nearby} />
      {phase !== 'paused' ? <NearbyDeviceLocation nearby={nearby} /> : null}
      {editing ? null : <CgNotice text={nb.notice} />}
      <h2 className="cg-msec">Meet for</h2>
      <p className="cg-nb-activity-help">Choose activities you’d like to do with people you meet. Saved for this card.</p>
      <NearbyOpenTo key={settings.profileId} settings={settings} nearby={nearby} profile={state.profiles.find((profile) => profile.profileId === settings.profileId)} busy={nb.busy !== null} />
      <NearbyPeople settings={settings} results={nb.results} nearby={nearby} unavailable={phase === 'no-phone' ? 'location' : phase === 'paused' ? 'paused' : undefined} notice={nb.notice} onOpen={(accountId) => store.open({ name: 'nearbyPerson', accountId })} />
      <h2 className="cg-msec">Looking for</h2>
      <NearbyNeeds needs={nb.needs} onOpen={(item) => setEditing({ need: item, failed: false })} />
      <h2 className="cg-msec">Alerts</h2>
      <NearbyAlerts settings={settings} nearby={nearby} />
      {editing ? (
        <NearbyRequestDialog
          need={need}
          busy={nb.busy === 'need'}
          notice={editing.failed ? nb.notice : null}
          onCancel={() => setEditing(null)}
          onSave={(draft, initial) => void (need ? nearby.updateNeed(need.needId, needPatch(draft, initial)) : nearby.createNeed(needInput(draft))).then(finish)}
          onDelete={() => { if (need) void nearby.deleteNeed(need.needId).then(finish); }}
        />
      ) : null}
    </div>,
    true,
  );
}
