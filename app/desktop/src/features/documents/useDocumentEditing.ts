import { useState } from 'react';

/** The local draft of a Mac-hosted file: what the reader edits and what **Upload to Kordi** sends. */
export function useDocumentEditing(initialSource: string) {
  const [baseSource, setBaseSource] = useState(initialSource);
  const [draftSource, setDraftSource] = useState(initialSource);

  if (baseSource !== initialSource) {
    setBaseSource(initialSource);
    setDraftSource(initialSource);
  }

  return { draftSource, setDraftSource };
}
