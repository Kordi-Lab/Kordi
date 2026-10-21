import { useCallback, useEffect, useRef, useState } from 'react';

import type { CloudAccount, CloudProfileUpdateInput } from '@/features/cloud/authClient';
import {
  canonicalAvatarImageSource,
  generatedAvatarPreviewUrl,
  newCanonicalAvatarSeed,
  type CanonicalAvatarMutation,
} from '@/features/cloud/canonicalAvatar';
import {
  cloudProfileErrorTarget,
  cloudProfileFieldDraft,
  cloudProfileIsDirty,
  cloudProfileSaveInput,
  type CloudProfileErrorTarget,
  type CloudProfileField,
  type CloudProfileFieldDraft,
} from './cloudProfileDraft';

type ProfileErrors = Partial<Record<CloudProfileErrorTarget, string>>;

function errorMessage(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

export function useCloudProfileEditor({
  account,
  onUpdateProfile,
}: {
  account: CloudAccount | null;
  onUpdateProfile: (input: CloudProfileUpdateInput) => Promise<void>;
}) {
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [fieldDraft, setFieldDraft] = useState<CloudProfileFieldDraft>(() => cloudProfileFieldDraft(null));
  const [avatarUrlDraft, setAvatarUrlDraft] = useState('');
  const [avatarMutationDraft, setAvatarMutationDraft] = useState<CanonicalAvatarMutation | null>(null);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  // After a save, the next account payload carries the server's normalized values.
  const resyncAfterSaveRef = useRef(false);
  const accountRef = useRef(account);
  useEffect(() => { accountRef.current = account; }, [account]);

  const reset = useCallback((next: CloudAccount | null) => {
    resyncAfterSaveRef.current = false;
    setDisplayNameDraft(next?.displayName?.trim() || '');
    setFieldDraft(cloudProfileFieldDraft(next));
    setAvatarUrlDraft(next ? canonicalAvatarImageSource(next.avatar) ?? '' : '');
    setAvatarMutationDraft(null);
    setErrors({});
    setIsSaving(false);
    setIsSigningOut(false);
  }, []);

  useEffect(() => {
    if (!resyncAfterSaveRef.current || !account) return;
    setDisplayNameDraft(account.displayName?.trim() || '');
    setFieldDraft(cloudProfileFieldDraft(account));
  }, [account]);

  const clearError = (target: CloudProfileErrorTarget) => {
    setErrors((current) => (current[target] || current.form ? { ...current, [target]: undefined, form: undefined } : current));
  };

  const setDisplayName = (value: string) => {
    resyncAfterSaveRef.current = false;
    setDisplayNameDraft(value);
    clearError('displayName');
  };

  const setField = (field: CloudProfileField, value: string) => {
    resyncAfterSaveRef.current = false;
    setFieldDraft((current) => ({ ...current, [field]: value }));
    clearError(field);
  };

  const isDirty = cloudProfileIsDirty({ account, displayNameDraft, avatarMutationDraft, fieldDraft });

  const save = async () => {
    if (isSaving || !account) return;
    if (!displayNameDraft.trim()) {
      setErrors({ displayName: 'Enter a display name.' });
      return;
    }
    try {
      setIsSaving(true);
      setErrors({});
      await onUpdateProfile(cloudProfileSaveInput({
        displayNameDraft,
        avatarMutationDraft,
        fieldDraft,
        savedFields: cloudProfileFieldDraft(account),
      }));
      setAvatarMutationDraft(null);
      resyncAfterSaveRef.current = true;
      const latest = accountRef.current;
      if (latest) {
        setDisplayNameDraft(latest.displayName?.trim() || '');
        setFieldDraft(cloudProfileFieldDraft(latest));
      }
    } catch (caught) {
      setErrors({ [cloudProfileErrorTarget(caught)]: errorMessage(caught, 'Could not save profile.') });
    } finally {
      setIsSaving(false);
    }
  };

  const uploadAvatar = (dataUrl: string) => {
    if (!account) return;
    setAvatarUrlDraft(dataUrl);
    setAvatarMutationDraft({ action: 'upload', uploadedAsset: dataUrl, expectedVersion: account.avatar.version });
    clearError('form');
  };

  const generateAvatar = () => {
    if (!account) return;
    const seed = newCanonicalAvatarSeed();
    const previewUrl = generatedAvatarPreviewUrl(account.avatar.style, seed);
    if (!previewUrl) {
      setErrors({ form: 'Could not create a random avatar.' });
      return;
    }
    setAvatarUrlDraft(previewUrl);
    setAvatarMutationDraft({ action: 'regenerate', seed, expectedVersion: account.avatar.version });
    clearError('form');
  };

  const signOut = async (onSignOut: (() => Promise<void> | void) | undefined, onDone: () => void) => {
    if (!onSignOut || isSigningOut) return;
    try {
      setIsSigningOut(true);
      setErrors({});
      await onSignOut();
      onDone();
    } catch (caught) {
      setErrors({ form: errorMessage(caught, 'Could not sign out.') });
      setIsSigningOut(false);
    }
  };

  return {
    displayNameDraft, fieldDraft, avatarUrlDraft, errors, isSaving, isSigningOut, isDirty,
    reset, setDisplayName, setField, save, uploadAvatar, generateAvatar, signOut,
  };
}

export type CloudProfileEditor = ReturnType<typeof useCloudProfileEditor>;
