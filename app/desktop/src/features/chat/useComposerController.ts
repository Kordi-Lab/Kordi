import { useComposerInputActions } from './useComposerInputActions';
import { useComposerMessageActions } from './useComposerMessageActions';
import type { UseComposerControllerArgs } from './composerController.types';

export function useComposerController(args: UseComposerControllerArgs) {
  const inputActions = useComposerInputActions(args);
  const messageActions = useComposerMessageActions({
    ...args,
    derived: {
      attachmentSummaryText: inputActions.attachmentSummaryText,
      selectComposerValue: inputActions.selectComposerValue,
      appendProjectDraft: inputActions.setProjectComposerText,
      appendChatDraft: inputActions.setChatComposerText,
    },
  });

  return {
    toggleComposerSelector: inputActions.toggleComposerSelector,
    selectComposerValue: inputActions.selectComposerValue,
    selectComposerAuthChoice: inputActions.selectComposerAuthChoice,
    selectComposerProviderChoice: inputActions.selectComposerProviderChoice,
    updateComposerDraft: inputActions.updateComposerDraft,
    saveDesktopAttachments: inputActions.saveDesktopAttachments,
    saveDesktopAttachmentPaths: inputActions.saveDesktopAttachmentPaths,
    removeChatComposerAttachment: inputActions.removeChatComposerAttachment,
    updateChatComposerAttachment: inputActions.updateChatComposerAttachment,
    setChatComposerText: inputActions.setChatComposerText,
    setProjectComposerText: inputActions.setProjectComposerText,
    acceptChatSlashCommand: messageActions.acceptChatSlashCommand,
    acceptProjectSlashCommand: messageActions.acceptProjectSlashCommand,
    acceptChatMentionTarget: messageActions.acceptChatMentionTarget,
    acceptProjectMentionTarget: messageActions.acceptProjectMentionTarget,
    handleSendChatMessage: messageActions.handleSendChatMessage,
    handleRetryChatMessage: messageActions.handleRetryChatMessage,
    handleSendProjectMessage: messageActions.handleSendProjectMessage,
    handleStopDesktopChatTurn: messageActions.handleStopDesktopChatTurn,
    handleStopCollaborationAgentRequest: messageActions.handleStopCollaborationAgentRequest,
  };
}
