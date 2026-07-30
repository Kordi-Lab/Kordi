import {
  useEffect,
} from 'react';
import type {
  CloudGroupControlEnvelope,
} from './cloudGroupMessages';
import {
  cloudGroupReplayKeyForRow,
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
  reportWarning: (message: string, error: unknown) => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    void coordinator.request({
      entries: messageIndex.replayRows.map((row) => ({
        key: cloudGroupReplayKeyForRow(row),
        row,
      })),
      apply: async (row) => {
        await applyControl(row.wire, row.envelope);
      },
      onFailure: ({ attempt, retryDelayMs, error }) => {
        const failure =
          error instanceof Error ? error.message : String(error);
        reportWarning(
          '[cloud-group] sync failed; retry scheduled',
          { attempt, retryDelayMs, failure, error },
        );
      },
    });
  }, [
    applyControl,
    coordinator,
    contextKey,
    enabled,
    messageIndex,
    reportWarning,
  ]);
}
