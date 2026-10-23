import type { CgHost } from './host';
import { PersonActions } from './PersonActions';
import { CgAvatar, CgBack, CgGroup, CgHero, CgNotice, CgProgress, CgSection, CgTag } from './parts';
import { personTitle } from './profiles';
import { personKey, type CgState, type CommonGroundStore } from './store';
import { CG_TOPIC_SECTIONS } from './types';

/** Someone's card as you may see it, opened from a room member. */
export function PersonScreen({ accountId, profileId, state, store, host }: {
  accountId: string;
  profileId?: string;
  state: CgState;
  store: CommonGroundStore;
  host: CgHost;
}) {
  const view = state.people[personKey(accountId, profileId)];
  if (!view) {
    return (
      <>
        <CgBack onBack={() => store.back()} />
        {state.notice ? <CgNotice text={state.notice} /> : <CgProgress line="Opening card" />}
      </>
    );
  }
  const { person, card } = view;
  return (
    <>
      <CgBack onBack={() => store.back()} />
      <CgHero avatar={<CgAvatar person={person} size={72} />} title={personTitle(person)} line={person.handle ? <span className="cg-hero-handle">@{person.handle}</span> : undefined} />
      <PersonActions
        person={person}
        state={state}
        store={store}
        host={host}
        onFind={() => store.open({ name: 'match', accountId, profileId })}
      />
      <CgNotice text={state.notice} />
      {CG_TOPIC_SECTIONS.filter(([key]) => card[key].length).map(([key, title]) => (
        <CgSection key={key} title={title}>
          <CgGroup className="cg-tags">
            {card[key].map((topic) => <CgTag key={topic} topic={topic} />)}
          </CgGroup>
        </CgSection>
      ))}
    </>
  );
}
