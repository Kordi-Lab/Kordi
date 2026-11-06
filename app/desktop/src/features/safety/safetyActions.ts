import { createContext, useContext } from 'react';

import type { CloudBlockedAccount, ReportTarget, SafetyAccountTarget } from './safetyTypes';

export type SafetyActions = {
  /**
   * Block and Report show only after the server confirmed it supports them
   * through GET /v1/cloud/blocks.
   */
  available: boolean;
  blocks: CloudBlockedAccount[];
  blocksLoaded: boolean;
  blocksError: string | null;
  blockedAccountIds: ReadonlySet<string>;
  /** `onBlocked` runs after a confirmed block, for example to close a contact pane. */
  openBlock(this: void, target: SafetyAccountTarget, onBlocked?: () => void): void;
  openUnblock(this: void, target: SafetyAccountTarget): void;
  openReport(this: void, target: ReportTarget): void;
  refreshBlocks(this: void): Promise<void>;
};

const noop = () => undefined;

export const UNAVAILABLE_SAFETY_ACTIONS: SafetyActions = {
  available: false,
  blocks: [],
  blocksLoaded: false,
  blocksError: null,
  blockedAccountIds: new Set(),
  openBlock: noop,
  openUnblock: noop,
  openReport: noop,
  refreshBlocks: () => Promise.resolve(),
};

export const SafetyActionsContext = createContext<SafetyActions>(UNAVAILABLE_SAFETY_ACTIONS);

/** Block and report actions from the app-level provider; unavailable when none is mounted. */
export function useSafetyActions(): SafetyActions {
  return useContext(SafetyActionsContext);
}
