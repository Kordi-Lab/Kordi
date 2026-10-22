// The Pair popover's state, without React: the code you show and when it runs out, a quiet
// refresh shortly before that, and redeeming the other person's code.

import { displayPairCode, normalizePairCode } from './pairLink';
import { PAIR_INVALID, PAIR_SELF, type CgPairCodeResult, type CgRedeemResult } from './storePairing';

/** How long a code lasts on the server. */
export const PAIR_CODE_TTL_MS = 120_000;
/** A new code replaces the shown one this long before it runs out. */
export const PAIR_REFRESH_LEAD_MS = 10_000;

/**
 * `loading` before the first code; `ready` shows it; `sharing-off` asks to turn sharing back on;
 * `failed` could not get a code; `closed` after pairing or when Build opened instead.
 */
export type CgPairPhase = 'loading' | 'ready' | 'sharing-off' | 'failed' | 'closed';

export type CgPairView = {
  phase: CgPairPhase;
  /** Your code, as `K4M7-2QXA`. */
  code: string | null;
  /** Local time the code runs out, in ms. */
  expiresAt: number | null;
  /** Why a code could not be made. */
  loadError: string | null;
  /** One line under "Their code". */
  error: string | null;
  redeeming: boolean;
};

export type CgPairDeps = {
  create: () => Promise<CgPairCodeResult>;
  redeem: (code: string) => Promise<CgRedeemResult>;
  now?: () => number;
  /** Runs `run` after `ms`; returns a cancel. */
  setTimer?: (run: () => void, ms: number) => () => void;
};

const defaultTimer = (run: () => void, ms: number) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

/**
 * Time left on a code by the local clock. The server's `expiresAt` sets it, unless the clocks
 * disagree so much that it looks spent or too long; then the code's usual two minutes apply.
 */
export function pairCodeDeadline(expiresAt: string, now: number): number {
  const left = Date.parse(expiresAt) - now;
  return now + (Number.isFinite(left) && left > PAIR_REFRESH_LEAD_MS && left <= PAIR_CODE_TTL_MS * 2 ? left : PAIR_CODE_TTL_MS);
}

/** `1:42` for the time left on a code. */
export function pairTimeLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export class CgPairSession {
  private view: CgPairView = { phase: 'loading', code: null, expiresAt: null, loadError: null, error: null, redeeming: false };
  private listeners = new Set<() => void>();
  private cancelRefresh: (() => void) | null = null;
  private generation = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => () => void;

  constructor(private readonly deps: CgPairDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? defaultTimer;
  }

  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<CgPairView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  /** Gets a code and schedules the next one before it runs out. The shown code stays until then. */
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.cancelRefresh?.();
    this.cancelRefresh = null;
    if (!this.view.code) this.set({ phase: 'loading', loadError: null });
    const result = await this.deps.create();
    if (this.stopped || generation !== this.generation) return;
    if (result.status === 'ok') {
      const now = this.now();
      const expiresAt = pairCodeDeadline(result.code.expiresAt, now);
      this.set({ phase: 'ready', code: displayPairCode(result.code.code) ?? result.code.code, expiresAt, loadError: null });
      this.cancelRefresh = this.setTimer(() => { void this.refresh(); }, expiresAt - now - PAIR_REFRESH_LEAD_MS);
    } else if (result.status === 'build') {
      this.set({ phase: 'closed' });
    } else if (result.status === 'sharing-off') {
      this.set({ phase: 'sharing-off', code: null, expiresAt: null });
    } else {
      this.set({ phase: 'failed', code: null, expiresAt: null, loadError: result.message });
    }
  }

  /** Redeems their code; true once paired (the match is open). Your own code is refused here. */
  async redeem(input: string): Promise<boolean> {
    if (this.view.redeeming) return false;
    const code = displayPairCode(input);
    if (!code) {
      this.set({ error: PAIR_INVALID });
      return false;
    }
    if (this.view.code && normalizePairCode(this.view.code) === normalizePairCode(code)) {
      this.set({ error: PAIR_SELF });
      return false;
    }
    this.set({ redeeming: true, error: null });
    const result = await this.deps.redeem(code);
    if (result.status === 'paired' || result.status === 'build') this.set({ phase: 'closed', redeeming: false });
    else if (result.status === 'sharing-off') this.set({ phase: 'sharing-off', code: null, expiresAt: null, redeeming: false });
    else this.set({ error: result.message, redeeming: false });
    return result.status === 'paired';
  }

  clearError() {
    if (this.view.error) this.set({ error: null });
  }

  /** Shows a code and keeps it fresh while the popover is open. */
  start(): Promise<void> {
    this.stopped = false;
    return this.refresh();
  }

  /** Stops renewing; a code still on its way is dropped. */
  stop() {
    this.stopped = true;
    this.generation += 1;
    this.cancelRefresh?.();
    this.cancelRefresh = null;
  }
}
