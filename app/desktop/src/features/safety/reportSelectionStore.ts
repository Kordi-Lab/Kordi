// The messages currently selected in the active transcript, published for
// the selection bar's Report button. Reports carry hosted message ids only.

import { useSyncExternalStore } from 'react';

import { transcriptMessageIsOwnHuman } from '@/kordi-app/components/transcriptMessageHumanRole';
import type { Message } from '@/kordi-app/types';

import { REPORT_MAX_MESSAGES } from './reportReasons';
import { isCloudUuid } from './safetyClient';
import type { ReportTarget } from './safetyTypes';
import { humanIdentityAccountId, isServiceAccountId } from './serviceAccounts';

const EMPTY: readonly Message[] = [];
let selection: readonly Message[] = EMPTY;
const listeners = new Set<() => void>();

function messageKey(message: Message): string {
  return message.id?.trim() || message.entryId?.trim() || '';
}

/** Publishes the selected messages in transcript order. */
export function publishReportSelection(messages: readonly Message[], selectedIds: ReadonlySet<string>) {
  const next = selectedIds.size === 0
    ? EMPTY
    : messages.filter((message) => selectedIds.has(messageKey(message)));
  if (next.length === selection.length && next.every((message, index) => message === selection[index])) return;
  selection = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const currentSelection = () => selection;

export function useReportSelection(): readonly Message[] {
  return useSyncExternalStore(subscribe, currentSelection, currentSelection);
}

function isOwnMessage(message: Message): boolean {
  return transcriptMessageIsOwnHuman(message) || message.role === 'owned-agent';
}

/** A finished message stored on the hosted service that a report can cite. */
export function isReportableCloudMessage(message: Message): boolean {
  if (message.role === 'system' || message.role === 'action' || message.role === 'edit') return false;
  if (message.turn && !message.turn.completed) return false;
  if (message.supportContactResponse || message.supportContactTyping) return false;
  return Boolean(message.reactionConversationId?.trim()) && isCloudUuid(message.reactionTargetMessageId);
}

export type ReportSelectionState = {
  target: ReportTarget | null;
  /** Why the selection cannot be reported, for a tooltip. */
  problem: string | null;
};

/**
 * Builds a report about selected messages: they must be hosted messages in
 * one chat, and at least one must come from someone else. The reported
 * account is named only for people; for agent messages the server uses the
 * agent's owner.
 */
export function reportSelectionState(messages: readonly Message[]): ReportSelectionState {
  if (messages.length === 0) return { target: null, problem: 'Choose at least one message.' };
  if (messages.length > REPORT_MAX_MESSAGES) return { target: null, problem: 'Choose up to 50 messages.' };
  if (!messages.every(isReportableCloudMessage)) {
    return { target: null, problem: "Some selected messages can't be included." };
  }
  const conversationIds = new Set(messages.map((message) => message.reactionConversationId?.trim()));
  if (conversationIds.size !== 1) return { target: null, problem: 'Choose messages from one chat.' };
  const first = messages.find((message) => !isOwnMessage(message));
  if (!first) return { target: null, problem: 'Choose at least one message from the person you\'re reporting.' };
  const senderAccountId = first.senderType === 'agent' ? null : humanIdentityAccountId(first.senderIdentityId);
  if (isServiceAccountId(senderAccountId)) return { target: null, problem: "Kordi service messages can't be reported here." };
  const name = (first.senderType === 'agent' ? first.senderOwnerName?.trim() : '') || first.sender?.trim() || 'this person';
  return {
    target: {
      accountId: senderAccountId,
      name,
      conversationId: [...conversationIds][0] ?? null,
      messageIds: [...new Set(messages.map((message) => message.reactionTargetMessageId?.trim() ?? ''))],
    },
    problem: null,
  };
}

export function reportTargetForMessage(message: Message): ReportTarget | null {
  return reportSelectionState([message]).target;
}
