import type { Dispatch, RefObject, SetStateAction } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRightLeft,
  FileText,
  Globe,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Send,
  Shield,
  Square,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  ComposerModelControls,
  ComposerRuntimeStatus,
  ComposerSlashMenu,
  LiveChatTurnCard,
  MessageBubble,
  TypeBadge,
  type ComposerAuthOption,
  type ComposerModelOption,
  type ComposerProviderOption,
} from '@/kordi-app/components';
import type {
  Conversation,
  DesktopChatContextWindowStatus,
  DesktopChatSlashCommand,
  DesktopChatTurnSnapshot,
  EditFilePreview,
} from '@/kordi-app/types';
import { cn } from '@/lib/utils';

type Attachment = {
  id: string;
  name: string;
  path: string;
  kind: 'image' | 'file';
};

type ChatsPageProps = {
  isNativeShell: boolean;
  showChatDetailRail: boolean;
  collapseChatSessions: boolean;
  setIsSessionPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  showRightDetailRail: boolean;
  isDetailPanelCollapsed: boolean;
  setIsDetailPanelCollapsed: Dispatch<SetStateAction<boolean>>;
  activeConv: Conversation;
  activeConversationIsBridge: boolean;
  isEditingDesktopSessionTitle: boolean;
  setIsEditingDesktopSessionTitle: Dispatch<SetStateAction<boolean>>;
  desktopSessionRenameDraft: string;
  setDesktopSessionRenameDraft: Dispatch<SetStateAction<string>>;
  onRenameDesktopSession: (baselineName: string) => Promise<void>;
  bridgeStatusText?: string | null;
  bridgeStatusLoading: boolean;
  chatTranscriptScrollRef: RefObject<HTMLDivElement | null>;
  onTranscriptScroll: () => void;
  onOpenSource: (file: EditFilePreview) => void;
  desktopLiveTurn: DesktopChatTurnSnapshot | null;
  filteredChatSlashCommands: DesktopChatSlashCommand[];
  chatSlashMenuIndex: number;
  setChatSlashMenuIndex: Dispatch<SetStateAction<number>>;
  acceptChatSlashCommand: (value: string) => void;
  chatAttachmentInputRef: RefObject<HTMLInputElement | null>;
  chatComposerAttachments: Attachment[];
  saveDesktopAttachments: (files: File[]) => Promise<Attachment[]>;
  removeChatComposerAttachment: (id: string) => void;
  chatComposerText: string;
  updateChatComposerDraft: (value: string, target: HTMLTextAreaElement) => void;
  setChatComposerText: (value: string) => void;
  composerControlsRef: RefObject<HTMLDivElement | null>;
  activeRuntimeContextStatus?: DesktopChatContextWindowStatus | null;
  activeRuntimeCacheText?: string | null;
  composerSelection: { mode: string; model: string; thinking: string };
  openComposerSelector: { scope: 'chat' | 'project'; type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking' } | null;
  toggleComposerSelector: (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking') => void;
  selectComposerValue: (scope: 'chat' | 'project', type: 'mode' | 'auth' | 'provider' | 'model' | 'thinking', value: string) => void;
  composerAuthLabel: string;
  composerAuthOptions: ComposerAuthOption[];
  selectComposerAuthChoice: (scope: 'chat' | 'project', providerId: string, choice: string) => void;
  selectComposerProviderChoice: (scope: 'chat' | 'project', option: ComposerProviderOption) => void;
  composerProviderOptions: ComposerProviderOption[];
  chatModelOptions?: ComposerModelOption[];
  isDesktopChatSending: boolean;
  onStopDesktopChatTurn: () => void;
  onSendChatMessage: () => void;
};

export function ChatsPage({
  isNativeShell,
  showChatDetailRail,
  collapseChatSessions,
  setIsSessionPanelCollapsed,
  showRightDetailRail,
  isDetailPanelCollapsed,
  setIsDetailPanelCollapsed,
  activeConv,
  activeConversationIsBridge,
  isEditingDesktopSessionTitle,
  setIsEditingDesktopSessionTitle,
  desktopSessionRenameDraft,
  setDesktopSessionRenameDraft,
  onRenameDesktopSession,
  bridgeStatusText,
  bridgeStatusLoading,
  chatTranscriptScrollRef,
  onTranscriptScroll,
  onOpenSource,
  desktopLiveTurn,
  filteredChatSlashCommands,
  chatSlashMenuIndex,
  setChatSlashMenuIndex,
  acceptChatSlashCommand,
  chatAttachmentInputRef,
  chatComposerAttachments,
  saveDesktopAttachments,
  removeChatComposerAttachment,
  chatComposerText,
  updateChatComposerDraft,
  setChatComposerText,
  composerControlsRef,
  activeRuntimeContextStatus,
  activeRuntimeCacheText,
  composerSelection,
  openComposerSelector,
  toggleComposerSelector,
  selectComposerValue,
  composerAuthLabel,
  composerAuthOptions,
  selectComposerAuthChoice,
  selectComposerProviderChoice,
  composerProviderOptions,
  chatModelOptions,
  isDesktopChatSending,
  onStopDesktopChatTurn,
  onSendChatMessage,
}: ChatsPageProps) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="app-page-header shrink-0 flex items-start justify-between gap-3 border-b border-white/10 px-4 py-2.5">
        <div className="flex min-w-0 items-start gap-2">
          {showChatDetailRail && (
            <button
              type="button"
              onClick={() => setIsSessionPanelCollapsed((collapsed) => !collapsed)}
              className="app-icon-button app-utility-button grid h-7.5 w-7.5 shrink-0 place-items-center rounded-[12px] text-slate-100 transition"
              aria-label={collapseChatSessions ? 'Open sessions' : 'Close sessions'}
              title={collapseChatSessions ? 'Open sessions' : 'Close sessions'}
            >
              {collapseChatSessions ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="app-page-header-title-row mb-1 flex min-w-0 items-center gap-1.5 text-white">
              {isNativeShell ? (
                isEditingDesktopSessionTitle ? (
                  <input
                    value={desktopSessionRenameDraft}
                    onChange={(event) => setDesktopSessionRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setDesktopSessionRenameDraft(activeConv.name);
                        setIsEditingDesktopSessionTitle(false);
                      }
                    }}
                    onBlur={() => {
                      void onRenameDesktopSession(activeConv.name);
                    }}
                    autoFocus
                    className="min-w-[220px] max-w-full rounded-lg bg-transparent px-1 py-0.5 text-left text-[17px] font-semibold text-white outline-none ring-1 ring-white/10 placeholder:text-slate-500 focus:ring-white/20"
                    placeholder="Session name"
                  />
                ) : (
                  <h2
                    onDoubleClick={() => {
                      if (activeConversationIsBridge) return;
                      setDesktopSessionRenameDraft(activeConv.name);
                      setIsEditingDesktopSessionTitle(true);
                    }}
                    className="min-w-0 max-w-full truncate rounded-lg px-1 py-0.5 text-left text-[17px] font-semibold text-white transition hover:bg-white/5"
                    title={activeConversationIsBridge ? undefined : 'Double-click to rename session'}
                  >
                    {activeConv.name}
                  </h2>
                )
              ) : (
                <h2 className="min-w-0 max-w-full truncate text-[17px] font-semibold">{activeConv.name}</h2>
              )}
              <TypeBadge type={activeConv.type} compact />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-5 text-slate-400">
              <span className="inline-flex items-center gap-1"><Shield className="h-3 w-3" /> {activeConv.trust}</span>
              {activeConv.bridges.map((bridge) => (
                <span key={bridge} className="inline-flex items-center gap-1"><Globe className="h-3 w-3" /> {bridge}</span>
              ))}
              <span className="inline-flex items-center gap-1"><ArrowRightLeft className="h-3 w-3" /> {activeConv.directness}</span>
            </div>
            {activeConversationIsBridge ? (
              <div className="mt-1.5 flex items-center gap-2 text-[12px] text-slate-400">
                {bridgeStatusLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
                <span className="truncate">{bridgeStatusText}</span>
              </div>
            ) : null}
          </div>
        </div>
        {showRightDetailRail && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setIsDetailPanelCollapsed((collapsed) => !collapsed)}
            className="app-icon-button app-utility-button mt-0.5 h-8 rounded-full px-3 text-[12px] text-slate-100 transition"
            aria-label={isDetailPanelCollapsed ? 'Open session details' : 'Hide session details'}
            title={isDetailPanelCollapsed ? 'Open session details' : 'Hide session details'}
          >
            {isDetailPanelCollapsed ? 'Details' : 'Hide details'}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea
          ref={chatTranscriptScrollRef}
          className="h-full min-h-0 px-5 py-4"
          onScroll={onTranscriptScroll}
        >
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-1">
            {activeConv.messages.map((msg, idx) => (
              <MessageBubble
                key={`${msg.role}-${msg.time}-${idx}`}
                msg={msg}
                onOpenSource={onOpenSource}
              />
            ))}
            {desktopLiveTurn && desktopLiveTurn.sessionId === activeConv.id ? <LiveChatTurnCard key={desktopLiveTurn.id} turn={desktopLiveTurn} /> : null}
          </motion.div>
        </ScrollArea>
      </div>

      <div className="shrink-0 px-5 pb-4 pt-3">
        <div className="app-composer-shell rounded-[26px] p-3">
          <div className="relative">
            {filteredChatSlashCommands.length > 0 ? (
              <ComposerSlashMenu
                items={filteredChatSlashCommands}
                selectedIndex={Math.min(chatSlashMenuIndex, filteredChatSlashCommands.length - 1)}
                onSelect={acceptChatSlashCommand}
              />
            ) : null}
            <div
              className={cn(
                'app-composer-input rounded-[18px] transition',
                chatComposerAttachments.length > 0 ? 'px-3 pb-1.5 pt-1' : 'px-4 py-2.5',
              )}
            >
              <input
                ref={chatAttachmentInputRef}
                type="file"
                multiple
                className="hidden"
                disabled={activeConversationIsBridge}
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  if (files.length > 0) {
                    void saveDesktopAttachments(files);
                  }
                  event.currentTarget.value = '';
                }}
              />
              {chatComposerAttachments.length > 0 ? (
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {chatComposerAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[color:var(--app-divider)] bg-[color:var(--app-control-bg)] px-2.5 text-[11px] text-[color:var(--utility-foreground)]"
                    >
                      {attachment.kind === 'image' ? <ImageIcon className="h-3.5 w-3.5 shrink-0 text-sky-300" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
                      <span className="max-w-[220px] truncate leading-none">{attachment.name}</span>
                      <button
                        type="button"
                        onClick={() => removeChatComposerAttachment(attachment.id)}
                        className="text-[color:var(--utility-muted-text)] transition hover:text-[color:var(--utility-foreground)]"
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                rows={1}
                value={chatComposerText}
                onChange={(event) => updateChatComposerDraft(event.target.value, event.target)}
                onPaste={(event) => {
                  if (activeConversationIsBridge) return;
                  const files = Array.from(event.clipboardData.files ?? []);
                  if (files.length > 0) {
                    event.preventDefault();
                    void saveDesktopAttachments(files);
                  }
                }}
                onKeyDown={(event) => {
                  if (filteredChatSlashCommands.length > 0) {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setChatSlashMenuIndex((current) => (current + 1) % filteredChatSlashCommands.length);
                      return;
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setChatSlashMenuIndex((current) => (current - 1 + filteredChatSlashCommands.length) % filteredChatSlashCommands.length);
                      return;
                    }
                    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                      event.preventDefault();
                      acceptChatSlashCommand(filteredChatSlashCommands[Math.min(chatSlashMenuIndex, filteredChatSlashCommands.length - 1)]?.value ?? filteredChatSlashCommands[0].value);
                      return;
                    }
                  }
                  if (event.key === 'Escape' && filteredChatSlashCommands.length > 0) {
                    event.preventDefault();
                    setChatComposerText('/');
                    return;
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    onSendChatMessage();
                  }
                }}
                className="max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-0 py-0 text-[15px] leading-6 text-[color:var(--utility-foreground)] outline-none placeholder:text-[color:var(--utility-muted-text)]"
                placeholder="Message a person, an agent, or delegate a task…"
              />
            </div>
          </div>
          <div ref={composerControlsRef} className="app-composer-meta mt-2 flex items-center justify-between gap-3 pt-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-visible">
              <Button
                size="icon"
                variant="secondary"
                className="app-icon-button h-9 w-9 rounded-full border-0"
                onClick={() => chatAttachmentInputRef.current?.click()}
                title={activeConversationIsBridge ? 'Bridge attachments are not supported yet' : 'Add attachment'}
                aria-label="Add attachment"
                disabled={activeConversationIsBridge}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex min-w-0 items-center gap-2 overflow-visible">
              {!activeConversationIsBridge && isNativeShell ? (
                <ComposerRuntimeStatus
                  contextStatus={activeRuntimeContextStatus}
                  cacheText={activeRuntimeCacheText}
                />
              ) : null}
              {!activeConversationIsBridge ? (
                <ComposerModelControls
                  scope="chat"
                  selection={composerSelection}
                  openSelector={openComposerSelector}
                  onToggleSelector={toggleComposerSelector}
                  onSelectValue={(scope, type, value) => {
                    void selectComposerValue(scope, type, value);
                  }}
                  authLabel={composerAuthLabel}
                  authOptions={composerAuthOptions}
                  onSelectAuthChoice={(scope, providerId, choice) => {
                    void selectComposerAuthChoice(scope, providerId, choice);
                  }}
                  onSelectProviderChoice={(scope, option) => {
                    void selectComposerProviderChoice(scope, option);
                  }}
                  providerOptions={composerProviderOptions}
                  modelOptions={chatModelOptions && chatModelOptions.length > 0 ? chatModelOptions : undefined}
                />
              ) : null}
              <Button
                className={cn(
                  'app-composer-send h-10 w-10 rounded-full p-0',
                  isDesktopChatSending && !activeConversationIsBridge ? 'bg-rose-500/90 text-white hover:bg-rose-500' : '',
                )}
                onClick={() => {
                  if (isDesktopChatSending && !activeConversationIsBridge) {
                    onStopDesktopChatTurn();
                    return;
                  }
                  onSendChatMessage();
                }}
                disabled={activeConversationIsBridge ? isDesktopChatSending : (isDesktopChatSending ? !desktopLiveTurn || desktopLiveTurn.completed : false)}
              >
                {isDesktopChatSending && !activeConversationIsBridge ? <Square className="h-3.5 w-3.5 fill-current" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
