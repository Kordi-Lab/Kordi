import { forwardMessageAction, type MessageActionSource } from './messageActionMetadata';

export function createForwardedMessageDraft({
  source,
  caption,
}: {
  source: MessageActionSource;
  caption?: string;
  destinationSessionId: string;
}) {
  const text = caption?.trim()
    || source.textPreview
    || `${source.attachmentCount} attachment${source.attachmentCount === 1 ? '' : 's'}`;
  const messageAction = forwardMessageAction(source);
  return {
    text,
    forwardedFrom: source,
    messageAction,
  };
}
