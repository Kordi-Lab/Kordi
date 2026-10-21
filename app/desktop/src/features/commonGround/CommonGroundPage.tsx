import { BuildScreen } from './BuildScreen';
import { CardScreen } from './CardScreen';
import { HomeScreen } from './HomeScreen';
import type { CgHost } from './host';
import { LobbyScreen } from './LobbyScreen';
import { MatchScreen } from './MatchScreen';
import { CgNotice, CgProgress } from './parts';
import { PersonScreen } from './PersonScreen';
import { ResultsScreen } from './ResultsScreen';
import { hasAnyCard, type CommonGroundStore } from './store';
import { useCommonGround } from './useCommonGround';

/** Common ground in the Contacts detail pane. Navigation lives in the store. */
export function CommonGroundPage({ store, host }: { store: CommonGroundStore; host: CgHost }) {
  const state = useCommonGround(store);
  const screen = state.stack[state.stack.length - 1];
  const props = { state, store, host };
  let body;
  if (!state.loaded) {
    body = <CgProgress line="Opening your card" />;
  } else if (!state.owner) {
    body = <CgNotice text={state.notice ?? 'Could not open Common ground.'} />;
  } else if (screen.name === 'build' || (screen.name === 'home' && !hasAnyCard(state))) {
    body = <BuildScreen {...props} />;
  } else if (screen.name === 'home') {
    body = <HomeScreen {...props} />;
  } else if (screen.name === 'card') {
    body = <CardScreen state={state} store={store} />;
  } else if (screen.name === 'lobby') {
    body = <LobbyScreen code={screen.code} {...props} />;
  } else if (screen.name === 'results') {
    body = <ResultsScreen code={screen.code} {...props} />;
  } else if (screen.name === 'match') {
    body = <MatchScreen accountId={screen.accountId} profileId={screen.profileId} {...props} />;
  } else {
    body = <PersonScreen accountId={screen.accountId} profileId={screen.profileId} {...props} />;
  }
  return (
    <section aria-label="Common ground" className="cg-page">
      <div key={`${state.stack.length}:${screen.name}`} className="cg-scroll">
        <div className="cg-body">{body}</div>
      </div>
    </section>
  );
}
