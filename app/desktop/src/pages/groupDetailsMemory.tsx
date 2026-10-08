import { useEffect, useMemo, useState } from 'react';

import { groupMemoryScopeIds, isMemoryForGroup } from '@/features/memory/groupMemory';
import { MemoryList } from '@/features/memory/MemoryList';
import type { MemoryClient } from '@/features/memory/memoryClient';
import { memoryErrorMessage, type MemoryLesson } from '@/features/memory/memoryModel';
import type { ParticipantSpaceViewModel } from '@/kordi-app/types';

const mutedText = 'text-[color:var(--app-transient-muted-text)]';

/** The group dialog's Memory view: this account's memories saved in this group. */
export function GroupDetailsMemory({ client, space }: { client: MemoryClient; space: ParticipantSpaceViewModel }) {
  const scopeIds = useMemo(() => groupMemoryScopeIds(space), [space]);
  const [lessons, setLessons] = useState<MemoryLesson[] | null>(null);
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
        if (active) setError(memoryErrorMessage(caught, 'Could not load memories for this group.'));
      },
    );
    return () => { active = false; };
  }, [client]);

  const groupLessons = (lessons ?? []).filter((lesson) => isMemoryForGroup(lesson, scopeIds));

  return (
    <section aria-label="Group memory" data-group-memory className="px-1.5">
      <p className={`m-0 text-[10px] leading-4 ${mutedText}`}>
        What Kordi remembers in this group. Only you can see your own memories.
      </p>
      <div className="mt-2">
        {error ? (
          <p role="alert" className="app-group-management-error m-0 rounded-[11px] px-2.5 py-2 text-[11px] leading-4">{error}</p>
        ) : lessons === null ? (
          <p role="status" className={`m-0 py-2 text-[11px] ${mutedText}`}>Loading memory…</p>
        ) : (
          <MemoryList
            client={client}
            lessons={groupLessons}
            onLessonsChange={(update) => setLessons((current) => update(current ?? []))}
            emptyLabel="No memories for this group yet."
            compact
          />
        )}
      </div>
    </section>
  );
}
