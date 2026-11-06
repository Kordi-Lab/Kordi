import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a copy shows its check and toast. */
export const COPY_FEEDBACK_MS = 1_500;

/**
 * Copies text and reports it for a short while: the copy icon becomes a
 * check and a "Link copied" toast shows. A failed copy throws to the caller.
 */
export function useCopyFeedback(durationMs = COPY_FEEDBACK_MS) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), durationMs);
  }, [durationMs]);
  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setCopied(false);
  }, []);
  return { copied, copy, reset };
}
