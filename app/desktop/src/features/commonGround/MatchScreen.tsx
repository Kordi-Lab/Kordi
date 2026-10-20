import { useState } from 'react';

import type { CgHost } from './host';
import { PersonActions } from './PersonActions';
import { CgAvatar, CgBack, CgGroup, CgNotice, CgProgress, CgRow, CgSection, CgSegmented, CgTopicDot } from './parts';
import type { CgState, CommonGroundStore } from './store';
import type { CgTrade } from './types';

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function TradeRows({ items, whose }: { items: CgTrade[]; whose: string }) {
  return (
    <CgGroup>
      {items.map((trade) => (
        <CgRow key={`${trade.topic}:${trade.for}`} lead={<CgTopicDot topic={trade.topic} />} title={trade.topic} sub={`For ${whose} ${lowerFirst(trade.for)}`} />
      ))}
    </CgGroup>
  );
}

export function MatchScreen({ accountId, state, store, host }: { accountId: string; state: CgState; store: CommonGroundStore; host: CgHost }) {
  const [tab, setTab] = useState<'shared' | 'trade'>('shared');
  const match = state.matches[accountId];
  if (!match) {
    return (
      <>
        <CgBack onBack={() => store.back()} />
        {state.notice ? <CgNotice text={state.notice} /> : <CgProgress line="Reading cards" />}
      </>
    );
  }
  const person = match.person;
  const ready = match.status === 'ready';
  const shared = match.shared ?? [];
  const youBring = match.youBring ?? [];
  const theyBring = match.theyBring ?? [];
  return (
    <>
      <CgBack onBack={() => store.back()} />
      <div className="cg-hero">
        <span className="cg-pair">
          <CgAvatar person={host.self} size={64} ring isSelf />
          <CgAvatar person={person} size={64} ring />
        </span>
        {ready ? <span className="cg-badge">{match.score ?? 0}%</span> : null}
        <h1>{person.name}</h1>
        {ready && match.headline ? <div className="cg-hero-line">{match.headline}</div> : null}
      </div>
      <PersonActions person={person} state={state} store={store} host={host} />
      <CgNotice text={state.notice} />
      {match.status === 'matching' ? <CgProgress line="Finding what you share" /> : null}
      {match.status === 'failed' ? <CgNotice text="Could not find a match. Try again later." /> : null}
      {ready ? (
        <>
          <CgSegmented value={tab} onChange={setTab} label="Match" options={[['shared', 'Shared'], ['trade', 'Trade']]} />
          {tab === 'shared' ? (
            <CgSection>
              <CgGroup>
                {shared.length
                  ? shared.map((reason) => <CgRow key={reason.topic} lead={<CgTopicDot topic={reason.topic} />} title={reason.topic} sub={reason.why} />)
                  : <CgRow title={<span className="cg-muted">No clear overlap yet</span>} />}
              </CgGroup>
            </CgSection>
          ) : youBring.length || theyBring.length ? (
            <>
              {youBring.length ? <CgSection title="You bring"><TradeRows items={youBring} whose={`${person.name}'s`} /></CgSection> : null}
              {theyBring.length ? <CgSection title={`${person.name} brings`}><TradeRows items={theyBring} whose="your" /></CgSection> : null}
            </>
          ) : (
            <CgSection><CgGroup><CgRow title={<span className="cg-muted">No clear trade yet</span>} /></CgGroup></CgSection>
          )}
          {match.nextStep ? <div className="cg-next-step">{match.nextStep}</div> : null}
        </>
      ) : null}
    </>
  );
}
