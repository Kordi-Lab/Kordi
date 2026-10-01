import { createContext, useContext } from 'react';

import type { CloudAccount } from '@/features/cloud/authClient';

import type { ReportTarget, SafetyAccountTarget } from './safetyTypes';

export type SafetyActions = {
  account: CloudAccount | null;
  /**
   * Block, report, leave, withdraw, and remove are shown only after the
   * server confirmed it supports them through GET /v1/cloud/blocks.
   */
  safetyFeaturesAvailable: boolean;
  blockedAccountIds: ReadonlySet<string>;
  openBlock(target: SafetyAccountTarget): void;
  openUnblock(target: SafetyAccountTarget): void;
  openReport(target: ReportTarget): void;
  removeContact(peerAccountId: string): Promise<void>;
  withdrawContactRequest(requestId: string): Promise<void>;
};

const noop = () => undefined;
const unavailable = () => Promise.reject(new Error('This action is not available.'));

export const UNAVAILABLE_SAFETY_ACTIONS: SafetyActions = {
  account: null,
  safetyFeaturesAvailable: false,
  blockedAccountIds: new Set(),
  openBlock: noop,
  openUnblock: noop,
  openReport: noop,
  removeContact: unavailable,
  withdrawContactRequest: unavailable,
};

export const SafetyActionsContext = createContext<SafetyActions>(UNAVAILABLE_SAFETY_ACTIONS);

/** Safety actions from the app-level provider; hidden when none is mounted. */
export function useSafetyActions(): SafetyActions {
  return useContext(SafetyActionsContext);
}
