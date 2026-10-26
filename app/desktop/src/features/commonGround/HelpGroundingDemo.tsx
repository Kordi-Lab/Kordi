import { useEffect, useState, useSyncExternalStore } from 'react';
import { createCommonGroundClient } from './client';
import { CommonGroundStore } from './store';
import { BuildScreen } from './BuildScreen';
import { CardScreen } from './CardScreen';
import { HomeScreen } from './HomeScreen';
import { WalletShell } from './WalletShell';
import type { CgHost } from './host';

const profile = { profileId: 'tour-example', kind: 'work' as const, name: 'Example card', focus: 'Designing useful apps', position: 0, hasCard: true, sharing: false, builtAt: null, topicCount: 4, design: null, icon: null,
  sources: { memory: false, connectors: [], device: [], agents: false, documents: ['tour-document'], links: '', notes: 'I design accessible apps. I enjoy hiking, can help with interface design, and would like feedback on a new app.' } };
const owner = { card: { workingOn: ['An accessible app'], interests: ['Hiking'], canHelp: ['Interface design'], lookingFor: ['Feedback on an app'], hidden: [], revision: 1, builtAt: null }, sharing: false, build: { status: 'idle' as const, errorCode: null }, profile };

/** A disposable, disconnected store: example controls can never write to the account. */
function exampleStore() {
  const client = createCommonGroundClient({ token: () => Promise.resolve('tour-example'), fetchImpl: () => (input, init) => { const url = input instanceof Request ? input.url : String(input); if ((!init?.method || init.method === 'GET') && url.includes('/documents')) return Promise.resolve(new Response(JSON.stringify({ documents: [{ attachmentId: 'tour-document', title: 'App design notes · Example', updatedAt: '2026-01-01T00:00:00Z', sizeBytes: 240 }] }), { status: 200 })); return Promise.reject(new Error('Example only. Close the tour to use your own cards.')); } });
  const store = new CommonGroundStore(client, { profiles: true });
  store.set({ loaded: true, owner, profiles: [profile], profileId: profile.profileId });
  return store;
}
const host: CgHost = { self: { accountId: 'tour-example', name: 'Alex · Example', avatarUrl: null }, profiles: true, sources: true, memoryAvailable: true, connectors: null, agentFiles: null, device: null, openChat: () => undefined, acceptRequest: () => Promise.resolve(), contactsChanged: () => undefined, openGroup: () => undefined, openUrl: () => undefined };

export function HelpGroundingDemo({ screen }: { screen: 'home' | 'build' | 'card' }) {
  const [store] = useState(exampleStore);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => { store.set({ stack: [{ name: screen }] }); }, [screen, store]);
  return <section aria-label="Grounding example" className="cg-page is-wallet" data-help-grounding-card="built" data-help-grounding-social="ready" data-help-demo="grounding">
    <div className="help-example-label" role="note"><strong>Example data</strong><span>A preview for this tour. Nothing is saved or shared.</span></div>
    <fieldset disabled className="help-example-content" aria-label="Example card controls">
      {screen === 'build' ? <div className="cg-scroll"><div className="cg-body"><BuildScreen state={state} store={store} host={host} /></div></div> : <WalletShell state={state} store={store} owner={host.self} title={screen === 'card' ? 'Example card' : 'Grounding'}>
        {screen === 'card' ? <CardScreen state={state} store={store} /> : <HomeScreen state={state} store={store} />}
      </WalletShell>}
    </fieldset>
  </section>;
}
