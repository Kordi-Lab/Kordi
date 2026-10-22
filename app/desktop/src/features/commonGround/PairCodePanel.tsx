import { useCallback, useRef, useState } from 'react';
import { Hash } from 'lucide-react';

import { profileDesign } from './cardDesign';
import { CreateCodePopover } from './CreateCodePopover';
import { roomTitle } from './format';
import { CardSwatch } from './ProfileCard';
import { kindLabel, shareableProfiles } from './profiles';
import { currentProfile, type CgState, type CommonGroundStore } from './store';
import type { CgCodeLookup } from './storeRooms';
import type { CgRoomPreview } from './types';
import { roomPreviewLine, suggestedProfile } from './wallet';

/** How long the "Sharing" chip takes to crossfade before a suggested join. */
export const SWITCH_CROSSFADE_MS = 260;

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Four digit boxes; the fourth digit hands the code on. */
function Digits({ disabled, onCode }: { disabled: boolean; onCode: (code: string | null) => void }) {
  const [digits, setDigits] = useState(['', '', '', '']);
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const reset = useCallback(() => {
    setDigits(['', '', '', '']);
    refs.current[0]?.focus();
  }, []);
  return (
    <span className="cg-digits" role="group" aria-label="Pair code">
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

/**
 * The Pair code row: four digits look up a room and show it under the boxes with Join, which
 * shares the selected card; a "Suggested" chip switches to the room's kind first. Create opens
 * a meetup on a new code.
 */
export function PairCodePanel({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const [lookup, setLookup] = useState<CgCodeLookup | null>(null);
  const [digitsKey, setDigitsKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const closeCreate = useCallback(() => setCreating(false), []);
  const profile = currentProfile(state);
  const canShare = state.profilesOn ? Boolean(profile?.hasCard) : Boolean(state.owner?.card);
  const busy = joining || state.busy === 'join';
  const clear = () => { setLookup(null); setDigitsKey((key) => key + 1); };

  const onCode = (code: string | null) => {
    if (!code) { setLookup(null); return; }
    void store.lookUpCode(code).then((found) => {
      if (found.status === 'joined') { clear(); store.openRoom(found.code); return; }
      if (found.status === 'missing') setDigitsKey((key) => key + 1);
      setLookup(found);
    });
  };

  const join = async (room: CgRoomPreview, profileId: string | null) => {
    setJoining(true);
    try {
      const sharing = state.profiles.find((item) => item.profileId === profileId);
      if (profileId && profileId !== state.profileId) {
        await store.selectProfile(profileId);
        if (!prefersReducedMotion()) await wait(SWITCH_CROSSFADE_MS);
      }
      const ok = await store.joinRoom(room.code, sharing ? { profileId: sharing.profileId, kind: sharing.kind } : {});
      if (ok) setLookup(null);
    } finally {
      setJoining(false);
    }
  };

  const preview = lookup?.status === 'preview' ? lookup.room : null;
  const suggestion = preview ? suggestedProfile(state.profiles, preview.kind, state.profileId) : null;
  const error = lookup?.status === 'missing' ? 'Room not found' : lookup?.status === 'error' ? lookup.message : null;
  const shareable = shareableProfiles(state.profiles);
  return (
    <div className="cg-panel cg-paircode">
      <div className="cg-pair-row">
        <span className="cg-pair-icon" aria-hidden="true"><Hash className="h-[15px] w-[15px]" /></span>
        <span className="cg-pair-title">Pair code</span>
        <Digits key={digitsKey} disabled={!canShare || busy} onCode={onCode} />
        <button
          type="button"
          className="cg-mbtn"
          data-cg-create="true"
          disabled={!canShare || (state.profilesOn && !shareable.length)}
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
          <button type="button" className="cg-mbtn is-tint" disabled={busy} onClick={() => void join(preview, state.profileId)}>
            {profile ? <CardSwatch design={profileDesign(profile)} className="is-join" /> : null}
            Join
          </button>
        </div>
      ) : null}
      {creating ? (
        <CreateCodePopover
          cards={(state.profilesOn ? shareable : []).map((item) => ({ id: item.profileId, name: item.name, design: profileDesign(item) }))
            .concat(state.profilesOn ? [] : [{ id: 'card', name: 'Your card', design: 'work' }])}
          current={state.profileId ?? 'card'}
          busy={state.busy === 'create'}
          notice={state.notice}
          onClose={closeCreate}
          onCreate={(name, cardId) => {
            const chosen = state.profiles.find((item) => item.profileId === cardId);
            return store.createRoom({ name, kind: chosen?.kind ?? 'work', profileId: chosen?.profileId });
          }}
        />
      ) : null}
    </div>
  );
}
