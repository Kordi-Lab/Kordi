import { useRef, useState } from 'react';
import { ChevronRight, Hash, Sparkles, Users } from 'lucide-react';

import { peopleCount, roomTitle, topicCount } from './format';
import type { CgHost } from './host';
import { CgAvatar, CgButton, CgGroup, CgHero, CgIcon, CgNotice, CgRow, CgScore, CgSection, CgTag } from './parts';
import { buildTitle, personTitle, sharePreselect } from './profiles';
import { ProfileSwitcher } from './ProfileSwitcher';
import { ShareProfileDialog } from './ShareProfileDialog';
import { currentProfile, hasAnyCard, type CgState, type CommonGroundStore } from './store';
import { CG_TOPIC_SECTIONS, type CgOwnCard } from './types';

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

function CardSummary({ card, store }: { card: CgOwnCard; store: CommonGroundStore }) {
  const topics = CG_TOPIC_SECTIONS.flatMap(([key]) => card[key]).filter((topic) => !card.hidden.includes(topic));
  return (
    <button type="button" className="cg-card-summary" onClick={() => store.open({ name: 'card' })}>
      <span className="cg-card-summary-head">
        <span>Your card</span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="cg-tags is-flat">
        {topics.slice(0, 6).map((topic) => <CgTag key={topic} topic={topic} small />)}
      </span>
    </button>
  );
}

export function HomeScreen({ state, store, host }: { state: CgState; store: CommonGroundStore; host: CgHost }) {
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const card = state.owner?.card;
  if (!card && !hasAnyCard(state)) return null;
  const profile = currentProfile(state);
  const asksProfile = state.profilesOn && state.profiles.length > 1;
  const profileName = (profileId: string | null | undefined) => state.profiles.find((item) => item.profileId === profileId)?.name ?? '';
  return (
    <>
      <CgHero avatar={<CgAvatar person={host.self} size={72} isSelf />} title="Common ground" line="Find what you share" />
      {state.profilesOn && state.profiles.length ? <ProfileSwitcher state={state} store={store} /> : null}
      <CgSection className={state.profilesOn ? 'is-tight' : undefined}>
        <CgGroup>
          {card ? <CardSummary card={card} store={store} /> : (
            <CgRow
              lead={<CgIcon><Sparkles className="h-4 w-4" /></CgIcon>}
              title={buildTitle(profile)}
              sub={profile?.focus || 'Your agent writes it'}
              trailing={<CgButton onClick={() => store.open({ name: 'build' })}>Build</CgButton>}
            />
          )}
        </CgGroup>
      </CgSection>
      <CgSection title="Pair">
        <CgGroup>
          <RoomDigits
            busy={state.busy === 'join'}
            onJoin={async (code) => {
              if (!asksProfile) return store.joinRoom(code);
              setJoinCode(code);
              return true;
            }}
          />
        </CgGroup>
      </CgSection>
      {joinCode ? (
        <ShareProfileDialog
          profiles={state.profiles}
          selected={sharePreselect(state.profiles, { current: state.profileId })}
          joining
          busy={state.busy === 'join'}
          notice={state.notice}
          onCancel={() => setJoinCode(null)}
          onShare={(input) => void store.joinRoom(joinCode, input).then((ok) => { if (ok) setJoinCode(null); })}
        />
      ) : null}
      <CgNotice text={state.notice} />
      {state.support.rooms && state.roomList.length ? (
        <CgSection title="Rooms">
          <CgGroup>
            {state.roomList.map((room) => (
              <CgRow
                key={room.code}
                lead={<span className="cg-icon" aria-hidden="true"><Users className="h-4 w-4" /></span>}
                title={roomTitle(room.code, room.name)}
                sub={[asksProfile ? profileName(room.profileId) : '', peopleCount(room.memberCount), topicCount(room.themeCount), room.open ? '' : 'Closed']
                  .filter(Boolean).join(' · ')}
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
                key={`${entry.person.accountId}:${entry.person.profile?.profileId ?? ''}`}
                lead={<CgAvatar person={entry.person} size={36} />}
                title={personTitle(entry.person)}
                sub={entry.headline ?? undefined}
                trailing={<CgScore score={entry.score} />}
                onClick={() => store.open({ name: 'match', accountId: entry.person.accountId, profileId: entry.profileId })}
              />
            ))}
          </CgGroup>
        </CgSection>
      ) : null}
    </>
  );
}
