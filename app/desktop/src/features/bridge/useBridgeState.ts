import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_BRIDGE_DISPLAY_NAME,
  DEFAULT_BRIDGE_OWNER_NAME,
} from '@/features/bridge/constants';
import type { DesktopBridgeInvite, DesktopBridgeState, NavId } from '@/kordi-app/types';
import {
  exportDesktopBridgeHostsConfig,
  fetchDesktopBridgeState,
  importDesktopBridgeHostsConfig,
  openDesktopBridgeConfigFolder,
  pollDesktopBridgeMailbox,
  removeDesktopBridgeHost,
  revealDesktopBridgeStorageFile,
  saveDesktopBridgeHost,
  sendDesktopBridgePresence,
  setDesktopActiveBridgeHost,
} from '@/lib/desktop';

type UseBridgeStateArgs = {
  isNativeShell: boolean;
  activeNav: NavId;
  activeConvId: string;
  activeConversationIsBridge: boolean;
  composerChatText: string;
};

type BridgeSettingsDraft = {
  hostId?: string | null;
  serverUrl: string;
  displayName: string;
  ownerName: string;
};

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
      setDesktopBridgeState(nextState);
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
      setDesktopBridgeState(nextState);
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
        setDesktopBridgeState(state);
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
    if (!isNativeShell || activeNav !== 'bridge') return;
    const refresh = () => {
      void refreshDesktopBridge();
    };
    const interval = window.setInterval(refresh, 8000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [activeNav, isNativeShell, refreshDesktopBridge]);

  useEffect(() => {
    if (!isNativeShell || !(desktopBridgeState?.hosts.length)) return;
    const poll = () => {
      setIsBridgePolling(true);
      pollDesktopBridgeMailbox()
        .then((state) => {
          setDesktopBridgeState(state);
          setLastBridgePollAt(Date.now());
        })
        .catch(() => {
          // keep polling lightweight; show errors only on explicit actions
        })
        .finally(() => {
          setIsBridgePolling(false);
        });
    };
    const interval = window.setInterval(poll, 4000);
    window.addEventListener('focus', poll);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', poll);
    };
  }, [desktopBridgeState?.hosts.length, isNativeShell]);

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
