// One-to-one pairing for the Grounding store: a short code to show for the current card, and
// redeeming someone else's code, which opens the match with that person.

import { commonGroundErrorCode, commonGroundErrorMessage, type CommonGroundClient } from './client';
import type { CgScreen, CgState } from './store';
import type { CgPairCode } from './types';

/** The parts of the store these operations use. */
export type CgPairStoreHost = {
  readonly client: CommonGroundClient;
  getSnapshot: () => CgState;
  set: (patch: Partial<CgState>) => void;
  open: (screen: CgScreen) => void;
};

export const PAIR_EXPIRED = 'That code expired. Ask for a new one.';
export const PAIR_SELF = 'That is your code. Enter theirs.';
export const PAIR_SHARING_OFF = 'Turn sharing back on to pair.';
export const PAIR_INVALID = 'Enter their 8-character code.';

/** No card opens the first-run build; sharing off asks to turn it back on. */
export type CgPairFailure = { status: 'build' } | { status: 'sharing-off' } | { status: 'error'; message: string };
export type CgPairCodeResult = { status: 'ok'; code: CgPairCode } | CgPairFailure;
export type CgRedeemResult = { status: 'paired'; accountId: string } | CgPairFailure;

function failure(host: CgPairStoreHost, error: unknown): CgPairFailure {
  const code = commonGroundErrorCode(error);
  if (code === 'common_ground_no_card') {
    host.open({ name: 'build' });
    return { status: 'build' };
  }
  if (code === 'common_ground_sharing_off') return { status: 'sharing-off' };
  if (code === 'common_ground_code_not_found') return { status: 'error', message: PAIR_EXPIRED };
  return { status: 'error', message: commonGroundErrorMessage(error) };
}

/** A fresh code sharing the selected card; the server keeps only the newest one. */
export async function newPairCode(host: CgPairStoreHost): Promise<CgPairCodeResult> {
  try {
    return { status: 'ok', code: await host.client.newPairCode(host.getSnapshot().profileId) };
  } catch (error) {
    return failure(host, error);
  }
}

/** Pairs through someone's code, sharing the selected card, and opens the match. */
export async function redeemPairCode(host: CgPairStoreHost, code: string): Promise<CgRedeemResult> {
  const profileId = host.getSnapshot().profileId;
  try {
    const view = await host.client.redeem(code, profileId);
    const accountId = view.person.accountId;
    host.open(profileId ? { name: 'match', accountId, profileId } : { name: 'match', accountId });
    return { status: 'paired', accountId };
  } catch (error) {
    return failure(host, error);
  }
}

/** A code from a `kordi://common-ground/pair/` link; a failure shows as the page notice. */
export async function redeemPairLink(host: CgPairStoreHost, code: string): Promise<CgRedeemResult> {
  const result = await redeemPairCode(host, code);
  if (result.status === 'sharing-off') host.set({ notice: PAIR_SHARING_OFF });
  else if (result.status === 'error') host.set({ notice: result.message });
  return result;
}
