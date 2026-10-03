// Copy for actions that need a person ("Waiting for you"). Times are shown in
// local time with a time zone label, the way plan cards show them.
import type { AgentActionDecision, PendingAgentAction } from '@/features/cloud/agentTrustTypes';

export type PendingActionCopy = {
  title: string;
  body: string;
  footnote: string | null;
  approveLabel: string;
  declineLabel: string;
  /** Accessible names for the two buttons. */
  approveName: string;
  declineName: string;
};

export type PendingActionFormatOptions = { locale?: string; timeZone?: string };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** "Fri, Oct 2 · 6:30 PM PDT", or the date alone for a date without a time. */
export function formatPendingTime(value: unknown, options: PendingActionFormatOptions = {}): string | null {
  const raw = text(value);
  if (!raw) return null;
  if (DATE_ONLY.test(raw)) {
    const date = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return raw;
    return new Intl.DateTimeFormat(options.locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const day = new Intl.DateTimeFormat(options.locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: options.timeZone }).format(date);
  const time = new Intl.DateTimeFormat(options.locale, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: options.timeZone }).format(date);
  return `${day} · ${time}`;
}

export function calendarWindowLabel(startAt: unknown, endAt: unknown, options: PendingActionFormatOptions = {}): string {
  const start = formatPendingTime(startAt, options);
  const end = formatPendingTime(endAt, options);
  if (start && end) return `${start} – ${end}`;
  if (start) return `from ${start}`;
  if (end) return `until ${end}`;
  return 'all dates';
}

function quoted(value: string) {
  return `“${value}”`;
}

export function pendingActionCopy(action: PendingAgentAction, options: PendingActionFormatOptions = {}): PendingActionCopy {
  const subject = action.subject;
  const title = text(subject.title) ?? 'this plan';
  const when = formatPendingTime(subject.startAt, options);
  const onWhen = when ? ` on ${when}` : '';
  const reason = text(subject.reason);
  const withReason = reason ? `: ${quoted(reason)}` : '';
  switch (action.kind) {
    case 'calendar_disclosure': {
      const agent = text(subject.agentName) ?? action.proposedBy.displayName ?? 'Your agent';
      return {
        title: 'Share your calendar in this chat?',
        body: `${agent} wants to read your saved Kordi calendar for ${calendarWindowLabel(subject.startAt, subject.endAt, options)} and may summarize it for everyone here.`,
        footnote: `If you allow this, ${agent} can read these dates again in this chat for the next 10 minutes.`,
        approveLabel: 'Allow',
        declineLabel: 'Don\'t allow',
        approveName: 'Allow sharing your calendar',
        declineName: 'Don\'t allow sharing your calendar',
      };
    }
    case 'plan_rsvp': {
      const going = subject.rsvp !== 'no';
      return {
        title: going ? 'PiP noted you\'re in' : 'PiP noted you can\'t make it',
        body: `From your message, PiP thinks you ${going ? 'can' : 'can\'t'} make ${quoted(title)}${onWhen}. Confirm so the plan shows your answer.`,
        footnote: null,
        approveLabel: 'Confirm',
        declineLabel: 'Not right',
        approveName: `Confirm your answer for ${title}`,
        declineName: `Dismiss PiP's answer for ${title}`,
      };
    }
    case 'plan_vote': {
      const option = text(subject.optionLabel) ?? 'this option';
      return {
        title: 'PiP noted your choice',
        body: `From your message, PiP thinks you prefer ${quoted(option)} for ${quoted(title)}. Confirm to add your vote.`,
        footnote: null,
        approveLabel: 'Vote',
        declineLabel: 'Not right',
        approveName: `Vote for ${option}`,
        declineName: `Dismiss PiP's vote for ${option}`,
      };
    }
    case 'plan_confirm': {
      const location = text(subject.location);
      return {
        title: 'Confirm this plan?',
        body: `PiP thinks the group settled on ${quoted(title)}${onWhen}${location ? ` at ${location}` : ''}. Confirming adds it to the Kordi calendar of everyone who said they're in.`,
        footnote: null,
        approveLabel: 'Confirm plan',
        declineLabel: 'Not yet',
        approveName: `Confirm the plan ${title}`,
        declineName: `Don't confirm the plan ${title} yet`,
      };
    }
    case 'plan_cancel':
      return {
        title: 'Cancel this plan?',
        body: `PiP thinks ${quoted(title)} is off${withReason}. Canceling removes it from everyone's Kordi calendar.`,
        footnote: null,
        approveLabel: 'Cancel plan',
        declineLabel: 'Keep plan',
        approveName: `Cancel the plan ${title}`,
        declineName: `Keep the plan ${title}`,
      };
    case 'plan_reopen':
      return {
        title: 'Reopen this plan?',
        body: `PiP thinks ${quoted(title)} may no longer stand${withReason}. Reopening removes it from calendars until someone confirms it again.`,
        footnote: null,
        approveLabel: 'Reopen',
        declineLabel: 'Keep as is',
        approveName: `Reopen the plan ${title}`,
        declineName: `Keep the plan ${title} as is`,
      };
  }
}

/** Inline error text for a failed decision, by server error code. */
export function pendingActionErrorText(code: string | null | undefined): string {
  if (code === 'plan_changed') return 'This plan changed. Check the card and try again.';
  if (code === 'agent_action_closed') return 'This request is no longer waiting. Ask again if you still need it.';
  return 'Couldn\'t save your answer. Try again.';
}

/** What a screen reader hears after a decision is saved. */
export function pendingActionAnnouncement(action: PendingAgentAction, decision: AgentActionDecision): string {
  if (action.kind === 'calendar_disclosure') {
    return decision === 'approve' ? 'Calendar sharing allowed.' : 'Calendar sharing declined.';
  }
  return decision === 'approve' ? 'Answer saved.' : 'Suggestion dismissed.';
}
