import {useCallback, useEffect, useMemo, useState} from 'react';
import {CloudAuthClient} from './authClient';
import {loadSession} from './session';
import {mergeThreadReads} from '@/features/chat/threadReadState';

export function useThreadReadStatus(sessionId: string, accountId: string | undefined, enabled: boolean) {
  const client = useMemo(() => new CloudAuthClient(), []);
  const scope = `${accountId ?? ''}:${sessionId}`;
  const [state, setState] = useState<{scope:string; reads:Record<string,number>} | null>(null);
  useEffect(() => {
    if (!accountId || !enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const session = await loadSession();
        if (session?.accountId !== accountId) return;
        const reads = await client.threadReads(session.token, sessionId);
        if (cancelled || (await loadSession())?.accountId !== accountId) return;
        setState(current => {
          const next = mergeThreadReads(current?.scope === scope ? current.reads : {}, reads);
          return current?.scope === scope && next === current.reads ? current : {scope, reads:next};
        });
      } catch {
        // Preserve the last confirmed read cursor and retry after reconnecting.
      }
      if (!cancelled) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [accountId, client, enabled, scope, sessionId]);

  const markRead = useCallback(async (rootId: string, sequence: number) => {
    const session = await loadSession();
    if (!accountId || session?.accountId !== accountId) return;
    const read = await client.markThreadRead(session.token, sessionId, rootId, sequence);
    if ((await loadSession())?.accountId !== accountId) return;
    setState(current => {
      if (current?.scope !== scope) return current;
      const reads = mergeThreadReads(current.reads,[read]);
      return reads === current.reads ? current : {scope,reads};
    });
  }, [accountId, client, scope, sessionId]);
  return {reads:state?.scope === scope ? state.reads : null, markRead};
}
