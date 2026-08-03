import {
  useEffect,
  useRef,
} from 'react';
import {
  fetchExistingCanonicalMessageSources,
} from '@/features/canonical/canonicalMessageSources';
import type {
  CloudGroupControlEnvelope,
} from './cloudGroupMessages';
import {
  cloudGroupReplayKeyForRow,
  canonicalMessageSourceKey,
  cloudGroupCanonicalMessageSource,
  cloudGroupReplayRowsAfterDurableHistory,
  type CloudMessageIndex,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';
import type {
  CloudMessage,
} from './authClient';
import type {
  CloudGroupReplayCoordinator,
} from './cloudGroupReplayCoordinator';
export function useCloudGroupReplay({
  enabled,
  contextKey,
  coordinator,
  messageIndex,
  applyControl,
  flushCanonicalState,
  reportWarning,
}: {
  enabled: boolean;
  contextKey: string | null;
  coordinator: CloudGroupReplayCoordinator<IndexedCloudGroupRow>;
  messageIndex: CloudMessageIndex;
  applyControl: (
    wire: CloudMessage,
    envelope: CloudGroupControlEnvelope,
  ) => Promise<void>;
  flushCanonicalState: () => void;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const durableSourceCacheRef = useRef<{
    contextKey: string | null;
    checked: Set<string>;
    existing: Set<string>;
    inFlightBySource: Map<string, Promise<void>>;
    lastReplaySignature: string | null;
  }>({
    contextKey: null,
    checked: new Set(),
    existing: new Set(),
    inFlightBySource: new Map(),
    lastReplaySignature: null,
  });
  const applyControlRef = useRef(applyControl);
  const flushCanonicalStateRef = useRef(flushCanonicalState);
  const reportWarningRef = useRef(reportWarning);
  const mountedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const contextKeyRef = useRef(contextKey);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    enabledRef.current = enabled;
    contextKeyRef.current = contextKey;
  }, [contextKey, enabled]);
  useEffect(() => {
    applyControlRef.current = applyControl;
    flushCanonicalStateRef.current = flushCanonicalState;
    reportWarningRef.current = reportWarning;
  }, [applyControl, flushCanonicalState, reportWarning]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const cache = durableSourceCacheRef.current.contextKey === contextKey
      ? durableSourceCacheRef.current
      : {
          contextKey,
          checked: new Set<string>(),
          existing: new Set<string>(),
          inFlightBySource: new Map<string, Promise<void>>(),
          lastReplaySignature: null,
        };
    durableSourceCacheRef.current = cache;
    const sourcesByKey = new Map(
      messageIndex.replayRows.flatMap((row) => {
        const source = cloudGroupCanonicalMessageSource(row.wire, row.envelope);
        return source ? [[canonicalMessageSourceKey(source), source] as const] : [];
      }),
    );
    const run = async () => {
      const uncheckedEntries = [...sourcesByKey]
        .filter(([key]) => (
          !cache.checked.has(key)
          && !cache.inFlightBySource.has(key)
        ));
      if (uncheckedEntries.length > 0) {
        const uncheckedSources = uncheckedEntries.map(([, source]) => source);
        const lookup = fetchExistingCanonicalMessageSources(uncheckedSources)
          .then((existingSources) => {
            if (durableSourceCacheRef.current !== cache) return;
            for (const [key] of uncheckedEntries) cache.checked.add(key);
            for (const source of existingSources) {
              cache.existing.add(canonicalMessageSourceKey(source));
            }
          })
          .catch((error) => {
            if (durableSourceCacheRef.current !== cache) return;
            // A full replay is the safe fallback. Mark this batch checked so an
            // unrelated render cannot turn a transient native failure into a
            // tight retry loop; the coordinator still persists every row.
            for (const [key] of uncheckedEntries) cache.checked.add(key);
            reportWarningRef.current(
              '[cloud-group] durable replay lookup failed; using full replay',
              error,
            );
          });
        const trackedLookup = lookup.finally(() => {
            for (const [key] of uncheckedEntries) {
              if (cache.inFlightBySource.get(key) === trackedLookup) {
                cache.inFlightBySource.delete(key);
              }
            }
          });
        for (const [key] of uncheckedEntries) {
          cache.inFlightBySource.set(key, trackedLookup);
        }
      }
      const pendingLookups = new Set<Promise<void>>();
      for (const key of sourcesByKey.keys()) {
        const lookup = cache.inFlightBySource.get(key);
        if (lookup) pendingLookups.add(lookup);
      }
      if (pendingLookups.size > 0) {
        await Promise.all(pendingLookups);
      }
      if (!active || durableSourceCacheRef.current !== cache) return;
      const replayRows = cloudGroupReplayRowsAfterDurableHistory(
        messageIndex.replayRows,
        cache.existing,
      );
      const replaySignature = replayRows
        .map(cloudGroupReplayKeyForRow)
        .join('\n');
      if (cache.lastReplaySignature === replaySignature) return;
      if (replayRows.length === 0) {
        cache.lastReplaySignature = replaySignature;
        return;
      }
      const flushIfCurrent = () => {
        if (
          !mountedRef.current
          || !enabledRef.current
          || contextKeyRef.current !== cache.contextKey
          || durableSourceCacheRef.current !== cache
        ) return;
        flushCanonicalStateRef.current();
      };
      await coordinator.request({
        entries: replayRows.map((row) => ({
          key: cloudGroupReplayKeyForRow(row),
          row,
        })),
        apply: async (row) => {
          await applyControlRef.current(row.wire, row.envelope);
        },
        // A replay effect is routinely superseded while its native drain is
        // active. Publish from the coordinator's successful batch instead of
        // the stale effect lifetime, including delayed retry success.
        onApplied: flushIfCurrent,
        onFailure: ({ attempt, retryDelayMs, error }) => {
          const failure =
            error instanceof Error ? error.message : String(error);
          reportWarningRef.current(
            '[cloud-group] sync failed; retry scheduled',
            { attempt, retryDelayMs, failure, error },
          );
        },
      });
      if (
        mountedRef.current
        && enabledRef.current
        && contextKeyRef.current === cache.contextKey
        && durableSourceCacheRef.current === cache
      ) {
        cache.lastReplaySignature = replaySignature;
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [
    coordinator,
    contextKey,
    enabled,
    messageIndex,
  ]);
}
