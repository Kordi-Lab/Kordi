import type { CgHost } from './host';
import { PersonActions } from './PersonActions';
import { CgAvatar, CgBack, CgGroup, CgHero, CgNotice, CgProgress, CgSection, CgTag } from './parts';
import type { CgState, CommonGroundStore } from './store';
import { CG_TOPIC_SECTIONS } from './types';

/** Someone's card as you may see it: after pairing, or from a room member. */
export function PersonScreen({ accountId, paired, state, store, host }: {
  accountId: string;
  paired: boolean;
  state: CgState;
  store: CommonGroundStore;
  host: CgHost;
}) {
  const view = state.people[accountId];
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
      <CgHero avatar={<CgAvatar person={person} size={72} />} title={person.name} line={paired ? 'Paired' : undefined} />
      <PersonActions
        person={person}
        state={state}
        store={store}
        host={host}
        onFind={() => store.open({ name: 'match', accountId })}
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
