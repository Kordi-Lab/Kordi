import { useEffect, useRef, useState } from 'react';

import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { DEFAULT_BRIDGE_OWNER_NAME } from '@/features/bridge/constants';

import type { BridgeConfigPageProps, BridgePageSection, BridgeStepId } from './bridge/BridgeConfigPage.types';
import { SectionNav } from './bridge/BridgeConfigShared';
import { BridgeDetailsSection } from './bridge/BridgeDetailsSection';
import { BridgeRemoveHostModal, BridgeWizardModal } from './bridge/BridgeConfigModals';
import { BridgeAdvancedSection, BridgeSetupSection } from './bridge/BridgeSetupPanels';
import type { BridgeSetupMode } from './bridge/BridgeSetupSections';

export function BridgeConfigPage({
  desktopBridgeState,
  activeBridgeHost,
  activeBridgePeople,
  activeBridgeAgents,
  bridgeSettingsDraft,
  setBridgeSettingsDraft,
  isDesktopBridgeSaving,
  desktopBridgeError,
  bridgeWizardOpen,
  setBridgeWizardOpen,
  bridgeWizardStep,
  setBridgeWizardStep,
  bridgeWizardDraft,
  setBridgeWizardDraft,
  onSelectBridgeHost,
  onCreateBridgeDraft,
  onRefreshBridge,
  onSaveBridgeSettings,
  onRemoveBridgeHost,
  onCopyBridgeText,
  onOpenBridgeConfigFolder,
  onRevealBridgeStorageFile,
  onExportBridgeHostsConfig,
  onImportBridgeHostsConfig,
  onAddBridgeContact,
  onSetBridgeDiscoveryMode,
  onSetBridgeHostPrivacyPolicy,
  onSetBridgeAgentReachabilityPolicy,
  onApproveBridgeContactRequest,
  onRejectBridgeContactRequest,
  onCreateBridgeAgent,
  onActivateBridgeAgent,
  onSetDefaultBridgeAgent,
  onRemoveBridgeContact,
  onOpenBridgeConversation,
  onBridgeWizardPrimary,
}: BridgeConfigPageProps) {
  const [activeSection, setActiveSection] = useState<BridgePageSection>('servers');
  const [activeStep, setActiveStep] = useState<BridgeStepId>('identity');
  const importBridgeConfigInputRef = useRef<HTMLInputElement | null>(null);
  const [setupMode, setSetupMode] = useState<BridgeSetupMode>('have-url');
  const [showSetupComposer, setShowSetupComposer] = useState(false);
  const [pendingRemoveHost, setPendingRemoveHost] = useState<typeof activeBridgeHost>(null);
  const [isRemovingHost, setIsRemovingHost] = useState(false);
  const [contactNodeId, setContactNodeId] = useState('');
  const [identityOwnerName, setIdentityOwnerName] = useState('');

  const closeSetupComposer = () => {
    setShowSetupComposer(false);
    setSetupMode('have-url');
  };

  useEffect(() => {
    if (!activeBridgeHost && activeSection === 'details') {
      setActiveSection('servers');
    }
    if (activeStep !== 'identity' && activeStep !== 'setup' && !activeBridgeHost?.registered) {
      setActiveStep('identity');
    }
  }, [activeBridgeHost, activeSection, activeStep]);

  useEffect(() => {
    if (showSetupComposer && bridgeSettingsDraft?.hostId) {
      setShowSetupComposer(false);
      setActiveSection('details');
    }
  }, [bridgeSettingsDraft?.hostId, showSetupComposer]);

  useEffect(() => {
    setIdentityOwnerName(activeBridgeHost?.ownerName ?? bridgeSettingsDraft?.ownerName ?? DEFAULT_BRIDGE_OWNER_NAME);
  }, [activeBridgeHost?.ownerName, bridgeSettingsDraft?.ownerName]);

  useEffect(() => {
    if (activeSection !== 'servers' && showSetupComposer) {
      closeSetupComposer();
    }
  }, [activeSection, showSetupComposer]);

  const activeDefaultAgentId = activeBridgeHost?.agents.find((agent) => agent.isDefault)?.id ?? activeBridgeHost?.agents[0]?.id ?? null;

  return (
    <>
      <div className="app-bridge-page app-scroll-area flex h-full min-w-0 flex-1 justify-center overflow-y-auto p-4">
        <div className="app-bridge-main app-bridge-shell w-full space-y-4 text-white">
          <Card className="app-bridge-card app-bridge-nav-card rounded-[26px] border-white/10 bg-white/5 shadow-none">
            <CardHeader>
              <div className="space-y-3">
                <div>
                  <CardTitle className="text-base">Bridge</CardTitle>
                  <div className="mt-1 text-[12px] leading-5 text-slate-400">
                    Start by choosing a host, then drill in only when you need to adjust how you appear, which agents you use, or who you can reach.
                  </div>
                </div>
                <SectionNav activeSection={activeSection} setActiveSection={setActiveSection} activeBridgeHost={activeBridgeHost} />
              </div>
            </CardHeader>
          </Card>

          <div className="app-bridge-page-stack space-y-4">
            {activeSection === 'servers' ? (
              <BridgeSetupSection
                desktopBridgeState={desktopBridgeState}
                activeBridgeHost={activeBridgeHost}
                bridgeSettingsDraft={bridgeSettingsDraft}
                setBridgeSettingsDraft={setBridgeSettingsDraft}
                isDesktopBridgeSaving={isDesktopBridgeSaving}
                desktopBridgeError={desktopBridgeError}
                setupMode={setupMode}
                setSetupMode={setSetupMode}
                showSetupComposer={showSetupComposer}
                setShowSetupComposer={setShowSetupComposer}
                closeSetupComposer={closeSetupComposer}
                setActiveSection={setActiveSection}
                setPendingRemoveHost={setPendingRemoveHost}
                onCreateBridgeDraft={onCreateBridgeDraft}
                onRefreshBridge={onRefreshBridge}
                onSaveBridgeSettings={onSaveBridgeSettings}
                onSelectBridgeHost={onSelectBridgeHost}
              />
            ) : null}
            {activeSection === 'details' ? (
              <BridgeDetailsSection
                activeBridgeHost={activeBridgeHost}
                activeBridgePeople={activeBridgePeople}
                activeBridgeAgents={activeBridgeAgents}
                bridgeSettingsDraft={bridgeSettingsDraft}
                setBridgeSettingsDraft={setBridgeSettingsDraft}
                isDesktopBridgeSaving={isDesktopBridgeSaving}
                onSaveBridgeSettings={onSaveBridgeSettings}
                onCopyBridgeText={onCopyBridgeText}
                onSetBridgeDiscoveryMode={onSetBridgeDiscoveryMode}
                onCreateBridgeAgent={onCreateBridgeAgent}
                onActivateBridgeAgent={onActivateBridgeAgent}
                onSetDefaultBridgeAgent={onSetDefaultBridgeAgent}
                onAddBridgeContact={onAddBridgeContact}
                onSetBridgeHostPrivacyPolicy={onSetBridgeHostPrivacyPolicy}
                onSetBridgeAgentReachabilityPolicy={onSetBridgeAgentReachabilityPolicy}
                onApproveBridgeContactRequest={onApproveBridgeContactRequest}
                onRejectBridgeContactRequest={onRejectBridgeContactRequest}
                onRemoveBridgeContact={onRemoveBridgeContact}
                onOpenBridgeConversation={onOpenBridgeConversation}
                activeStep={activeStep}
                setActiveStep={setActiveStep}
                setActiveSection={setActiveSection}
                contactNodeId={contactNodeId}
                setContactNodeId={setContactNodeId}
                identityOwnerName={identityOwnerName}
                setIdentityOwnerName={setIdentityOwnerName}
              />
            ) : null}
            {activeSection === 'advanced' ? (
              <BridgeAdvancedSection
                activeBridgeHost={activeBridgeHost}
                desktopBridgeState={desktopBridgeState}
                importBridgeConfigInputRef={importBridgeConfigInputRef}
                closeSetupComposer={closeSetupComposer}
                onOpenBridgeConfigFolder={onOpenBridgeConfigFolder}
                onRevealBridgeStorageFile={onRevealBridgeStorageFile}
                onCopyBridgeText={onCopyBridgeText}
                onExportBridgeHostsConfig={onExportBridgeHostsConfig}
                onImportBridgeHostsConfig={onImportBridgeHostsConfig}
                onRefreshBridge={onRefreshBridge}
                setActiveSection={setActiveSection}
              />
            ) : null}
          </div>
        </div>
      </div>

      <BridgeRemoveHostModal
        pendingRemoveHost={pendingRemoveHost}
        isRemovingHost={isRemovingHost}
        setPendingRemoveHost={setPendingRemoveHost}
        setIsRemovingHost={setIsRemovingHost}
        onRemoveBridgeHost={onRemoveBridgeHost}
        onRefreshBridge={onRefreshBridge}
      />

      <BridgeWizardModal
        bridgeWizardOpen={bridgeWizardOpen}
        setBridgeWizardOpen={setBridgeWizardOpen}
        bridgeWizardStep={bridgeWizardStep}
        setBridgeWizardStep={setBridgeWizardStep}
        bridgeWizardDraft={bridgeWizardDraft}
        setBridgeWizardDraft={setBridgeWizardDraft}
        activeBridgeHost={activeBridgeHost}
        activeDefaultAgentId={activeDefaultAgentId}
        onBridgeWizardPrimary={onBridgeWizardPrimary}
      />
    </>
  );
}
