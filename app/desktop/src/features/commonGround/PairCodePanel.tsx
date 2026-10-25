import { useCallback, useRef, useState } from 'react';
import { ChevronRight, Hash } from 'lucide-react';

import { profileDesign } from './cardDesign';
import { CreateCodePopover, type CgShareChoice } from './CreateCodePopover';
import { PairPopover } from './PairPopover';
import { shareableProfiles } from './profiles';
import { currentProfile, type CgState, type CommonGroundStore } from './store';
import type { CgCodeLookup } from './storeRooms';
import type { CgRoomPreview } from './types';
import { latestOnly, suggestedProfile } from './wallet';

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
 * The Pair code row: Create opens a meetup on a new code; four typed digits turn it into Enter
 * pair room, which opens a room you are in, or joins the room and opens it, sharing the card the
 * room suggests, else the selected one. A code with no room turns the boxes red.
 */
export function PairCodePanel({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const [code, setCode] = useState<string | null>(null);
  const [lookup, setLookup] = useState<CgCodeLookup | null>(null);
  const [digitsKey, setDigitsKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [entering, setEntering] = useState(false);
  const [requests] = useState(latestOnly);
  const closeCreate = useCallback(() => setCreating(false), []);
  const shareable = shareableProfiles(state.profiles);
  const canCreate = state.profilesOn ? shareable.length > 0 : Boolean(state.owner?.card);
  const busy = entering || state.busy === 'join';
  const clear = () => { requests.cancel(); setCode(null); setLookup(null); setDigitsKey((key) => key + 1); };

  const onCode = (typed: string | null) => {
    requests.cancel();
    setCode(typed);
    setLookup(null);
    if (typed) setCreating(false);
  };

  const join = async (room: CgRoomPreview) => {
    const suggestion = suggestedProfile(state.profiles, room.kind, state.profileId, room.suggestedProfileId);
    const sharing = suggestion ?? state.profiles.find((item) => item.profileId === state.profileId);
    // joinRoom opens the room page on success.
    if (await store.joinRoom(room.code, sharing ? { profileId: sharing.profileId, kind: sharing.kind } : {})) clear();
  };

  const enter = async () => {
    if (!code) return;
    // Only the newest code may open a room.
    const isLatest = requests.next();
    setEntering(true);
    try {
      const found = await store.lookUpCode(code);
      if (!isLatest()) return;
      if (found.status === 'joined') { clear(); store.openRoom(found.code); return; }
      if (found.status === 'preview') { await join(found.room); return; }
      if (found.status === 'missing') { setCode(null); setDigitsKey((key) => key + 1); }
      setLookup(found);
    } finally {
      setEntering(false);
    }
  };

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
        {code ? (
          <button type="button" className="cg-mbtn is-primary" data-cg-enter="true" disabled={busy} onClick={() => void enter()}>
            Enter pair room
          </button>
        ) : (
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
        )}
      </div>
      {error ? <div className="cg-pair-error" role="alert">{error}</div> : null}
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
