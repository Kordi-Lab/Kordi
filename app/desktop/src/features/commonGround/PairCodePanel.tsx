import { useCallback, useRef, useState } from 'react';
import { ChevronRight, Hash } from 'lucide-react';

import { profileDesign } from './cardDesign';
import { CreateCodePopover, type CgShareChoice } from './CreateCodePopover';
import { PairPopover } from './PairPopover';
import { roomTitle } from './format';
import { CardSwatch } from './ProfileCard';
import { kindLabel, shareableProfiles } from './profiles';
import { currentProfile, type CgState, type CommonGroundStore } from './store';
import type { CgCodeLookup } from './storeRooms';
import type { CgRoomPreview } from './types';
import { latestOnly, roomPreviewLine, suggestedProfile } from './wallet';

/** Four digit boxes; the fourth digit hands the code on. */
function Digits({ disabled, missing, onCode }: { disabled: boolean; missing: boolean; onCode: (code: string | null) => void }) {
  const [digits, setDigits] = useState(['', '', '', '']);
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const reset = useCallback(() => {
    setDigits(['', '', '', '']);
    refs.current[0]?.focus();
  }, []);
  return (
    <span className={missing ? 'cg-digits is-missing' : 'cg-digits'} role="group" aria-label={missing ? 'Pair code, room not found' : 'Pair code'}>
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(element) => { refs.current[index] = element; }}
          value={digit}
          inputMode="numeric"
          autoComplete="off"
          maxLength={1}
          disabled={disabled}
          aria-label={`Digit ${index + 1}`}
          onChange={(event) => {
            const value = event.target.value.replace(/\D/g, '').slice(-1);
            const next = digits.map((item, i) => (i === index ? value : item));
            setDigits(next);
            if (value) refs.current[index + 1]?.focus();
            const code = next.join('');
            onCode(code.length === 4 ? code : null);
            if (code.length === 4) refs.current[index]?.blur();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && !digit) refs.current[index - 1]?.focus();
            if (event.key === 'Escape') reset();
          }}
        />
      ))}
    </span>
  );
}

/** Two phones side by side, for Pair. */
function TwoPhones() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.8" y="2" width="5" height="11" rx="1.3" />
      <rect x="9.2" y="3" width="5" height="11" rx="1.3" />
      <path d="M3.8 11h1M11.2 12h1" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Pair, one to one: opens your code and a field for theirs, sharing the selected card. A card
 * without topics yet opens Build first.
 */
