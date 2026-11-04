import { useCallback, useState } from 'react';

export function useCompanionDocumentLabels() {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const setTitle = useCallback((id: string, title: string) => {
    setTitles((current) => (current[id] === title ? current : { ...current, [id]: title }));
  }, []);
  const [renames, setRenames] = useState<Record<string, (title: string) => void>>({});
  const setRename = useCallback((id: string, rename: ((title: string) => void) | null) => {
    setRenames((current) => {
      if ((current[id] ?? null) === rename) return current;
      const next = { ...current };
      if (rename) next[id] = rename;
      else delete next[id];
      return next;
    });
  }, []);
  return { titles, renames, setTitle, setRename };
}
