import type { CloudAuthClient, CloudMessage } from './authClient';
import { encodeCloudAgentResponse } from './cloudAgentMessages';
import type {
  CloudBackgroundFollowUpReply,
  CloudDirectBackgroundFollowUpRoute,
} from './cloudBackgroundFollowUps';

/** Sends a background follow-up reply into the direct chat of its parent request. */
export async function publishCloudDirectBackgroundFollowUp(
  {
    client,
    token,
    mergeMessage,
    syncMessages,
  }: {
    client: Pick<CloudAuthClient, 'sendMessage'>;
    token: string;
    mergeMessage: (message: CloudMessage) => void;
    syncMessages: () => Promise<void>;
  },
  route: CloudDirectBackgroundFollowUpRoute,
  reply: CloudBackgroundFollowUpReply,
): Promise<void> {
  const response = await client.sendMessage(
    token,
    route.peerId,
    encodeCloudAgentResponse({
      requestId: reply.requestId,
      text: reply.text,
      deliveryState: reply.deliveryState,
      messageAction: route.messageAction,
    }),
    {
      sessionId: route.sessionId,
      clientMessageId: `shared:${route.requestMessageId}:${reply.requestId}`,
    },
  );
  mergeMessage(response);
  void syncMessages();
}