function PairRow({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const canShare = state.profilesOn ? Boolean(currentProfile(state)?.hasCard) : Boolean(state.owner?.card);
  return (
    <>
      <button
        type="button"
        className="cg-pair-row cg-pair-open"
        data-cg-pair="true"
        aria-expanded={open}
        onClick={() => (canShare ? setOpen((value) => !value) : store.open({ name: 'build' }))}
      >
        <span className="cg-pair-icon" aria-hidden="true"><TwoPhones /></span>
        <span className="cg-pair-title">Pair</span>
        <ChevronRight className="cg-mrow-chev" aria-hidden="true" />
      </button>
      {open ? <PairPopover store={store} onClose={close} /> : null}
    </>
  );
}

/**
 * The Pair code row: four digits look up a room and show it under the boxes with Join, which
 * shares the selected card; a "Suggested" chip joins with the card the room suggests, without
 * changing the selected one. A room you are in opens. Create opens a meetup on a new code.
 */
export function PairCodePanel({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const [lookup, setLookup] = useState<CgCodeLookup | null>(null);
  const [digitsKey, setDigitsKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [requests] = useState(latestOnly);
  const closeCreate = useCallback(() => setCreating(false), []);
  const profile = currentProfile(state);
  const canShare = state.profilesOn ? Boolean(profile?.hasCard) : Boolean(state.owner?.card);
  const shareable = shareableProfiles(state.profiles);
  const canCreate = state.profilesOn ? shareable.length > 0 : Boolean(state.owner?.card);
  const busy = joining || state.busy === 'join';
  const clear = () => { requests.cancel(); setLookup(null); setDigitsKey((key) => key + 1); };

  const onCode = (code: string | null) => {
    // Only the newest code may show a preview or open a room.
    const isLatest = requests.next();
    if (!code) { setLookup(null); return; }
    void store.lookUpCode(code).then((found) => {
      if (!isLatest()) return;
      if (found.status === 'joined') { clear(); store.openRoom(found.code); return; }
      if (found.status === 'missing') setDigitsKey((key) => key + 1);
      setLookup(found);
    });
  };

  const join = async (room: CgRoomPreview, profileId: string | null) => {
    const sharing = state.profiles.find((item) => item.profileId === profileId);
    setJoining(true);
    try {
      const ok = await store.joinRoom(room.code, sharing ? { profileId: sharing.profileId, kind: sharing.kind } : {});
      if (ok) clear();
    } finally {
      setJoining(false);
    }
  };

  const preview = lookup?.status === 'preview' ? lookup.room : null;
  const suggestion = preview ? suggestedProfile(state.profiles, preview.kind, state.profileId, preview.suggestedProfileId) : null;
  // A code with no room turns the boxes red instead of adding a line.
  const missing = lookup?.status === 'missing';
  const error = lookup?.status === 'error' ? lookup.message : null;
  return (
    <div className="cg-panel cg-paircode">
      <PairRow state={state} store={store} />
      <div className="cg-pair-row is-code">
        <span className="cg-pair-icon" aria-hidden="true"><Hash className="h-[15px] w-[15px]" /></span>
        <span className="cg-pair-title">Pair code</span>
        <Digits key={digitsKey} disabled={!canCreate || busy} missing={missing} onCode={onCode} />
        <button
          type="button"
          className="cg-mbtn"
          data-cg-create="true"
          disabled={!canCreate}
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          Create
        </button>
      </div>
      {error ? <div className="cg-pair-error" role="alert">{error}</div> : null}
      {preview ? (
        <div className="cg-pair-confirm">
          <span className="cg-pair-confirm-text">
            <span className="cg-pair-confirm-title">{roomTitle(preview.code, preview.name)}</span>
            {roomPreviewLine(preview, kindLabel) ? <span className="cg-pair-confirm-sub">{roomPreviewLine(preview, kindLabel)}</span> : null}
          </span>
          {suggestion ? (
            <button
              type="button"
              className="cg-sugchip"
              title={`Share ${suggestion.name} and join`}
              disabled={busy}
              onClick={() => void join(preview, suggestion.profileId)}
            >
              <CardSwatch design={profileDesign(suggestion)} className="is-chip" />
              Suggested: {suggestion.name}
            </button>
          ) : null}
          <button type="button" className="cg-mbtn is-tint" disabled={busy || !canShare} onClick={() => void join(preview, state.profileId)}>
            {profile ? <CardSwatch design={profileDesign(profile)} className="is-join" /> : null}
            Join
          </button>
        </div>
      ) : null}
      {creating ? (
        <CreateCodePopover
          cards={(state.profilesOn ? shareable : []).map((item): CgShareChoice => ({ id: item.profileId, name: item.name, design: profileDesign(item), icon: item.icon, kind: item.kind }))
            .concat(state.profilesOn ? [] : [{ id: 'card', name: 'Your card', design: 'work' }])}
          current={state.profileId ?? 'card'}
          busy={state.busy === 'create'}
          notice={state.notice}
          onClose={closeCreate}
          onEnter={(code) => { closeCreate(); store.openRoom(code); }}
          onCreate={(name, cardId) => {
            const chosen = state.profiles.find((item) => item.profileId === cardId);
            return store.createRoom({ name, kind: chosen?.kind ?? 'work', profileId: chosen?.profileId });
          }}
        />
      ) : null}
    </div>
  );
}
