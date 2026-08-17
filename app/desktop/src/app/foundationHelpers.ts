import type { MutableRefObject } from 'react';

export type LocalAvatarSeeds = {
  human?: string | null;
  humanDisplayName?: string | null;
  humanProfileImageUrl?: string | null;
  agent?: string | null;
  agentDisplayName?: string | null;
};

export function assignLocalAvatarSeeds(
  ref: MutableRefObject<LocalAvatarSeeds>,
  seeds: LocalAvatarSeeds,
) {
  Object.assign(ref.current, seeds);
}
