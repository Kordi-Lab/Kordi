import { useRef, useState } from 'react';
import { ChevronRight, Hash, Users } from 'lucide-react';

import { peopleCount, roomTitle, topicCount } from './format';
import type { CgHost } from './host';
import { CgAvatar, CgButton, CgGroup, CgHero, CgNotice, CgRow, CgScore, CgSection, CgTag } from './parts';
import type { CgState, CommonGroundStore } from './store';
import { CG_TOPIC_SECTIONS } from './types';

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
        <span className="cg-row-title">Pair code</span>
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

export function HomeScreen({ state, store, host }: { state: CgState; store: CommonGroundStore; host: CgHost }) {
  const card = state.owner?.card;
  if (!card) return null;
  const topics = CG_TOPIC_SECTIONS.flatMap(([key]) => card[key]).filter((topic) => !card.hidden.includes(topic));
  return (
    <>
      <CgHero avatar={<CgAvatar person={host.self} size={72} isSelf />} title="Grounding" line="Find what you share" />
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
        <CgGroup>
          <RoomDigits busy={state.busy === 'join'} onJoin={(code) => store.joinRoom(code)} />
        </CgGroup>
      </CgSection>
      <CgNotice text={state.notice} />
      {state.support.rooms && state.roomList.length ? (
        <CgSection title="Rooms">
          <CgGroup>
            {state.roomList.map((room) => (
              <CgRow
                key={room.code}
                lead={<span className="cg-icon" aria-hidden="true"><Users className="h-4 w-4" /></span>}
                title={roomTitle(room.code, room.name)}
                sub={[peopleCount(room.memberCount), topicCount(room.themeCount), room.open ? '' : 'Closed'].filter(Boolean).join(' · ')}
                onClick={() => store.openRoom(room.code)}
              />
            ))}
          </CgGroup>
        </CgSection>
      ) : null}
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
