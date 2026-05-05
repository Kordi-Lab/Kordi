import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { listen } from '@tauri-apps/api/event';

import {
  DEFAULT_BRIDGE_DISPLAY_NAME,
  DEFAULT_BRIDGE_OWNER_NAME,
} from '@/features/bridge/constants';
import {
  BRIDGE_READ_ATTENTION_EVENTS,
  activeUnreadBridgeConversationsForSession,
  bridgeReadReceiptBatchSignature,
  canAutoMarkBridgeRead,
} from '@/features/bridge/readReceipts';
import {
  shouldRefreshBridgeRealtimeForVisibility,
  shouldRunBridgeRealtimeRecovery,
} from '@/features/bridge/realtimeRecovery';
import type {
  DesktopBridgeConversation,
  DesktopBridgeConversationMessage,
  DesktopBridgeInvite,
  DesktopBridgeState,
  NavId,
} from '@/kordi-app/types';
import {
  exportDesktopBridgeHostsConfig,
  fetchDesktopBridgeState,
  importDesktopBridgeHostsConfig,
  markDesktopBridgeConversationRead,
  openDesktopBridgeConfigFolder,
  pollDesktopBridgeMailbox,
  refreshDesktopBridgeRealtimeConnections,
  removeDesktopBridgeHost,
  revealDesktopBridgeStorageFile,
  saveDesktopBridgeHost,
  sendDesktopBridgePresence,
  setDesktopActiveBridgeHost,
} from '@/lib/desktop';
import { createSingleFlightState, requestSingleFlightRun } from '@/lib/singleFlight';

type UseBridgeStateArgs = {
  isNativeShell: boolean;
  activeNav: NavId;
  activeConvId: string;
  activeConversationIsBridge: boolean;
  composerChatText: string;
  shouldAutoFollowChatRef: MutableRefObject<boolean>;
};

type BridgeSettingsDraft = {
  hostId?: string | null;
  serverUrl: string;
  displayName: string;
  ownerName: string;
};

export type BridgeMailboxPollTrigger = 'startup' | 'focus' | 'pageshow' | 'visibilitychange' | 'routine';

const BRIDGE_MAILBOX_PROGRESS_DELAY_MS = 600;
const BRIDGE_MAILBOX_PROGRESS_COOLDOWN_MS = 15_000;

export function shouldShowBridgeMailboxPollProgress(
  trigger: BridgeMailboxPollTrigger,
  nowMs: number,
  lastShownAtMs: number,
) {
  if (trigger === 'routine') return false;
  return lastShownAtMs <= 0 || nowMs - lastShownAtMs >= BRIDGE_MAILBOX_PROGRESS_COOLDOWN_MS;
}

type BridgeDraftHost = {
  id?: string | null;
  serverUrl?: string | null;
  displayName?: string | null;
  ownerName?: string | null;
};

function createBridgeSettingsDraft(host: BridgeDraftHost | null | undefined): BridgeSettingsDraft {
  return {
    hostId: host?.id ?? null,
    serverUrl: host?.serverUrl ?? '',
    displayName: host?.displayName ?? DEFAULT_BRIDGE_DISPLAY_NAME,
    ownerName: host?.ownerName ?? DEFAULT_BRIDGE_OWNER_NAME,
  };
}

function createBridgeWizardDraft(
  host: BridgeDraftHost | null | undefined,
  mode: 'have-url' | 'need-host' = 'have-url',
) {
  return {
    mode,
    serverUrl: host?.serverUrl ?? '',
    displayName: host?.displayName ?? DEFAULT_BRIDGE_DISPLAY_NAME,
    ownerName: host?.ownerName ?? DEFAULT_BRIDGE_OWNER_NAME,
  };
}

function isBridgeSettingsDraft(value: unknown): value is BridgeSettingsDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  return typeof draft.serverUrl === 'string'
    && typeof draft.displayName === 'string'
    && typeof draft.ownerName === 'string';
}

