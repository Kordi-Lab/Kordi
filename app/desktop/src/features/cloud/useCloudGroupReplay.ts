import {
  useEffect,
  useRef,
  type MutableRefObject,
} from 'react';
import {
  fetchExistingCanonicalMessageSources,
} from '@/features/canonical/canonicalMessageSources';
import {
  loadChatSyncConversations,
  loadChatSyncMessagesPage,
} from '@/lib/desktopChatSync';
import type { CloudGroupControlEnvelope } from './cloudGroupMessages';
import { parseCloudGroupControl } from './cloudGroupMessages';
import {
  cloudGroupReplayKeyForRow,
  canonicalMessageSourceKey,
  cloudGroupCanonicalMessageSource,
  cloudGroupReplayRowsAfterDurableHistory,
  type CloudMessageIndex,
  type IndexedCloudGroupRow,
} from './cloudMessageIndex';
import type { CloudMessage } from './authClient';
import { cloudMessageMetadataOnly } from './cloudMessageCache';
import { cloudMessageFromChatSync } from './chatSyncMapping';
import type { CanonicalSessionState } from '@/kordi-app/types';
import {
  cloudGroupTerminalRepairReplayKey,
  cloudGroupTerminalRepairReplayRows,
} from './cloudGroupTerminalRepair';
import type {
  CloudGroupReplayCoordinator,
} from './cloudGroupReplayCoordinator';

const NATIVE_GROUP_RECOVERY_PAGE_SIZE = 100;

async function recoverNativeCloudGroupHistory({
  accountId,
  applyControl,
  flushCanonicalState,
  shouldContinue,
}: {
  accountId: string;
  applyControl: (
    wire: CloudMessage,
    envelope: CloudGroupControlEnvelope,
  ) => Promise<void>;
  flushCanonicalState: () => void;
  shouldContinue: () => boolean;
}) {
  const conversations = await loadChatSyncConversations(accountId);
  for (const conversation of conversations) {
    if (!shouldContinue()) return;
    if (conversation.kind !== 'group') continue;
    let afterSequence: number | null = null;
    while (true) {
      const page = await loadChatSyncMessagesPage(
        accountId,
        conversation.id,
        afterSequence,
        NATIVE_GROUP_RECOVERY_PAGE_SIZE,
      );
      if (!page || !shouldContinue()) return;
      const rows = page.messages.flatMap((snapshot) => {
        const wire = cloudMessageMetadataOnly(
          cloudMessageFromChatSync(snapshot, conversation, accountId),
        );
        const envelope = parseCloudGroupControl(wire.body);
        return envelope ? [{ wire, envelope, canonicalMessageId: envelope.message?.id?.trim() || null }] : [];
      });
      const sources = rows.flatMap((row) => {
        const source = cloudGroupCanonicalMessageSource(row.wire, row.envelope);
        return source ? [source] : [];
      });
      const existingKeys = new Set(
        (sources.length > 0
          ? await fetchExistingCanonicalMessageSources(sources)
          : []
        ).map(canonicalMessageSourceKey),
      );
      let applied = false;
      for (const row of rows) {
        if (!shouldContinue()) return;
        const source = cloudGroupCanonicalMessageSource(row.wire, row.envelope);
        if (source && existingKeys.has(canonicalMessageSourceKey(source))) continue;
        await applyControl(row.wire, row.envelope);
        applied = true;
      }
      if (applied) flushCanonicalState();
      if (!page.hasMore) break;
      const next = page.nextAfterSequence;
      if (next === null || (afterSequence !== null && next <= afterSequence)) {
        throw new Error('Native group history did not advance its sequence cursor.');
      }
      afterSequence = next;
    }
  }
}

export function useCloudGroupReplay({
  accountId,
  enabled,
  contextKey,
  coordinator,
  messageIndex,
  canonicalStateRef,
  applyControl,
  flushCanonicalState,
  onSettled,
  reportWarning,
}: {
  accountId: string | null;
  enabled: boolean;
  contextKey: string | null;
  coordinator: CloudGroupReplayCoordinator<IndexedCloudGroupRow>;
  messageIndex: CloudMessageIndex;
  canonicalStateRef: MutableRefObject<CanonicalSessionState | null>;
  applyControl: (
    wire: CloudMessage,
    envelope: CloudGroupControlEnvelope,
  ) => Promise<void>;
  flushCanonicalState: () => void;
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
  const onSettledRef = useRef(onSettled);
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
    onSettledRef.current = onSettled;
    reportWarningRef.current = reportWarning;
  }, [applyControl, flushCanonicalState, onSettled, reportWarning]);
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
      const flushIfCurrent = () => {
        if (
          !mountedRef.current
          || !enabledRef.current
          || contextKeyRef.current !== cache.contextKey
          || durableSourceCacheRef.current !== cache
        ) return;
        flushCanonicalStateRef.current();
      };
      if (accountId && !cache.nativeHistoryRecovered) {
        cache.nativeHistoryRecovery ??= recoverNativeCloudGroupHistory({
          accountId,
          applyControl: (wire, envelope) => (
            applyControlRef.current(wire, envelope)
          ),
          flushCanonicalState: flushIfCurrent,
          shouldContinue: () => (
            mountedRef.current
            && enabledRef.current
            && contextKeyRef.current === cache.contextKey
            && durableSourceCacheRef.current === cache
          ),
        }).then(() => {
          if (durableSourceCacheRef.current === cache) {
            cache.nativeHistoryRecovered = true;
          }
        }).finally(() => {
          if (durableSourceCacheRef.current === cache) {
            cache.nativeHistoryRecovery = null;
          }
        });
        await cache.nativeHistoryRecovery;
      }
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
        onSettledRef.current?.();
        return;
      }
      if (entries.length === 0) {
        cache.lastReplaySignature = '';
        onSettledRef.current?.();
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
        && contextKeyRef.current === cache.contextKey
        && durableSourceCacheRef.current === cache
      ) {
        cache.lastReplaySignature = replaySignature;
        onSettledRef.current?.();
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
    contextKey,
    enabled,
    messageIndex,
  ]);
}
