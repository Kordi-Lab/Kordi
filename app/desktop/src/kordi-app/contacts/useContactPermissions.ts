import { useCallback, useEffect, useRef, useState } from 'react';

import type { CloudContactPermissionFlags } from '@/features/cloud/contactProfileClient';
import type { ContactPermissionsHost } from './contactProfileHost';

export type ContactPermissionKey = keyof CloudContactPermissionFlags;

export type ContactPermissionsState = {
  /** Null until the flags are known; stays null when they cannot be loaded. */
  flags: CloudContactPermissionFlags | null;
  saving: Partial<Record<ContactPermissionKey, boolean>>;
  error: string;
  toggle: (key: ContactPermissionKey, next: boolean) => void;
};

/**
 * The viewer's restrictions for one person. Starts from the profile's flags when the server sent
 * them, otherwise loads them. A toggle shows at once and reverts when the save fails.
 */
export function useContactPermissions(
  accountId: string,
  initial: CloudContactPermissionFlags | null | undefined,
  host: ContactPermissionsHost,
): ContactPermissionsState {
  const [flags, setFlags] = useState<CloudContactPermissionFlags | null>(initial ?? null);
  const [saving, setSaving] = useState<Partial<Record<ContactPermissionKey, boolean>>>({});
  const [error, setError] = useState('');
  const hostRef = useRef(host);
  useEffect(() => { hostRef.current = host; });
  const hasInitial = Boolean(initial);

  useEffect(() => {
    if (hasInitial) return undefined;
    const controller = new AbortController();
    hostRef.current.load(accountId, controller.signal).then(
      (loaded) => { if (!controller.signal.aborted) setFlags(loaded); },
      () => undefined,
    );
    return () => controller.abort();
  }, [accountId, hasInitial]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const toggle = useCallback((key: ContactPermissionKey, next: boolean) => {
    setError('');
    setSaving((current) => ({ ...current, [key]: true }));
    setFlags((current) => (current ? { ...current, [key]: next } : current));
    hostRef.current.save(accountId, { [key]: next }).then(
      (saved) => {
        if (!mounted.current) return;
        setFlags((current) => (current ? { ...current, [key]: saved[key] } : saved));
      },
      (caught: unknown) => {
        if (!mounted.current) return;
        setFlags((current) => (current ? { ...current, [key]: !next } : current));
        setError(caught instanceof Error && caught.message ? caught.message : 'Could not save permissions.');
      },
    ).finally(() => {
      if (mounted.current) setSaving((current) => ({ ...current, [key]: false }));
    });
  }, [accountId]);

  return { flags, saving, error, toggle };
}
