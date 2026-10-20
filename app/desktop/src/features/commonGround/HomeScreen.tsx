import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Hash, Link2 } from 'lucide-react';

import type { CgHost } from './host';
import { CgAvatar, CgButton, CgGroup, CgHero, CgNotice, CgRow, CgScore, CgSection, CgTag } from './parts';
import type { CgState, CommonGroundStore } from './store';
import { CG_TOPIC_SECTIONS } from './types';

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function expiryLine(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  if (!left) return 'Expired';
  return `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

export function RoomDigits({ busy, onJoin }: { busy: boolean; onJoin: (code: string) => Promise<boolean> }) {
  const [digits, setDigits] = useState(['', '', '', '']);
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const code = digits.join('');
  const submit = async () => {
    if (code.length !== 4 || busy) return;
    if (!(await onJoin(code))) {
      setDigits(['', '', '', '']);
      refs.current[0]?.focus();
    }
  };
  return (
    <form className="cg-digits-row" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <span className="cg-icon" aria-hidden="true"><Hash className="h-4 w-4" /></span>
      <span className="cg-row-text">
        <span className="cg-row-title">Room code</span>
        <span className="cg-digits">
          {digits.map((digit, index) => (
            <input
              key={index}
              ref={(element) => { refs.current[index] = element; }}
              value={digit}
              inputMode="numeric"
              autoComplete="off"
              maxLength={1}
              aria-label={`Digit ${index + 1}`}
              onChange={(event) => {
                const value = event.target.value.replace(/\D/g, '').slice(-1);
                setDigits((current) => current.map((item, i) => (i === index ? value : item)));
                if (value) refs.current[index + 1]?.focus();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Backspace' && !digit) refs.current[index - 1]?.focus();
              }}
            />
          ))}
        </span>
      </span>
      <CgButton type="submit" disabled={code.length !== 4 || busy}>Join</CgButton>
    </form>
  );
}

function PairSection({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const [theirs, setTheirs] = useState('');
  const now = useNow(Boolean(state.pairCode));
  if (!state.owner?.sharing) {
    return (
      <CgGroup>
        <CgRow title="Sharing is off" trailing={<CgButton onClick={() => void store.setSharing(true)}>Turn on</CgButton>} />
      </CgGroup>
    );
  }
  const code = state.pairCode;
  return (
    <CgGroup>
      <CgRow
        lead={<span className="cg-icon" aria-hidden="true"><Link2 className="h-4 w-4" /></span>}
        title={code ? <span className="cg-code">{code.code}</span> : 'Your code'}
        sub={code ? expiryLine(code.expiresAt, now) : undefined}
        trailing={<CgButton quiet onClick={() => void store.newPairCode()}>New code</CgButton>}
      />
      <form
        className="cg-row"
        onSubmit={(event) => {
          event.preventDefault();
          void store.redeem(theirs).then((ok) => { if (ok) setTheirs(''); });
        }}
      >
        <input
          className="cg-input"
          value={theirs}
          onChange={(event) => setTheirs(event.target.value.toUpperCase())}
          placeholder="Their code"
          aria-label="Their code"
          maxLength={12}
          autoComplete="off"
        />
        <CgButton type="submit" disabled={theirs.replace(/[^A-Za-z0-9]/g, '').length !== 8 || state.busy === 'redeem'}>Pair</CgButton>
      </form>
    </CgGroup>
  );
}

export function HomeScreen({ state, store, host }: { state: CgState; store: CommonGroundStore; host: CgHost }) {
  const card = state.owner?.card;
  if (!card) return null;
  const topics = CG_TOPIC_SECTIONS.flatMap(([key]) => card[key]).filter((topic) => !card.hidden.includes(topic));
  return (
    <>
      <CgHero avatar={<CgAvatar person={host.self} size={72} isSelf />} title="Common ground" line="Find what you share" />
      <CgSection>
        <CgGroup>
          <button type="button" className="cg-card-summary" onClick={() => store.open({ name: 'card' })}>
            <span className="cg-card-summary-head">
              <span>Your card</span>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="cg-tags is-flat">
              {topics.slice(0, 6).map((topic) => <CgTag key={topic} topic={topic} small />)}
            </span>
          </button>
        </CgGroup>
      </CgSection>
      <CgSection title="Pair">
        <PairSection state={state} store={store} />
      </CgSection>
      <CgSection title="Room">
        <CgGroup>
          <RoomDigits busy={state.busy === 'join'} onJoin={(code) => store.joinRoom(code)} />
        </CgGroup>
      </CgSection>
      <CgNotice text={state.notice} />
      {state.recent.length ? (
        <CgSection title="Recent">
          <CgGroup>
            {state.recent.map((entry) => (
              <CgRow
                key={entry.person.accountId}
                lead={<CgAvatar person={entry.person} size={36} />}
                title={entry.person.name}
                sub={entry.headline ?? undefined}
                trailing={<CgScore score={entry.score} />}
                onClick={() => store.open({ name: 'match', accountId: entry.person.accountId })}
              />
            ))}
          </CgGroup>
        </CgSection>
      ) : null}
    </>
  );
}
