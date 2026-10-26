import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { profileDesign } from './cardDesign';
import type { CgHost } from './host';
import { MatchDetails } from './MatchScreen';
import { bandLabel, evidenceLine } from './nearbyFormat';
import { PersonActions } from './PersonActions';
import { CgAvatar, CgBack, CgGroup, CgNotice, CgProgress, CgSection } from './parts';
import { CardSwatch } from './ProfileCard';
import type { CgState, CommonGroundStore } from './store';
import type { CgTopicLists } from './types';
import type { CgNearbyRequestCheck } from './typesNearby';
import { useNearby } from './useNearby';

function RequestChecks({ request, card }: { request: CgNearbyRequestCheck; card: CgTopicLists }) {
  return (
    <div className="cg-nb-req">
      <div className="cg-nb-req-title">{request.text}</div>
      {request.checks.map((check) => {
        const met = check.verdict === 'met';
        return (
          <div key={check.condition} className={cn('cg-nb-check', met && 'is-met')}>
            <span className="cg-nb-check-icon">
              {met ? <Check aria-hidden="true" /> : null}
              <span className="sr-only">{met ? 'Met' : 'Not met'}</span>
            </span>
            <span className="cg-nb-check-text">
              <span className="cg-nb-check-label">{check.label ?? request.text}</span>
              <span className="cg-nb-check-evidence">{evidenceLine(check, card)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Someone nearby: the match between the two shared cards, the distance band, and how they meet your requests. */
export function NearbyPersonScreen({ accountId, state, store, host }: { accountId: string; state: CgState; store: CommonGroundStore; host: CgHost }) {
  const [nb] = useNearby(store, { accountId, poll: true });
  const view = nb.persons[accountId];
  const notice = nb.personNotices[accountId] ?? null;
  if (!view) {
    return (
      <>
        <CgBack onBack={() => store.back()} />
        {notice ? <CgNotice text={notice} /> : <CgProgress line="Opening card" />}
      </>
    );
  }
  const { person } = view;
  const profile = person.profile;
  return (
    <>
      <CgBack onBack={() => store.back()} />
      <div className="cg-hero">
        <span className="cg-pair">
          <CgAvatar person={host.self} size={64} ring isSelf />
          <CgAvatar person={person} size={64} ring />
        </span>
        {view.status === 'ready' && view.score !== null ? <span className="cg-badge">{view.score}%</span> : null}
        <h1>{person.name}</h1>
        <div className="cg-hero-line cg-nb-hero-line">
          {profile ? <span className="cg-nb-pchip"><CardSwatch design={profileDesign(profile)} className="is-chip" />{profile.name}</span> : null}
          <span>{bandLabel(view.distance)}</span>
        </div>
      </div>
      <PersonActions person={person} state={state} store={store} host={host} />
      <CgNotice text={notice ?? state.notice} />
      {view.requests.length ? (
        <CgSection title="Your requests">
          <CgGroup>
            {view.requests.map((request) => <RequestChecks key={request.needId} request={request} card={view.card} />)}
          </CgGroup>
        </CgSection>
      ) : null}
      <MatchDetails
        match={{ status: view.status, person, shared: view.shared, youBring: view.youBring, theyBring: view.theyBring, nextStep: view.nextStep ?? undefined }}
      />
    </>
  );
}
