import { useCallback, useEffect, useState } from 'react';

import {
  fetchDesktopSkillLibrary,
  removeDesktopSkillLibraryEntry,
  setDesktopSkillLibraryEnabled,
  type DesktopSkillLibraryEntry,
} from '@/lib/desktop';

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export function useSkillLibrary() {
  const [skills, setSkills] = useState<DesktopSkillLibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutatingSkillId, setMutatingSkillId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchDesktopSkillLibrary();
      setSkills(next);
      return next;
    } catch (loadError) {
      setError(errorMessage(loadError, 'Kordi could not load the installed skill library.'));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setEnabled = useCallback(async (skill: DesktopSkillLibraryEntry, enabled: boolean) => {
    setMutatingSkillId(skill.id);
    setError(null);
    try {
      const next = await setDesktopSkillLibraryEnabled(skill.name, enabled);
      setSkills(next);
      return next.find((entry) => entry.id === skill.id) ?? null;
    } catch (mutationError) {
      setError(errorMessage(mutationError, `Kordi could not ${enabled ? 'enable' : 'disable'} ${skill.name}.`));
      return null;
    } finally {
      setMutatingSkillId(null);
    }
  }, []);

  const remove = useCallback(async (skill: DesktopSkillLibraryEntry) => {
    setMutatingSkillId(skill.id);
    setError(null);
    try {
      const next = await removeDesktopSkillLibraryEntry(skill.id);
      setSkills(next);
      return true;
    } catch (mutationError) {
      setError(errorMessage(mutationError, `Kordi could not remove ${skill.name}.`));
      return false;
    } finally {
      setMutatingSkillId(null);
    }
  }, []);

  return {
    skills,
    setSkills,
    loading,
    error,
    mutatingSkillId,
    refresh,
    setEnabled,
    remove,
  };
}
