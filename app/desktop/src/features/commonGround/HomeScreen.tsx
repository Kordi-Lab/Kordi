import { ChevronRight } from 'lucide-react';

import { profileDesign, type CgCardDesign } from './cardDesign';
import { peopleCount, roomTitle, topicCount } from './format';
import type { CgHost } from './host';
import { PairCodePanel } from './PairCodePanel';
import { UnbuiltCardRow } from './UnbuiltCardRow';
import { CgAvatar, CgNotice, CgScore, CgTag } from './parts';
import { CardGlyph, CardSwatch } from './ProfileCard';
import { personTitle } from './profiles';
import { currentProfile, hasAnyCard, type CgState, type CommonGroundStore } from './store';
import { CG_TOPIC_SECTIONS, type CgRoomSummary } from './types';

/** The first run: one suggested card, or the current profile, with Build. */
export function EmptyWallet({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const profile = currentProfile(state);
  const design: CgCardDesign = profile ? profileDesign(profile) : 'work';
  return (
    <div className="cg-empty">
      <span className="cg-empty-card" data-design={design}>
        <span className="cg-card-glyph"><CardGlyph design={design} icon={profile?.icon} kind={profile?.kind} /></span>
      </span>
      <h2>{profile?.name ?? 'Work'}</h2>
      {profile?.focus ? <p>{profile.focus}</p> : null}
      <button type="button" className="cg-mbtn is-primary" onClick={() => store.open({ name: 'build' })}>Build</button>
      <CgNotice text={state.notice} />
    </div>
  );
}

function RoomRow({ room, state, store }: { room: CgRoomSummary; state: CgState; store: CommonGroundStore }) {
  const shared = state.profiles.find((profile) => profile.profileId === room.profileId);
  const sub = [shared ? `Sharing ${shared.name}` : '', peopleCount(room.memberCount), room.themeCount ? topicCount(room.themeCount) : '', room.open ? '' : 'Closed'];
  return (
    <button type="button" className={room.open ? 'cg-mrow' : 'cg-mrow is-closed'} onClick={() => store.openRoom(room.code)}>
      {shared ? <CardSwatch design={profileDesign(shared)} /> : <CardSwatch design={room.kind === 'custom' || !room.kind ? 'custom' : room.kind} empty />}
      <span className="cg-mrow-text">
        <span className="cg-mrow-title">{roomTitle(room.code, room.name)}</span>
        <span className="cg-mrow-sub">{sub.filter(Boolean).join(' · ')}</span>
      </span>
      {room.open ? <ChevronRight className="cg-mrow-chev" aria-hidden="true" /> : null}
    </button>
  );
}

/** Your card: the swatch, the name and its topics; the chevron opens the card page, or Build when it has none. */
function YourCard({ state, store }: { state: CgState; store: CommonGroundStore }) {
  const card = state.owner?.card;
  const profile = currentProfile(state);
  const design: CgCardDesign = profile ? profileDesign(profile) : 'work';
  const name = profile?.name ?? 'Your card';
  if (!card) return <UnbuiltCardRow state={state} store={store} />;
  const topics = CG_TOPIC_SECTIONS.flatMap(([key]) => card[key]);
  return (
    <div className="cg-panel cg-yours">
      <button type="button" className="cg-mrow" aria-label={`Open ${name}`} onClick={() => store.open({ name: 'card' })}>
        <CardSwatch design={design} />
        <span className="cg-mrow-text"><span className="cg-mrow-title">{name}</span></span>
        <ChevronRight className="cg-mrow-chev" aria-hidden="true" />
      </button>
      <div className="cg-yours-tags">
        {topics.map((topic) => <CgTag key={topic} topic={topic} muted={card.hidden.includes(topic)} small />)}
      </div>
    </div>
  );
}

export function HomeScreen({ state, store, host }: { state: CgState; store: CommonGroundStore; host?: CgHost }) {
  if (!hasAnyCard(state)) return <EmptyWallet state={state} store={store} />;
  return (
    <div className="cg-home">
      <h2 className="cg-msec">Your card</h2>
      <YourCard state={state} store={store} />
      <PairCodePanel state={state} store={store} nearby={Boolean(host?.nearby && state.profilesOn)} />
      <CgNotice text={state.notice} />
      {state.support.rooms && state.roomList.length ? (
        <>
          <h2 className="cg-msec">Rooms</h2>
          <div className="cg-panel">
            {state.roomList.map((room) => <RoomRow key={room.code} room={room} state={state} store={store} />)}
          </div>
        </>
      ) : null}
      {state.recent.length ? (
        <>
          <h2 className="cg-msec">Recent</h2>
          <div className="cg-panel">
            {state.recent.map((entry) => (
              <button
                key={`${entry.person.accountId}:${entry.person.profile?.profileId ?? ''}`}
                type="button"
                className="cg-mrow"
                onClick={() => store.open({ name: 'match', accountId: entry.person.accountId, profileId: entry.profileId })}
              >
                <CgAvatar person={entry.person} size={30} />
                <span className="cg-mrow-text">
                  <span className="cg-mrow-title">{personTitle(entry.person)}</span>
                  {entry.headline ? <span className="cg-mrow-sub">{entry.headline}</span> : null}
                </span>
                <CgScore score={entry.score} />
                <ChevronRight className="cg-mrow-chev" aria-hidden="true" />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