function mergeBridgeMessage(
  current: DesktopBridgeConversationMessage,
  next: DesktopBridgeConversationMessage,
): DesktopBridgeConversationMessage {
  const currentText = current.text ?? '';
  const nextText = next.text ?? '';
  const shouldKeepCurrentText = next.deliveryState === 'processing'
    && currentText.length > nextText.length;

  return {
    ...current,
    ...next,
    text: shouldKeepCurrentText ? currentText : nextText,
    timeLabel: next.timeLabel || current.timeLabel,
    timestampMs: Math.max(current.timestampMs, next.timestampMs),
    deliveryState: next.deliveryState ?? current.deliveryState,
  };
}

function mergeConversationMessages(
  current: DesktopBridgeConversationMessage[],
  next: DesktopBridgeConversationMessage[],
) {
  const currentById = new Map(current.map((message) => [message.id, message]));
  const merged = next.map((message) => {
    const existing = currentById.get(message.id);
    return existing ? mergeBridgeMessage(existing, message) : message;
  });

  if (current.length <= next.length) {
    return merged;
  }

  const nextIds = new Set(next.map((message) => message.id));
  return current.map((message) => {
    const incoming = nextIds.has(message.id) ? next.find((candidate) => candidate.id === message.id) : undefined;
    return incoming ? mergeBridgeMessage(message, incoming) : message;
  });
}

function mergeBridgeConversation(
  current: DesktopBridgeConversation,
  next: DesktopBridgeConversation,
): DesktopBridgeConversation {
  return {
    ...next,
    subtitle: next.subtitle || current.subtitle,
    unreadCount: next.unreadCount,
    updatedAtMs: Math.max(current.updatedAtMs, next.updatedAtMs),
    updatedAtLabel: next.updatedAtMs >= current.updatedAtMs ? next.updatedAtLabel : current.updatedAtLabel,
    awaitingReply: next.awaitingReply,
    peerTyping: next.peerTyping,
    peerLastHeartbeatLabel: next.peerLastHeartbeatLabel ?? current.peerLastHeartbeatLabel,
    messages: mergeConversationMessages(current.messages, next.messages),
  };
}

export function markBridgeConversationsReadInState(
  state: DesktopBridgeState | null,
  conversationIds: string[],
): DesktopBridgeState | null {
  if (!state || conversationIds.length === 0) return state;
  const readConversationIds = new Set(conversationIds);
  return {
    ...state,
    conversations: state.conversations.map((conversation) => (
      readConversationIds.has(conversation.id)
        ? { ...conversation, unreadCount: 0 }
        : conversation
    )),
  };
}

export function mergeDesktopBridgeState(
  current: DesktopBridgeState | null,
  next: DesktopBridgeState | null,
): DesktopBridgeState | null {
  if (!next) return current;
  if (!current) return next;

  const mergedHosts = next.hosts.length > 0 ? next.hosts : current.hosts;
  const hostIds = new Set(mergedHosts.map((host) => host.id));
  const conversations = new Map(current.conversations.map((conversation) => [conversation.id, conversation]));
  for (const conversation of next.conversations) {
    conversations.set(
      conversation.id,
      conversations.has(conversation.id)
        ? mergeBridgeConversation(conversations.get(conversation.id)!, conversation)
        : conversation,
    );
  }

  return {
    ...next,
    activeHostId: next.activeHostId ?? current.activeHostId,
    hosts: mergedHosts,
    conversations: Array.from(conversations.values())
      .filter((conversation) => hostIds.has(conversation.hostId))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs),
  };
}

function applyBridgeSettingsDraft(
  state: DesktopBridgeState | null,
  draft: BridgeSettingsDraft,
): DesktopBridgeState | null {
  if (!state) return state;

  const trimmedServerUrl = draft.serverUrl.trim();
  const trimmedDisplayName = draft.displayName.trim();
  const trimmedOwnerName = draft.ownerName.trim();
  const targetHostId = draft.hostId
    ?? state.activeHostId
    ?? state.hosts.find((host) => host.serverUrl === trimmedServerUrl)?.id
    ?? null;

  if (!targetHostId) return state;

  return {
    ...state,
    hosts: state.hosts.map((host) => {
      if (host.id !== targetHostId) return host;

      const activeAgentId = host.activeAgentId ?? host.agents.find((agent) => agent.isDefault)?.id ?? null;

      return {
        ...host,
        serverUrl: trimmedServerUrl || host.serverUrl,
        displayName: trimmedDisplayName || host.displayName,
        ownerName: trimmedOwnerName || host.ownerName,
        agents: host.agents.map((agent) => (
          agent.id === activeAgentId && trimmedDisplayName
            ? { ...agent, label: trimmedDisplayName }
            : agent
        )),
      };
    }),
  };
}

