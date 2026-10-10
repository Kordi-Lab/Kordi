import { useEffect, useState } from 'react';

import { isMemoryForConversation, type ConversationMemoryScopes } from './conversationMemory';
import { MemoryList } from './MemoryList';
import type { MemoryClient } from './memoryClient';
import {
  memoryErrorMessage,
  syncStatusLabel,
  type MemoryLesson,
  type MemorySyncState,
} from './memoryModel';

/** A conversation's Memory tab: this account's memories saved for the chat, its group, or its project. */
export function ConversationMemoryPanel({ client, scopes }: { client: MemoryClient; scopes: ConversationMemoryScopes }) {
  const [lessons, setLessons] = useState<MemoryLesson[] | null>(null);
  const [sync, setSync] = useState<MemorySyncState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    client.listLessons().then(
      (next) => {
        if (!active) return;
        setLessons(next);
        setError(null);
      },
      (caught: unknown) => {
        if (active) setError(memoryErrorMessage(caught, 'Could not load memories.'));
      },
    );
    // A failed sync lookup only hides the caption.
    client.syncState().then((next) => { if (active) setSync(next); }, () => undefined);
    return () => { active = false; };
  }, [client]);

  const refreshSync = () => {
    client.syncState().then(setSync).catch(() => undefined);
  };

  const chatLessons = (lessons ?? []).filter((lesson) => isMemoryForConversation(lesson, scopes));

  return (
    <section aria-label="Memory" data-conversation-memory className="app-detail-section">
      {sync?.accountLabel ? <p className="m-0 mb-1 app-inspector-subtext">{syncStatusLabel(sync)}</p> : null}
      {error ? (
        <p role="alert" className="app-error-text m-0 py-2 text-[12px] leading-5">{error}</p>
      ) : lessons === null ? (
        <p role="status" className="m-0 py-2 app-inspector-subtext">Loading memory…</p>
      ) : (
        <MemoryList
          client={client}
          lessons={chatLessons}
          onLessonsChange={(update) => setLessons((current) => update(current ?? []))}
          emptyLabel="No memories yet."
          onChanged={refreshSync}
        />
      )}
    </section>
  );
}
