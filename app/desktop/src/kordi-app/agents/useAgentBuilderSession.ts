import { useCallback, useEffect, useRef, useState } from 'react';

import {
  cancelDesktopChatTurn,
  discardDesktopAgentBuilderDraft,
  fetchDesktopAgentBuilderStatus,
  fetchDesktopChatSessionDetail,
  fetchDesktopChatTurnState,
  markDesktopAgentBuilderPublished,
  openDesktopAgentBuilder,
  readDesktopAgentBuilderFile,
  startDesktopChatMessage,
  testDesktopAgentBuilderDraft,
  updateDesktopAgentBuilderDraft,
  writeDesktopAgentBuilderFile,
  type DesktopAgentBuilderDraft,
  type DesktopAgentBuilderSeed,
  type DesktopAgentBuilderStatus,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import type { DesktopChatSessionDetail, DesktopChatTurnSnapshot } from '../types';
import type { AttachmentItem } from '@/features/chat/composerController.types';

const TURN_POLL_INTERVAL_MS = 160;

function isNativeDesktopShell() {
  return typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

export function useAgentBuilderSession({
  targetKey,
  seed,
  seedKey,
  enabled = true,
}: {
  targetKey: string;
  seed: DesktopAgentBuilderSeed;
  seedKey: string;
  enabled?: boolean;
}) {
  const [status, setStatus] = useState<DesktopAgentBuilderStatus | null>(null);
  const [detail, setDetail] = useState<DesktopChatSessionDetail | null>(null);
  const [activeTurn, setActiveTurn] = useState<DesktopChatTurnSnapshot | null>(null);
  const [optimisticPrompt, setOptimisticPrompt] = useState<string | null>(null);
  const [optimisticAttachments, setOptimisticAttachments] = useState<AttachmentItem[]>([]);
  const [opening, setOpening] = useState(false);
  const [testing, setTesting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const statusRef = useRef<DesktopAgentBuilderStatus | null>(null);
  const updateQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingUpdatesRef = useRef(0);

  const commitStatus = useCallback((next: DesktopAgentBuilderStatus | null) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const refresh = useCallback(async (currentStatus = status) => {
    if (!currentStatus) return null;
    const [nextStatus, nextDetail] = await Promise.all([
      fetchDesktopAgentBuilderStatus(currentStatus.draftId),
      fetchDesktopChatSessionDetail(currentStatus.sessionId),
    ]);
    commitStatus(nextStatus);
    setDetail(nextDetail);
    return nextStatus;
  }, [commitStatus, status]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setActiveTurn(null);
    setOptimisticPrompt(null);
    setOptimisticAttachments([]);
    setError(null);
    statusRef.current = null;
    updateQueueRef.current = Promise.resolve();
    pendingUpdatesRef.current = 0;
    setUpdating(false);

    if (!enabled || !isNativeDesktopShell()) {
      setOpening(false);
      commitStatus(null);
      setDetail(null);
      setError('Kordi Factory requires the Kordi desktop runtime.');
      return undefined;
    }

    setOpening(true);
    void openDesktopAgentBuilder(targetKey, seed)
      .then((result) => {
        if (!result || generationRef.current !== generation) return;
        commitStatus(result.status);
        setDetail(result.session);
      })
      .catch((openError) => {
        if (generationRef.current !== generation) return;
        setError(errorMessage(openError, 'Unable to open Kordi Factory.'));
        commitStatus(null);
        setDetail(null);
      })
      .finally(() => {
        if (generationRef.current === generation) setOpening(false);
      });

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [commitStatus, enabled, seedKey, targetKey]);

  const send = useCallback(async (
    rawText: string,
    attachments: AttachmentItem[] = [],
    route: DesktopChatMessageRoute | null = null,
  ) => {
    const text = rawText.trim();
    if ((!text && attachments.length === 0) || !status || activeTurn || opening) return;
    const generation = generationRef.current;
    setError(null);
    setOptimisticPrompt(text);
    setOptimisticAttachments(attachments);
    try {
      let turn = await startDesktopChatMessage(
        status.sessionId,
        text,
        attachments.map((attachment) => attachment.path),
        route,
      );
      if (generationRef.current !== generation) return;
      setActiveTurn(turn);
      while (!turn.completed && generationRef.current === generation) {
        await wait(TURN_POLL_INTERVAL_MS);
        turn = await fetchDesktopChatTurnState(turn.id);
        if (generationRef.current === generation) setActiveTurn(turn);
      }
      if (generationRef.current !== generation) return;
      await refresh(status);
      setOptimisticPrompt(null);
      setOptimisticAttachments([]);
      if (!turn.succeeded && turn.error) setError(turn.error);
    } catch (sendError) {
      if (generationRef.current !== generation) return;
      setError(errorMessage(sendError, 'Kordi Factory could not complete the request.'));
      try {
        await refresh(status);
      } catch {
        // Preserve the original request error.
      }
      setOptimisticPrompt(null);
      setOptimisticAttachments([]);
    } finally {
      if (generationRef.current === generation) setActiveTurn(null);
    }
  }, [activeTurn, opening, refresh, status]);

  const stop = useCallback(async () => {
    if (!activeTurn) return;
    try {
      const next = await cancelDesktopChatTurn(activeTurn.id);
      setActiveTurn(next);
    } catch (cancelError) {
      setError(errorMessage(cancelError, 'Unable to stop the active Kordi Factory turn.'));
    }
  }, [activeTurn]);

  const testDraft = useCallback(async () => {
    if (testing) return null;
    setTesting(true);
    setError(null);
    try {
      await updateQueueRef.current;
      const currentStatus = statusRef.current;
      if (!currentStatus) return null;
      const next = await testDesktopAgentBuilderDraft(currentStatus.draftId);
      commitStatus(next);
      return next;
    } catch (testError) {
      setError(errorMessage(testError, 'Unable to test the agent draft.'));
      return null;
    } finally {
      setTesting(false);
    }
  }, [commitStatus, testing]);

  const updateDraft = useCallback((update: DesktopAgentBuilderDraft | ((current: DesktopAgentBuilderDraft) => DesktopAgentBuilderDraft)) => {
    const generation = generationRef.current;
    pendingUpdatesRef.current += 1;
    setUpdating(true);
    const run = async () => {
      try {
        const currentStatus = statusRef.current;
        const currentDraft = currentStatus?.draft;
        if (!currentStatus || !currentDraft || generationRef.current !== generation) return null;
        setError(null);
        const draft = typeof update === 'function' ? update(currentDraft) : update;
        const next = await updateDesktopAgentBuilderDraft(currentStatus.draftId, draft);
        if (generationRef.current !== generation) return null;
        commitStatus(next);
        return next;
      } catch (updateError) {
        if (generationRef.current === generation) {
          setError(errorMessage(updateError, 'Unable to update the agent draft.'));
        }
        return null;
      } finally {
        pendingUpdatesRef.current = Math.max(0, pendingUpdatesRef.current - 1);
        if (generationRef.current === generation) {
          setUpdating(pendingUpdatesRef.current > 0);
        }
      }
    };
    const result = updateQueueRef.current.then(run, run);
    updateQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, [commitStatus]);

  const markPublished = useCallback(async () => {
    await updateQueueRef.current;
    const currentStatus = statusRef.current;
    if (!currentStatus) return null;
    const next = await markDesktopAgentBuilderPublished(currentStatus.draftId);
    commitStatus(next);
    return next;
  }, [commitStatus]);

  const readFile = useCallback(async (path: string) => {
    if (!status) throw new Error('Kordi Factory draft is unavailable.');
    return readDesktopAgentBuilderFile(status.draftId, path);
  }, [status]);

  const writeFile = useCallback(async (path: string, content: string) => {
    if (!status) throw new Error('Kordi Factory draft is unavailable.');
    const next = await writeDesktopAgentBuilderFile(status.draftId, path, content);
    commitStatus(next);
    return next;
  }, [commitStatus, status]);

  const discard = useCallback(async () => {
    if (!status) return;
    await discardDesktopAgentBuilderDraft(status.draftId);
    commitStatus(null);
    setDetail(null);
    setActiveTurn(null);
    setOptimisticPrompt(null);
    setOptimisticAttachments([]);
  }, [commitStatus, status]);

  return {
    status,
    detail,
    activeTurn,
    optimisticPrompt,
    optimisticAttachments,
    opening,
    testing,
    updating,
    error,
    send,
    stop,
    refresh,
    updateDraft,
    testDraft,
    markPublished,
    readFile,
    writeFile,
    discard,
  };
}
