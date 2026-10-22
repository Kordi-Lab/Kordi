import { BuildScreen } from './BuildScreen';
import { CardScreen } from './CardScreen';
import { HomeScreen } from './HomeScreen';
import type { CgHost } from './host';
import { LobbyScreen } from './LobbyScreen';
import { MatchScreen } from './MatchScreen';
import { CgNotice, CgProgress } from './parts';
import { PersonScreen } from './PersonScreen';
import { ResultsScreen } from './ResultsScreen';
import { currentProfile, hasAnyCard, type CommonGroundStore } from './store';
import { useCommonGround } from './useCommonGround';
import { WalletShell } from './WalletShell';

/** Common ground in the Contacts detail pane. Navigation lives in the store. */
export function CommonGroundPage({ store, host }: { store: CommonGroundStore; host: CgHost }) {
  const state = useCommonGround(store);
  const screen = state.stack[state.stack.length - 1];
  const props = { state, store, host };
  let body;
  if (!state.loaded) {
    body = <CgProgress line="Opening your card" />;
  } else if (!state.owner) {
    body = <CgNotice text={state.notice ?? 'Could not open Grounding.'} />;
  } else if (screen.name === 'home' || (screen.name === 'card' && state.owner.card)) {
    // Home and the card page share the wallet: header, deck rail and one centre column.
    const onCard = screen.name === 'card';
    const title = onCard ? currentProfile(state)?.name ?? 'Your card' : 'Grounding';
    return (
      <section aria-label="Grounding" className={hasAnyCard(state) ? 'cg-page is-wallet' : 'cg-page is-wallet is-first-run'}>
        <WalletShell state={state} store={store} title={title} onBack={onCard ? () => store.back() : undefined}>
          {onCard ? <CardScreen state={state} store={store} /> : <HomeScreen {...props} />}
        </WalletShell>
      </section>
    );
  } else if (screen.name === 'build') {
    body = <BuildScreen {...props} />;
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
    <section aria-label="Grounding" className="cg-page">
      <div key={`${state.stack.length}:${screen.name}`} className="cg-scroll">
        <div className="cg-body">{body}</div>
      </div>
    </section>
  );
}
