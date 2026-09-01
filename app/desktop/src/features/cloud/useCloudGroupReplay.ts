import {
  useEffect,
  useReducer,
  useRef,
  type MutableRefObject,
} from 'react';
import { fetchExistingCanonicalMessageSources } from '@/features/canonical/canonicalMessageSources';
import type { CloudGroupControlEnvelope } from './cloudGroupMessages';
import {
  cloudGroupReplayKeyForRow,
  canonicalMessageSourceKey,
  cloudGroupCanonicalMessageSource,
  cloudGroupReplayRowsAfterDurableHistory,
  type CloudMessageIndex,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';
import type { CloudMessage } from './authClient';
import { recoverNativeCloudGroupHistory } from './cloudGroupNativeRecovery';
import type { CanonicalSessionState } from '@/kordi-app/types';
import { isNativeDesktopShell } from '@/lib/desktop';
import {
  cloudGroupTerminalRepairReplayKey,
  cloudGroupTerminalRepairReplayRows,
} from './cloudGroupTerminalRepair';
import type {
  CloudGroupReplayCoordinator,
} from './cloudGroupReplayCoordinator';

export function useCloudGroupReplay({
  accountId,
  prioritySessionId,
  enabled,
  contextKey,
  coordinator,
  messageIndex,
  canonicalStateRef,
  applyControl,
  flushCanonicalState,
  onNativeHistorySettled,
  onSessionSettled,
  onSettled,
  reportWarning,
}: {
  accountId: string | null;
  prioritySessionId?: string | null;
  enabled: boolean;
  contextKey: string | null;
  coordinator: CloudGroupReplayCoordinator<IndexedCloudGroupRow>;
  messageIndex: CloudMessageIndex;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  applyControl: (
    wire: CloudMessage,
    envelope: CloudGroupControlEnvelope,
    options?: { deferPublish?: boolean; historyReplay?: boolean },
  ) => Promise<void>;
  flushCanonicalState: () => void;
  onNativeHistorySettled?: () => void;
  onSessionSettled?: (sessionId: string) => void;
  onSettled?: () => void;
  reportWarning: (message: string, error: unknown) => void;
}) {
  const durableSourceCacheRef = useRef<{
    contextKey: string | null;
    checked: Set<string>;
    existing: Set<string>;
    inFlightBySource: Map<string, Promise<void>>;
    lastReplaySignature: string | null;
    nativeHistoryRecovered: boolean;
    nativeHistoryRecovery: Promise<void> | null;
  }>({
    contextKey: null,
    checked: new Set(),
    existing: new Set(),
    inFlightBySource: new Map(),
    lastReplaySignature: null,
    nativeHistoryRecovered: false,
    nativeHistoryRecovery: null,
  });
  const applyControlRef = useRef(applyControl);
  const flushCanonicalStateRef = useRef(flushCanonicalState);
  const onNativeHistorySettledRef = useRef(onNativeHistorySettled);
  const onSessionSettledRef = useRef(onSessionSettled);
  const onSettledRef = useRef(onSettled);
  const reportWarningRef = useRef(reportWarning);
  const mountedRef = useRef(false);
  const enabledRef = useRef(enabled);
  const recoveryContextKey = contextKey
    ? `${contextKey}\u0000${prioritySessionId?.trim() ?? ''}`
    : null;
  const recoveryContextKeyRef = useRef(recoveryContextKey);
  const [nativeRecoveryRevision, retryNativeRecovery] = useReducer(
    (revision: number) => revision + 1,
    0,
  );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    enabledRef.current = enabled;
    recoveryContextKeyRef.current = recoveryContextKey;
  }, [enabled, recoveryContextKey]);
  useEffect(() => {
    applyControlRef.current = applyControl;
    flushCanonicalStateRef.current = flushCanonicalState;
    onNativeHistorySettledRef.current = onNativeHistorySettled;
    onSessionSettledRef.current = onSessionSettled;
    onSettledRef.current = onSettled;
    reportWarningRef.current = reportWarning;
  }, [applyControl, flushCanonicalState, onNativeHistorySettled, onSessionSettled, onSettled, reportWarning]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const cache = durableSourceCacheRef.current.contextKey === recoveryContextKey
      ? durableSourceCacheRef.current
      : {
          contextKey: recoveryContextKey,
          checked: new Set<string>(),
          existing: new Set<string>(),
          inFlightBySource: new Map<string, Promise<void>>(),
          lastReplaySignature: null,
          nativeHistoryRecovered: false,
          nativeHistoryRecovery: null,
        };
    durableSourceCacheRef.current = cache;
    const sourcesByKey = new Map(
      messageIndex.replayRows.flatMap((row) => {
        const source = cloudGroupCanonicalMessageSource(row.wire, row.envelope);
        return source ? [[canonicalMessageSourceKey(source), source] as const] : [];
      }),
    );
    const run = async () => {
      const nativeShell = isNativeDesktopShell();
      const flushIfCurrent = () => {
        if (
          !mountedRef.current
          || !enabledRef.current
          || recoveryContextKeyRef.current !== cache.contextKey
          || durableSourceCacheRef.current !== cache
        ) return;
        flushCanonicalStateRef.current();
      };
      const recoverNativeHistory = async () => {
        if (!nativeShell) return true;
        if (!accountId) return false;
        if (!cache.nativeHistoryRecovered) {
          const retry = () => {
            if (durableSourceCacheRef.current !== cache) return;
            globalThis.setTimeout(() => {
              if (mountedRef.current && durableSourceCacheRef.current === cache) {
                retryNativeRecovery();
              }
            }, 1_000);
          };
          const recovery = recoverNativeCloudGroupHistory({
              accountId,
              prioritySessionId,
              applyControl: (wire, envelope, options) => (
                applyControlRef.current(wire, envelope, options)
              ),
              flushCanonicalState: flushIfCurrent,
              onSessionSettled: (sessionId) => {
                if (durableSourceCacheRef.current === cache) {
                  onSessionSettledRef.current?.(sessionId);
                }
              },
              shouldContinue: () => (
                mountedRef.current
                && enabledRef.current
                && recoveryContextKeyRef.current === cache.contextKey
                && durableSourceCacheRef.current === cache
              ),
            });
          cache.nativeHistoryRecovery ??= recovery.then((recovered) => {
            if (recovered && durableSourceCacheRef.current === cache) {
              cache.nativeHistoryRecovered = true;
              onNativeHistorySettledRef.current?.();
            } else {
              retry();
            }
          }).catch((error) => {
            reportWarningRef.current(
              '[cloud-group] native history recovery failed',
              error,
            );
            retry();
          }).finally(() => {
            if (durableSourceCacheRef.current === cache) {
              cache.nativeHistoryRecovery = null;
            }
          });
          await cache.nativeHistoryRecovery;
        }
        return cache.nativeHistoryRecovered;
      };
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
      const terminalRepairRows = cloudGroupTerminalRepairReplayRows(
        messageIndex.replayRows,
        canonicalStateRef.current?.messages ?? [],
      );
      const terminalRepairRowSet = new Set(terminalRepairRows);
      const entries = [
        ...replayRows
          .filter((row) => !terminalRepairRowSet.has(row))
          .map((row) => ({
            key: cloudGroupReplayKeyForRow(row),
            row,
          })),
        ...terminalRepairRows.map((row) => ({
          // A normal replay key may already be completed because this response
          // is durable. Repair the stale in-memory processing slot through a
          // separate monotonic coordinator key.
          key: cloudGroupTerminalRepairReplayKey(row),
          row,
        })),
      ];
      const replaySignature = entries.map(({ key }) => key).join('\n');
      if (cache.lastReplaySignature === replaySignature) {
        if (await recoverNativeHistory()) onSettledRef.current?.();
        return;
      }
      if (entries.length === 0) {
        cache.lastReplaySignature = '';
        if (await recoverNativeHistory()) onSettledRef.current?.();
        return;
      }
      await coordinator.request({
        entries,
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
        && recoveryContextKeyRef.current === cache.contextKey
        && durableSourceCacheRef.current === cache
      ) {
        cache.lastReplaySignature = replaySignature;
        if (await recoverNativeHistory()) onSettledRef.current?.();
      }
    };
    void run().catch((error) => {
      reportWarningRef.current(
        '[cloud-group] native history recovery failed',
        error,
      );
    });
    return () => {
      active = false;
    };
  }, [
    coordinator,
    canonicalStateRef,
    accountId,
    enabled,
    messageIndex,
    nativeRecoveryRevision,
    prioritySessionId,
    recoveryContextKey,
  ]);
}
