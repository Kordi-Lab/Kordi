import { useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, LoaderCircle, Plus } from 'lucide-react';

import { SettingsSwitch } from '@/kordi-app/components/settingsLayout';
import { cn } from '@/lib/utils';
import { NbMenuButton } from './NearbyMenu';
import {
  bandLabel, checkItems, NEARBY_PER_DAY, NEARBY_RANGES, NEARBY_SCORES, needEnded, needSub, OPEN_TO_CHARS, OPEN_TO_MAX, openToEntry, perDayLabel,
  rangePill, scorePill,
} from './nearbyFormat';
import { CgAvatar } from './parts';
import { nearbyActivitySuggestions } from './nearbyActivities';
import type { CgProfile } from './types';
import { personTitle } from './profiles';
import { matchingCount, type CgNearbyStore } from './storeNearby';
import type { CgNearbyEntry, CgNearbyResults, CgNearbySettings, CgNeed } from './typesNearby';

const caret = <ChevronDown className="cg-nb-caret" aria-hidden="true" />;
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Activities for this card, with suggestions and custom entries. */
export function NearbyOpenTo({ settings, nearby, profile, busy = false }: { settings: CgNearbySettings; nearby: CgNearbyStore; profile?: CgProfile; busy?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const done = useRef(false);
  const openTo = settings.openTo;
  const suggestions = nearbyActivitySuggestions(profile);
  const chips = [...suggestions, ...openTo.filter((item) => !suggestions.some((suggestion) => same(suggestion, item)))];
  const isOn = (chip: string) => openTo.some((item) => same(item, chip));
  const full = openTo.length >= OPEN_TO_MAX;
  const toggle = (chip: string) => {
    if (isOn(chip)) void nearby.setOpenTo(openTo.filter((item) => !same(item, chip)), settings.profileId);
    else if (!full) void nearby.setOpenTo([...openTo, chip], settings.profileId);
  };
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    setDraft(null);
    const entry = value === null ? null : openToEntry(openTo, value);
    if (entry) void nearby.setOpenTo([...openTo, entry], settings.profileId);
  };
  return (
    <div className="cg-panel cg-nb-chips">
      {chips.map((chip) => {
        const on = isOn(chip);
        return (
          <button key={chip} type="button" className={cn('cg-nb-chip', on && 'is-on')} aria-pressed={on} disabled={busy || (!on && full)} onClick={() => toggle(chip)}>
            {on ? <Check className="h-[13px] w-[13px]" aria-hidden="true" /> : null}
            {chip}
          </button>
        );
      })}
      {draft !== null ? (
        <span className="cg-nb-chip is-draft">
          <input
            autoFocus
            value={draft}
            maxLength={OPEN_TO_CHARS}
            placeholder="Activity"
            aria-label="Activity"
            disabled={busy}
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') finish(draft);
              if (event.key === 'Escape') { event.stopPropagation(); finish(null); }
            }}
            onBlur={() => finish(draft)}
          />
        </span>
      ) : (
        <button type="button" className="cg-nb-chip is-add" aria-label="Add activity" disabled={busy || full} onClick={() => { done.current = false; setDraft(''); }}>
          <Plus className="h-[14px] w-[14px]" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function PersonRow({ entry, onOpen }: { entry: CgNearbyEntry; onOpen: () => void }) {
  const sub = [entry.score !== null ? `${entry.score}%` : '', bandLabel(entry.distance), entry.headline ?? ''].filter(Boolean).join(' · ');
  return (
    <button type="button" className="cg-mrow cg-nb-person" onClick={onOpen}>
      <CgAvatar person={entry.person} size={30} />
      <span className="cg-mrow-text">
        <span className="cg-nb-person-title">
          <span className="cg-mrow-title">{personTitle(entry.person)}</span>
          {entry.requests.map((request) => (
            <span key={request.needId} className="cg-nb-met" title={request.text}>
              <Check aria-hidden="true" />
              <span>{request.text}</span>
            </span>
          ))}
        </span>
        <span className="cg-mrow-sub">{sub}</span>
      </span>
      <ChevronRight className="cg-mrow-chev" aria-hidden="true" />
    </button>
  );
}

/** People: the Within and match filters, then who is around, and how many are still being matched. */
export function NearbyPeople({ settings, results, nearby, onOpen }: {
  settings: CgNearbySettings;
  results: CgNearbyResults | null;
  nearby: CgNearbyStore;
  onOpen: (accountId: string) => void;
}) {
  const rows = results?.people.filter((entry) => entry.status !== 'matching') ?? [];
  const more = matchingCount(results);
  return (
    <>
      <div className="cg-nb-sechead">
        <h2 className="cg-msec">People</h2>
        <span className="cg-nb-pills">
          <NbMenuButton id="range" label="Within" className="cg-mbtn is-sm" items={checkItems(NEARBY_RANGES, settings.range, (range) => void nearby.setFilters({ range }))}>
            {rangePill(settings.range)}{caret}
          </NbMenuButton>
          <NbMenuButton id="score" label="Match" className="cg-mbtn is-sm" align="right" items={checkItems(NEARBY_SCORES, settings.minScore, (minScore) => void nearby.setFilters({ minScore }))}>
            {scorePill(settings.minScore)}{caret}
          </NbMenuButton>
        </span>
      </div>
      {results ? (
        <div className="cg-panel">
          {rows.map((entry) => <PersonRow key={entry.person.accountId} entry={entry} onOpen={() => onOpen(entry.person.accountId)} />)}
          {more ? (
            <div className="cg-mrow is-matching" role="status">
              <span className="cg-nb-spin"><LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /></span>
              <span className="cg-mrow-text"><span className="cg-mrow-sub">Matching {more} more</span></span>
            </div>
          ) : null}
          {!rows.length && !more ? (
            <div className="cg-mrow is-plain"><span className="cg-mrow-text"><span className="cg-mrow-sub">No one nearby yet</span></span></div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Looking for: your requests, newest first; ended ones stay until deleted. */
export function NearbyNeeds({ needs, onOpen }: { needs: CgNeed[]; onOpen: (need: CgNeed | null) => void }) {
  const now = new Date();
  return (
    <div className="cg-panel">
      {needs.map((need) => (
        <button key={need.needId} type="button" className={cn('cg-mrow is-plain', needEnded(need, now.getTime()) && 'is-ended')} onClick={() => onOpen(need)}>
          <span className="cg-mrow-text">
            <span className="cg-mrow-title">{need.text}</span>
            <span className="cg-mrow-sub">{needSub(need, now)}</span>
          </span>
          <ChevronRight className="cg-mrow-chev" aria-hidden="true" />
        </button>
      ))}
      <button type="button" className="cg-mrow is-plain cg-nb-add" onClick={() => onOpen(null)}>
        <Plus className="h-[14px] w-[14px]" aria-hidden="true" />
        Add
      </button>
    </div>
  );
}

/** Alerts go to the iPhone: requests, good matches and a daily cap. */
export function NearbyAlerts({ settings, nearby }: { settings: CgNearbySettings; nearby: CgNearbyStore }) {
  const alerts = settings.alerts;
  return (
    <div className="cg-panel">
      <div className="cg-mrow is-plain">
        <span className="cg-mrow-text"><span className="cg-mrow-title">Requests</span></span>
        <SettingsSwitch enabled={alerts.requests} label="Requests" onChange={(requests) => void nearby.setAlerts({ requests })} />
      </div>
      <div className="cg-mrow is-plain">
        <span className="cg-mrow-text">
          <span className="cg-mrow-title">Good matches</span>
          <span className="cg-mrow-sub">{alerts.matchMinScore}% and up</span>
        </span>
        <SettingsSwitch enabled={alerts.matches} label="Good matches" onChange={(matches) => void nearby.setAlerts({ matches })} />
      </div>
      <div className="cg-mrow is-plain">
        <span className="cg-mrow-text">
          <span className="cg-mrow-title">At most</span>
          <span className="cg-mrow-sub">Alerts go to your iPhone</span>
        </span>
        <NbMenuButton id="perday" label="At most" className="cg-mbtn is-sm" align="right" items={checkItems(NEARBY_PER_DAY, alerts.maxPerDay, (maxPerDay) => void nearby.setAlerts({ maxPerDay }))}>
          {perDayLabel(alerts.maxPerDay)}{caret}
        </NbMenuButton>
      </div>
    </div>
  );
}
