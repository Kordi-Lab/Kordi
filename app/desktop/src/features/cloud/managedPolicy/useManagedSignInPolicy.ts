import { useEffect, useState } from 'react';

import {
  loadManagedSignInPolicy,
  peekManagedSignInPolicy,
  type ManagedSignInPolicy,
} from './managedSignInPolicy';

/** The managed sign-in policy, or undefined while the native shell reports it. */
export function useManagedSignInPolicy(): ManagedSignInPolicy | undefined {
  const [policy, setPolicy] = useState<ManagedSignInPolicy | undefined>(peekManagedSignInPolicy);
  useEffect(() => {
    let active = true;
    void loadManagedSignInPolicy().then((next) => { if (active) setPolicy(next); });
    return () => { active = false; };
  }, []);
  return policy;
}
