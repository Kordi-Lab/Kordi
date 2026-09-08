import type { DigestState } from './store';
import type { CalendarEvent } from './types';

export function feedbackState(state: DigestState, id: string, dismissed: boolean): DigestState {
  if (!state.digest) return state;
  const feedback = state.digest.feedback.filter(item => item.id !== id);
  if (dismissed) feedback.push({ id, status: 'dismissed' });
  return { ...state, digest: { ...state.digest, feedback } };
}

export function removedEventsState(state: DigestState, events: CalendarEvent[], seriesId?: string): DigestState {
  const ids = new Set(events.map(event => event.id));
  const digest = state.digest;
  return {
    ...state,
    events: state.events.filter(event => !ids.has(event.id)),
    digest: digest?.snapshot ? { ...digest, snapshot: {
      ...digest.snapshot,
      calendarCandidates: digest.snapshot.calendarCandidates.filter(item =>
        !ids.has(item.existingEventId ?? '') && !(seriesId && item.existingSeriesId === seriesId)),
    } } : digest,
  };
}
