import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { DesktopBridgeHost, DesktopBridgePeer, DesktopBridgeState } from '@/kordi-app/types';
import type { BridgeSetupMode } from './BridgeSetupSections';

export type DiscoveryMode = 'off' | 'contacts' | 'open';
export type HumanVisibilityPolicy = 'server-open' | 'server-approval' | 'private';
export type ContactApprovalPolicy = 'auto' | 'approval-required';
export type AgentReachabilityPolicy = 'server' | 'contacts' | 'owner';
export type BridgeStepId = 'setup' | 'identity' | 'visibility' | 'approvals' | 'agents' | 'discover' | 'review';
export type BridgePageSection = 'servers' | 'details' | 'advanced';

export type BridgeSettingsDraft = {
  hostId?: string | null;
  serverUrl: string;
  displayName: string;
  ownerName: string;
};

export type BridgeWizardDraft = {
  mode: BridgeSetupMode;
  serverUrl: string;
  displayName: string;
  ownerName: string;
};

export type BridgeConfigPageProps = {
  desktopBridgeState: DesktopBridgeState | null;
  activeBridgeHost: DesktopBridgeHost | null;
  activeBridgePeople: DesktopBridgePeer[];
  activeBridgeAgents: DesktopBridgePeer[];
  bridgeSettingsDraft: BridgeSettingsDraft | null;
  setBridgeSettingsDraft: Dispatch<SetStateAction<BridgeSettingsDraft | null>>;
  isDesktopBridgeSaving: boolean;
  desktopBridgeError: string | null;
  bridgeWizardOpen: boolean;
  setBridgeWizardOpen: Dispatch<SetStateAction<boolean>>;
  bridgeWizardStep: 1 | 2 | 3;
  setBridgeWizardStep: Dispatch<SetStateAction<1 | 2 | 3>>;
  bridgeWizardDraft: BridgeWizardDraft;
  setBridgeWizardDraft: Dispatch<SetStateAction<BridgeWizardDraft>>;
  onSelectBridgeHost: (hostId: string) => void;
  onCreateBridgeDraft: () => void;
  onRefreshBridge: () => Promise<void> | void;
  onSaveBridgeSettings: (draftOverride?: BridgeSettingsDraft) => Promise<void>;
  onRemoveBridgeHost: (hostId: string) => Promise<void>;
  onCopyBridgeText: (value: string, successMessage?: string) => void;
  onOpenBridgeConfigFolder: () => Promise<void>;
  onRevealBridgeStorageFile: (kind: 'config' | 'conversations' | 'legacy') => Promise<void>;
  onExportBridgeHostsConfig: () => Promise<void>;
  onImportBridgeHostsConfig: (raw: string) => Promise<void>;
  onAddBridgeContact: (hostId: string, peerNodeId: string) => Promise<void>;
  onSetBridgeDiscoveryMode: (hostId: string, discoveryMode: DiscoveryMode) => Promise<void>;
  onSetBridgeHostPrivacyPolicy: (hostId: string, humanVisibilityPolicy: HumanVisibilityPolicy, contactApprovalPolicy: ContactApprovalPolicy) => Promise<void>;
  onSetBridgeAgentReachabilityPolicy: (hostId: string, agentId: string, reachabilityPolicy: AgentReachabilityPolicy) => Promise<void>;
  onApproveBridgeContactRequest: (hostId: string, requestId: string) => Promise<void>;
  onRejectBridgeContactRequest: (hostId: string, requestId: string) => Promise<void>;
  onCreateBridgeAgent: (hostId: string, label?: string) => Promise<void>;
  onActivateBridgeAgent: (hostId: string, agentId: string) => Promise<void>;
  onSetDefaultBridgeAgent: (hostId: string, agentId: string) => Promise<void>;
  onRemoveBridgeContact: (hostId: string, peerNodeId: string) => Promise<void>;
  onOpenBridgeConversation: (
    hostId: string,
    peerNodeId: string,
    peerDisplayName?: string | null,
    peerOwnerName?: string | null,
    peerRuntime?: string | null,
    target?: { humanId?: string | null; agentId?: string | null },
  ) => void;
  onBridgeWizardPrimary: () => void;
};

export type BridgeSetupPanelProps = Pick<
  BridgeConfigPageProps,
  | 'desktopBridgeState'
  | 'activeBridgeHost'
  | 'bridgeSettingsDraft'
  | 'setBridgeSettingsDraft'
  | 'isDesktopBridgeSaving'
  | 'desktopBridgeError'
  | 'onCreateBridgeDraft'
  | 'onRefreshBridge'
  | 'onSaveBridgeSettings'
  | 'onRemoveBridgeHost'
  | 'onSelectBridgeHost'
  | 'onCopyBridgeText'
  | 'onOpenBridgeConfigFolder'
  | 'onRevealBridgeStorageFile'
  | 'onExportBridgeHostsConfig'
  | 'onImportBridgeHostsConfig'
> & {
  setupMode: BridgeSetupMode;
  setSetupMode: Dispatch<SetStateAction<BridgeSetupMode>>;
  showSetupComposer: boolean;
  setShowSetupComposer: Dispatch<SetStateAction<boolean>>;
  closeSetupComposer: () => void;
  setActiveSection: Dispatch<SetStateAction<BridgePageSection>>;
  importBridgeConfigInputRef: MutableRefObject<HTMLInputElement | null>;
  setPendingRemoveHost: Dispatch<SetStateAction<DesktopBridgeHost | null>>;
};

export type BridgeDetailsSectionProps = Pick<
  BridgeConfigPageProps,
  | 'activeBridgeHost'
  | 'activeBridgePeople'
  | 'activeBridgeAgents'
  | 'bridgeSettingsDraft'
  | 'setBridgeSettingsDraft'
  | 'isDesktopBridgeSaving'
  | 'onSaveBridgeSettings'
  | 'onCopyBridgeText'
  | 'onSetBridgeDiscoveryMode'
  | 'onSetBridgeHostPrivacyPolicy'
  | 'onSetBridgeAgentReachabilityPolicy'
  | 'onApproveBridgeContactRequest'
  | 'onRejectBridgeContactRequest'
  | 'onCreateBridgeAgent'
  | 'onActivateBridgeAgent'
  | 'onSetDefaultBridgeAgent'
  | 'onAddBridgeContact'
  | 'onRemoveBridgeContact'
  | 'onOpenBridgeConversation'
> & {
  activeStep: BridgeStepId;
  setActiveStep: Dispatch<SetStateAction<BridgeStepId>>;
  setActiveSection: Dispatch<SetStateAction<BridgePageSection>>;
  contactNodeId: string;
  setContactNodeId: Dispatch<SetStateAction<string>>;
  identityOwnerName: string;
  setIdentityOwnerName: Dispatch<SetStateAction<string>>;
};
