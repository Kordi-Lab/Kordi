import { useEffect } from 'react';
import { consumeHelpGroundingScreen, OPEN_GROUNDING_EVENT } from '@/features/onboarding/helpNavigation';
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
import { useCommonGround, usePairLinkRedeem } from './useCommonGround';
import { WalletShell } from './WalletShell';

/** Common ground in the Contacts detail pane. Navigation lives in the store. */
export function CommonGroundPage({ store, host }: { store: CommonGroundStore; host: CgHost }) {
  const state = useCommonGround(store);
  const ownerReady = Boolean(state.owner);
  const helpCard = state.loaded && state.owner ? (state.owner.card ? 'built' : 'empty') : undefined;
  const helpSocial = state.loaded && state.owner ? (hasAnyCard(state) ? 'ready' : 'empty') : undefined;
  useEffect(() => {
    if (!state.loaded || !ownerReady) return;
    const navigate = () => {
      const name = consumeHelpGroundingScreen(host.self.accountId);
      if (name) {
        const destination = name === 'card' && !store.getSnapshot().owner?.card ? 'build' : name;
        if (store.top().name !== destination) store.replace({ name: destination });
      }
    };
    navigate();
    window.addEventListener(OPEN_GROUNDING_EVENT, navigate);
    return () => window.removeEventListener(OPEN_GROUNDING_EVENT, navigate);
  }, [host.self.accountId, state.loaded, ownerReady, store]);
  usePairLinkRedeem(store, state.loaded);
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
      <section data-help-grounding-card={helpCard} data-help-grounding-social={helpSocial} aria-label="Grounding" className={hasAnyCard(state) ? 'cg-page is-wallet' : 'cg-page is-wallet is-first-run'}>
        <WalletShell state={state} store={store} owner={host.self} title={title} onBack={onCard ? () => store.back() : undefined}>
          {onCard ? <CardScreen state={state} store={store} memoryRouting={host.memoryRouting} memoryCards={host.memoryCards} /> : <HomeScreen {...props} />}
        </WalletShell>
      </section>
    );
  } else if (screen.name === 'build') {
    // Keyed by card, so switching cards (or the list arriving) opens Build with that card's picks.
    body = <BuildScreen key={`${state.profileId ?? ''}:${currentProfile(state) ? 'loaded' : ''}`} {...props} />;
  } else if (screen.name === 'card') {
    body = <CardScreen state={state} store={store} memoryRouting={host.memoryRouting} memoryCards={host.memoryCards} />;
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
    <section data-help-grounding-card={helpCard} data-help-grounding-social={helpSocial} aria-label="Grounding" className="cg-page">
      <div key={`${state.stack.length}:${screen.name}`} className="cg-scroll">
        <div className="cg-body">{body}</div>
      </div>
    </section>
  );
}