export function useBridgeState({
  isNativeShell,
  activeNav,
  activeConvId,
  activeConversationIsBridge,
  composerChatText,
}: UseBridgeStateArgs) {
  const [desktopBridgeState, setDesktopBridgeState] = useState<DesktopBridgeState | null>(null);
  const [bridgeSettingsDraft, setBridgeSettingsDraft] = useState<BridgeSettingsDraft | null>(null);
  const [isDesktopBridgeSaving, setIsDesktopBridgeSaving] = useState(false);
  const [desktopBridgeError, setDesktopBridgeError] = useState<string | null>(null);
  const [isBridgePolling, setIsBridgePolling] = useState(false);
  const [lastBridgePollAt, setLastBridgePollAt] = useState<number | null>(null);
  const [bridgeInvite, setBridgeInvite] = useState<DesktopBridgeInvite | null>(null);
  const [isProjectBridgeBusy, setIsProjectBridgeBusy] = useState(false);
  const [bridgeWizardOpen, setBridgeWizardOpen] = useState(false);
  const [bridgeWizardStep, setBridgeWizardStep] = useState<1 | 2 | 3>(1);
  const [bridgeWizardDraft, setBridgeWizardDraft] = useState({
    mode: 'have-url' as 'have-url' | 'need-host',
    serverUrl: '',
    displayName: '',
    ownerName: '',
  });
  const lastBridgeTypingSentAtRef = useRef(0);
  const lastBridgeHeartbeatSentAtRef = useRef(0);
  const lastBridgePollProgressShownAtRef = useRef(0);
  const bridgePollProgressTimerRef = useRef<number | null>(null);
  const mailboxPollFlightRef = useRef(createSingleFlightState());
  const realtimeRecoveryFlightRef = useRef(createSingleFlightState());
  const lastBridgeRealtimeRecoveryAtRef = useRef(0);
  const activeBridgeReadRequestRef = useRef<string | null>(null);
  const [bridgeReadAttentionTick, setBridgeReadAttentionTick] = useState(0);
  const currentActiveHost = (desktopBridgeState?.hosts ?? []).find((host) => host.id === desktopBridgeState?.activeHostId)
    ?? desktopBridgeState?.hosts?.[0]
    ?? null;

  const showBridgeNotice = useCallback((message: string) => {
    setDesktopBridgeError(message);
    window.setTimeout(() => {
      setDesktopBridgeError((current) => (current === message ? null : current));
    }, 2200);
  }, []);

  const refreshDesktopBridge = useCallback(async () => {
    const nextState = await fetchDesktopBridgeState();
    if (nextState) {
      setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
      setDesktopBridgeError(null);
    }
  }, []);

  const handleSaveBridgeSettings = useCallback(async (draftOverride?: BridgeSettingsDraft) => {
    const draft = isBridgeSettingsDraft(draftOverride)
      ? draftOverride
      : bridgeSettingsDraft;
    if (!isNativeShell || !draft) return;

    const normalizedDraft: BridgeSettingsDraft = {
      hostId: draft.hostId ?? undefined,
      serverUrl: draft.serverUrl.trim(),
      displayName: draft.displayName.trim(),
      ownerName: draft.ownerName.trim(),
    };

    try {
      setIsDesktopBridgeSaving(true);
      setDesktopBridgeError(null);
      setBridgeSettingsDraft((current) => (
        current
          ? { ...current, ...normalizedDraft }
          : current
      ));
      setDesktopBridgeState((current) => applyBridgeSettingsDraft(current, normalizedDraft));
      const saved = await saveDesktopBridgeHost(
        normalizedDraft.serverUrl,
        normalizedDraft.displayName,
        normalizedDraft.ownerName,
        normalizedDraft.hostId ?? undefined,
      );
      setDesktopBridgeState(saved);
      setDesktopBridgeError(null);
    } catch (error) {
      const restoredState = await fetchDesktopBridgeState();
      if (restoredState) {
        setDesktopBridgeState(restoredState);
      }
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to save bridge host');
      throw error;
    } finally {
      setIsDesktopBridgeSaving(false);
    }
  }, [bridgeSettingsDraft, isNativeShell]);

  const handleSelectBridgeHost = useCallback(async (hostId: string) => {
    if (!isNativeShell) return;
    try {
      const nextState = await setDesktopActiveBridgeHost(hostId);
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to switch bridge host');
    }
  }, [isNativeShell]);

  const handleRemoveBridgeHost = useCallback(async (hostId: string) => {
    if (!isNativeShell) return;

    setDesktopBridgeState((current) => {
      if (!current) return current;
      const nextHosts = current.hosts.filter((host) => host.id !== hostId);
      const nextActiveHostId = current.activeHostId === hostId ? (nextHosts[0]?.id ?? null) : current.activeHostId;
      return {
        ...current,
        activeHostId: nextActiveHostId,
        hosts: nextHosts,
        conversations: current.conversations.filter((conversation) => conversation.hostId !== hostId),
      };
    });

    try {
      const nextState = await removeDesktopBridgeHost(hostId);
      setDesktopBridgeState(nextState);
      const refreshedState = await fetchDesktopBridgeState();
      if (refreshedState) {
        setDesktopBridgeState(refreshedState);
      }
      setDesktopBridgeError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to remove bridge host';
      const restoredState = await fetchDesktopBridgeState();
      if (restoredState) {
        setDesktopBridgeState(restoredState);
      }
      setDesktopBridgeError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }, [isNativeShell]);

  const handleCreateBridgeDraft = useCallback(() => {
    const nextDraft = createBridgeSettingsDraft(currentActiveHost);
    setBridgeSettingsDraft({
      ...nextDraft,
      hostId: null,
      serverUrl: '',
    });
    setDesktopBridgeError(null);
  }, [currentActiveHost]);

  const openBridgeWizard = useCallback((mode: 'have-url' | 'need-host' = 'have-url') => {
    setBridgeWizardDraft(createBridgeWizardDraft(currentActiveHost, mode));
    setBridgeWizardStep(1);
    setBridgeWizardOpen(true);
    setDesktopBridgeError(null);
  }, [currentActiveHost]);

  const handleBridgeWizardPrimary = useCallback(async () => {
    try {
      setDesktopBridgeError(null);
      if (bridgeWizardStep === 1) {
        if (bridgeWizardDraft.mode === 'need-host') {
          setBridgeWizardStep(2);
          return;
        }

        const state = await saveDesktopBridgeHost(
          bridgeWizardDraft.serverUrl,
          bridgeWizardDraft.displayName,
          bridgeWizardDraft.ownerName,
          bridgeSettingsDraft?.hostId ?? undefined,
        );
        setDesktopBridgeState(state);
        const host = state.hosts.find((item) => item.id === state.activeHostId) ?? state.hosts[0];
        setBridgeWizardDraft((current) => ({
          ...current,
          serverUrl: host?.serverUrl || current.serverUrl,
        }));
        setBridgeWizardStep(2);
        return;
      }

      if (bridgeWizardStep === 2) {
        setBridgeWizardStep(3);
        return;
      }

      setBridgeWizardOpen(false);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to complete bridge onboarding');
    }
  }, [bridgeSettingsDraft?.hostId, bridgeWizardDraft, bridgeWizardStep]);

  const handleCopyBridgeText = useCallback(async (value: string, successMessage = 'Copied to clipboard') => {
    try {
      await navigator.clipboard.writeText(value);
      showBridgeNotice(successMessage);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to copy bridge details');
    }
  }, [showBridgeNotice]);

  const handleOpenBridgeConfigFolder = useCallback(async () => {
    if (!isNativeShell) return;
    try {
      const path = await openDesktopBridgeConfigFolder();
      showBridgeNotice(`Opened ${path}`);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to open bridge config folder');
      throw error;
    }
  }, [isNativeShell, showBridgeNotice]);

  const handleRevealBridgeStorageFile = useCallback(async (kind: 'config' | 'conversations' | 'legacy') => {
    if (!isNativeShell) return;
    try {
      const path = await revealDesktopBridgeStorageFile(kind);
      showBridgeNotice(`Revealed ${path}`);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to reveal bridge storage file');
      throw error;
    }
  }, [isNativeShell, showBridgeNotice]);

  const handleExportBridgeHostsConfig = useCallback(async () => {
    if (!isNativeShell) return;
    try {
      const path = await exportDesktopBridgeHostsConfig();
      showBridgeNotice(`Exported redacted bridge host config to ${path}`);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to export bridge host config');
      throw error;
    }
  }, [isNativeShell, showBridgeNotice]);

  const handleImportBridgeHostsConfig = useCallback(async (raw: string) => {
    if (!isNativeShell) return;
    try {
      const nextState = await importDesktopBridgeHostsConfig(raw);
      setDesktopBridgeState((current) => mergeDesktopBridgeState(current, nextState));
      showBridgeNotice(`Imported ${nextState.hosts.length} bridge server${nextState.hosts.length === 1 ? '' : 's'} from config metadata`);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to import bridge host config');
      throw error;
    }
  }, [isNativeShell, showBridgeNotice]);

  useEffect(() => {
    if (!isNativeShell) return;

    let cancelled = false;
    fetchDesktopBridgeState()
      .then((state) => {
        if (cancelled || !state) return;
        setDesktopBridgeState((current) => mergeDesktopBridgeState(current, state));
        setDesktopBridgeError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to load bridge hosts');
      });

    return () => {
      cancelled = true;
    };
  }, [isNativeShell]);

  useEffect(() => {
    if (currentActiveHost) {
      setBridgeSettingsDraft((current) => {
        if (current?.hostId === currentActiveHost.id) return current;
        return createBridgeSettingsDraft(currentActiveHost);
      });
      return;
    }
    setBridgeSettingsDraft((current) => {
      if (current && !current.hostId) return current;
      return createBridgeSettingsDraft(null);
    });
  }, [currentActiveHost]);

  useEffect(() => {
    if (!isNativeShell || !(desktopBridgeState?.hosts.length)) return;
    const refresh = () => {
      void refreshDesktopBridge();
    };
    const interval = window.setInterval(refresh, 8000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [desktopBridgeState?.hosts.length, isNativeShell, refreshDesktopBridge]);

  useEffect(() => {
    if (!isNativeShell || !(desktopBridgeState?.hosts.length)) return;
    const poll = (trigger: BridgeMailboxPollTrigger) => {
      const run = requestSingleFlightRun(mailboxPollFlightRef.current, async () => {
        try {
          const state = await pollDesktopBridgeMailbox();
          setDesktopBridgeState((current) => mergeDesktopBridgeState(current, state));
          setLastBridgePollAt(Date.now());
        } catch {
          // keep polling lightweight; show errors only on explicit actions
        }
      });
      const shouldShowProgress = shouldShowBridgeMailboxPollProgress(
        trigger,
        Date.now(),
        lastBridgePollProgressShownAtRef.current,
      );
      if (!shouldShowProgress) return;
      const activeRun = run ?? mailboxPollFlightRef.current.currentPromise;
      if (!activeRun) return;
      if (bridgePollProgressTimerRef.current !== null) {
        window.clearTimeout(bridgePollProgressTimerRef.current);
      }
      bridgePollProgressTimerRef.current = window.setTimeout(() => {
        bridgePollProgressTimerRef.current = null;
        lastBridgePollProgressShownAtRef.current = Date.now();
        setIsBridgePolling(true);
      }, BRIDGE_MAILBOX_PROGRESS_DELAY_MS);
      void activeRun.finally(() => {
        if (bridgePollProgressTimerRef.current !== null) {
          window.clearTimeout(bridgePollProgressTimerRef.current);
          bridgePollProgressTimerRef.current = null;
        }
        setIsBridgePolling(false);
      });
    };
    const pollWhenVisible = (trigger: BridgeMailboxPollTrigger) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      poll(trigger);
    };
    pollWhenVisible('startup');
    const interval = window.setInterval(() => poll('routine'), 4000);
    const pollOnFocus = () => poll('focus');
    const pollOnPageShow = () => pollWhenVisible('pageshow');
    const pollOnVisibilityChange = () => pollWhenVisible('visibilitychange');
    window.addEventListener('focus', pollOnFocus);
    window.addEventListener('pageshow', pollOnPageShow);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', pollOnVisibilityChange);
    }
    return () => {
      window.clearInterval(interval);
      if (bridgePollProgressTimerRef.current !== null) {
        window.clearTimeout(bridgePollProgressTimerRef.current);
        bridgePollProgressTimerRef.current = null;
      }
      window.removeEventListener('focus', pollOnFocus);
      window.removeEventListener('pageshow', pollOnPageShow);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', pollOnVisibilityChange);
      }
    };
  }, [desktopBridgeState?.hosts.length, isNativeShell]);

  useEffect(() => {
    if (!isNativeShell || typeof window === 'undefined' || typeof document === 'undefined') return;

    const recoverRealtime = () => {
      const now = Date.now();
      if (!shouldRunBridgeRealtimeRecovery(now, lastBridgeRealtimeRecoveryAtRef.current)) return;
      lastBridgeRealtimeRecoveryAtRef.current = now;

      const run = requestSingleFlightRun(realtimeRecoveryFlightRef.current, async () => {
        const state = await refreshDesktopBridgeRealtimeConnections();
        setDesktopBridgeState((current) => mergeDesktopBridgeState(current, state));
        setLastBridgePollAt(Date.now());
        if (state.hosts.length === 0) return;
        try {
          const mailboxState = await pollDesktopBridgeMailbox();
          setDesktopBridgeState((current) => mergeDesktopBridgeState(current, mailboxState));
          setLastBridgePollAt(Date.now());
        } catch {
          // Recovery is best-effort; routine mailbox polling will keep trying.
        }
      });
      void run?.catch(() => {
        // Keep wake/focus recovery silent; explicit actions surface errors.
      });
    };

    const recoverWhenVisible = () => {
      if (shouldRefreshBridgeRealtimeForVisibility(document.visibilityState)) {
        recoverRealtime();
      }
    };

    window.addEventListener('focus', recoverRealtime);
    window.addEventListener('online', recoverRealtime);
    window.addEventListener('pageshow', recoverRealtime);
    document.addEventListener('visibilitychange', recoverWhenVisible);
    return () => {
      window.removeEventListener('focus', recoverRealtime);
      window.removeEventListener('online', recoverRealtime);
      window.removeEventListener('pageshow', recoverRealtime);
      document.removeEventListener('visibilitychange', recoverWhenVisible);
    };
  }, [isNativeShell]);

  useEffect(() => {
    if (!isNativeShell) return;
    let unlisten: (() => void) | null = null;
    void listen<DesktopBridgeState>('desktop-bridge-state', (event) => {
      setDesktopBridgeState((current) => mergeDesktopBridgeState(current, event.payload));
      setLastBridgePollAt(Date.now());
    }).then((dispose) => {
      unlisten = dispose;
    }).catch(() => {});

    return () => {
      unlisten?.();
    };
  }, [isNativeShell]);

  useEffect(() => {
    if (!isNativeShell || !activeConversationIsBridge) return;
    const activeBridgeConversationId = (desktopBridgeState?.conversations ?? []).find((conversation) => conversation.id === activeConvId)?.id;
    if (!activeBridgeConversationId) return;
    if (!composerChatText.trim()) return;
    const now = Date.now();
    if (now - lastBridgeTypingSentAtRef.current < 1800) return;
    lastBridgeTypingSentAtRef.current = now;
    sendDesktopBridgePresence(activeBridgeConversationId, 'typing').catch(() => {});
  }, [activeConvId, activeConversationIsBridge, composerChatText, desktopBridgeState?.conversations, isNativeShell]);

  useEffect(() => {
    if (!isNativeShell || !activeConversationIsBridge) return;
    const activeBridgeConversationId = (desktopBridgeState?.conversations ?? []).find((conversation) => conversation.id === activeConvId)?.id;
    if (!activeBridgeConversationId) return;
    const sendHeartbeat = () => {
      const now = Date.now();
      if (now - lastBridgeHeartbeatSentAtRef.current < 12000) return;
      lastBridgeHeartbeatSentAtRef.current = now;
      sendDesktopBridgePresence(activeBridgeConversationId, 'heartbeat').catch(() => {});
    };
    sendHeartbeat();
    const interval = window.setInterval(sendHeartbeat, 12000);
    return () => window.clearInterval(interval);
  }, [activeConvId, activeConversationIsBridge, desktopBridgeState?.conversations, isNativeShell]);

  useEffect(() => {
    if (!isNativeShell || typeof window === 'undefined' || typeof document === 'undefined') return;
    const bumpReadAttention = () => setBridgeReadAttentionTick((tick) => tick + 1);
    for (const eventName of BRIDGE_READ_ATTENTION_EVENTS) {
      const target = eventName === 'visibilitychange' ? document : window;
      target.addEventListener(eventName, bumpReadAttention);
    }
    return () => {
      for (const eventName of BRIDGE_READ_ATTENTION_EVENTS) {
        const target = eventName === 'visibilitychange' ? document : window;
        target.removeEventListener(eventName, bumpReadAttention);
      }
    };
  }, [isNativeShell]);

  useEffect(() => {
    if (!isNativeShell || activeNav !== 'chats') {
      activeBridgeReadRequestRef.current = null;
      return;
    }

    const activeConversations = activeUnreadBridgeConversationsForSession(desktopBridgeState?.conversations ?? [], activeConvId);
    if (activeConversations.length === 0) {
      activeBridgeReadRequestRef.current = null;
      return;
    }

    const canAutoMarkRead = canAutoMarkBridgeRead(document);
    if (!canAutoMarkRead) {
      activeBridgeReadRequestRef.current = null;
      return;
    }
    const readSignature = bridgeReadReceiptBatchSignature(activeConversations);
    if (activeBridgeReadRequestRef.current === readSignature) return;

    activeBridgeReadRequestRef.current = readSignature;
    const conversationIds = activeConversations.map((conversation) => conversation.id);
    setDesktopBridgeState((current) => markBridgeConversationsReadInState(current, conversationIds));
    Promise.all(conversationIds.map((conversationId) => markDesktopBridgeConversationRead(conversationId)))
      .then((states) => {
        setDesktopBridgeState((current) => states.reduce((merged, state) => mergeDesktopBridgeState(merged, state), current));
        setDesktopBridgeError(null);
      })
      .catch((error) => {
        activeBridgeReadRequestRef.current = null;
        setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to mark bridge chat as read');
      });
  }, [activeConvId, activeNav, bridgeReadAttentionTick, desktopBridgeState?.conversations, isNativeShell]);

  return {
    desktopBridgeState,
    setDesktopBridgeState,
    bridgeSettingsDraft,
    setBridgeSettingsDraft,
    isDesktopBridgeSaving,
    desktopBridgeError,
    setDesktopBridgeError,
    isBridgePolling,
    lastBridgePollAt,
    bridgeInvite,
    setBridgeInvite,
    isProjectBridgeBusy,
    setIsProjectBridgeBusy,
    bridgeWizardOpen,
    setBridgeWizardOpen,
    bridgeWizardStep,
    setBridgeWizardStep,
    bridgeWizardDraft,
    setBridgeWizardDraft,
    refreshDesktopBridge,
    handleSaveBridgeSettings,
    handleSelectBridgeHost,
    handleRemoveBridgeHost,
    handleCreateBridgeDraft,
    openBridgeWizard,
    handleBridgeWizardPrimary,
    handleCopyBridgeText,
    handleOpenBridgeConfigFolder,
    handleRevealBridgeStorageFile,
    handleExportBridgeHostsConfig,
    handleImportBridgeHostsConfig,
  };
}
