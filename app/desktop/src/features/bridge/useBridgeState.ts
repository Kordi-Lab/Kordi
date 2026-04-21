import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopBridgeInvite, DesktopBridgeState, NavId } from '@/kordi-app/types';
import {
  fetchDesktopBridgeState,
  pollDesktopBridgeMailbox,
  removeDesktopBridgeHost,
  saveDesktopBridgeHost,
  sendDesktopBridgePresence,
  setDesktopActiveBridgeHost,
  startDesktopBridgeLocalServer,
} from '@/lib/desktop';

type UseBridgeStateArgs = {
  isNativeShell: boolean;
  activeNav: NavId;
  activeConvId: string;
  activeConversationIsBridge: boolean;
  composerChatText: string;
};

export function useBridgeState({
  isNativeShell,
  activeNav,
  activeConvId,
  activeConversationIsBridge,
  composerChatText,
}: UseBridgeStateArgs) {
  const [desktopBridgeState, setDesktopBridgeState] = useState<DesktopBridgeState | null>(null);
  const [bridgeSettingsDraft, setBridgeSettingsDraft] = useState<{ hostId?: string | null; serverUrl: string; displayName: string; ownerName: string } | null>(null);
  const [isDesktopBridgeSaving, setIsDesktopBridgeSaving] = useState(false);
  const [desktopBridgeError, setDesktopBridgeError] = useState<string | null>(null);
  const [isBridgePolling, setIsBridgePolling] = useState(false);
  const [lastBridgePollAt, setLastBridgePollAt] = useState<number | null>(null);
  const [bridgeInvite, setBridgeInvite] = useState<DesktopBridgeInvite | null>(null);
  const [isProjectBridgeBusy, setIsProjectBridgeBusy] = useState(false);
  const [bridgeWizardOpen, setBridgeWizardOpen] = useState(false);
  const [bridgeWizardStep, setBridgeWizardStep] = useState<1 | 2 | 3>(1);
  const [bridgeWizardDraft, setBridgeWizardDraft] = useState({
    mode: 'join' as 'join' | 'self-host' | 'public',
    serverUrl: '',
    displayName: '',
    ownerName: '',
  });
  const lastBridgeTypingSentAtRef = useRef(0);
  const lastBridgeHeartbeatSentAtRef = useRef(0);
  const currentActiveHost = (desktopBridgeState?.hosts ?? []).find((host) => host.id === desktopBridgeState?.activeHostId)
    ?? desktopBridgeState?.hosts?.[0]
    ?? null;

  const refreshDesktopBridge = useCallback(async () => {
    const nextState = await fetchDesktopBridgeState();
    if (nextState) {
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    }
  }, []);

  const handleSaveBridgeSettings = useCallback(async () => {
    if (!isNativeShell || !bridgeSettingsDraft) return;

    try {
      setIsDesktopBridgeSaving(true);
      setDesktopBridgeError(null);
      const saved = await saveDesktopBridgeHost(
        bridgeSettingsDraft.serverUrl,
        bridgeSettingsDraft.displayName,
        bridgeSettingsDraft.ownerName,
        bridgeSettingsDraft.hostId ?? undefined,
      );
      setDesktopBridgeState(saved);
      setDesktopBridgeError(null);
    } catch (error) {
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
    try {
      const nextState = await removeDesktopBridgeHost(hostId);
      setDesktopBridgeState(nextState);
      setDesktopBridgeError(null);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to remove bridge host');
    }
  }, [isNativeShell]);

  const handleCreateBridgeDraft = useCallback(() => {
    setBridgeSettingsDraft({
      hostId: null,
      serverUrl: '',
      displayName: currentActiveHost?.displayName ?? '',
      ownerName: currentActiveHost?.ownerName ?? '',
    });
    setDesktopBridgeError(null);
  }, [currentActiveHost]);

  const openBridgeWizard = useCallback((mode: 'join' | 'self-host' | 'public' = 'join') => {
    setBridgeWizardDraft({
      mode,
      serverUrl: mode === 'self-host'
        ? (desktopBridgeState?.localServer.serverUrl || 'http://127.0.0.1:17080')
        : mode === 'public'
          ? 'https://coord.korde.ai'
          : currentActiveHost?.serverUrl || '',
      displayName: currentActiveHost?.displayName || '',
      ownerName: currentActiveHost?.ownerName || '',
    });
    setBridgeWizardStep(1);
    setBridgeWizardOpen(true);
    setDesktopBridgeError(null);
  }, [currentActiveHost, desktopBridgeState?.localServer.serverUrl]);

  const handleBridgeWizardPrimary = useCallback(async () => {
    try {
      setDesktopBridgeError(null);
      if (bridgeWizardStep === 1) {
        if (bridgeWizardDraft.mode === 'self-host') {
          const state = await startDesktopBridgeLocalServer(17080, bridgeWizardDraft.displayName, bridgeWizardDraft.ownerName);
          setDesktopBridgeState(state);
          const host = state.hosts.find((item) => item.id === state.activeHostId) ?? state.hosts[0];
          setBridgeWizardDraft((current) => ({
            ...current,
            serverUrl: host?.serverUrl || current.serverUrl,
          }));
        } else {
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
        }
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
      setDesktopBridgeError(successMessage);
      window.setTimeout(() => {
        setDesktopBridgeError((current) => (current === successMessage ? null : current));
      }, 1800);
    } catch (error) {
      setDesktopBridgeError(error instanceof Error ? error.message : 'Unable to copy bridge details');
    }
  }, []);

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
        return {
          hostId: currentActiveHost.id,
          serverUrl: currentActiveHost.serverUrl,
          displayName: currentActiveHost.displayName,
          ownerName: currentActiveHost.ownerName,
        };
      });
      return;
    }
    setBridgeSettingsDraft((current) => {
      if (current && !current.hostId) return current;
      return {
        hostId: null,
        serverUrl: '',
        displayName: '',
        ownerName: '',
      };
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
  };
}
