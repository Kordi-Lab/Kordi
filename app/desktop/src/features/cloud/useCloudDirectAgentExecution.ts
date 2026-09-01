import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { cloudAgentContextMessagesFromDefinition } from '@/features/chat/chatCreateFlows';
import {
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import { startDesktopSharedChatMessage } from '@/lib/desktopBackgroundSessions';
import type {
  Contact,
  DesktopChatTurnSnapshot,
} from '@/kordi-app/types';
import type {
  CloudAccount,
  CloudAuthClient,
  CloudMessage,
} from './authClient';
import type { CloudAgentDefinition } from './cloudAgents';
import { canonicalAvatarImageSource } from './canonicalAvatar';
import {
  resolveCloudMessageAttachments,
} from './cloudAttachments';
import {
  cloudAgentNativeContextMessagesFromDirectCloudSession,
  cloudAgentNoProviderNoticeText,
  encodeCloudAgentResponse,
  isCloudAgentNoProviderConfiguredError,
  promptTextForCloudAgentMention,
} from './cloudAgentMessages';
import { cloudAgentBackgroundSessionsFromTurn } from './cloudAgentBackgroundSessions';
import {
  cloudAgentRuntimeRouteForTargetCloudAgent,
  cloudAgentRuntimeSessionId,
} from './cloudAgentRuntime';
import {
  cloudDirectMessageAgentRuntimeRoute,
  cloudDirectMessageDisplayText,
  cloudDirectMessageTargetCloudAgentId,
} from './cloudDirectMessages';
import {
  cloudAgentFailedTurnSnapshot,
  cloudAgentResponsePublicationIsBlocked,
  publishDerivedCloudSessionActivity,
  waitForCloudAgentTurn,
} from './cloudAgentLocalExecution';
import {
  cloudVisibleTaskRecordsForSession,
  mergeCloudSessionActivity,
  type CloudSessionActivityStore,
} from './cloudSessionActivity';
import type { CloudMessageIndex } from './cloudMessageIndex';
import {
  shouldRunLocalCloudAgentForCloudMessage,
} from './cloudAgentMentionPolicy';
import { cloudSessionIdForCollaborationSend } from './cloudCollaborationState';
import { loadSession } from './session';

export function useCloudDirectAgentExecution({
  account,
  client,
  cloudAgentDefinitionsById,
  cloudAgentRuntimeRoutesBySessionId,
  cloudLookupContacts,
  cloudMessageIndex,
  defaultCloudAgentRuntimeRoute,
  initialMessagesSettled,
  processedRequestIdsRef,
  turnIdsByRequestIdRef,
  activityRef,
  setLocalTurns,
  setActivity,
  mergeMessage,
  syncMessages,
  reportWarning,
}: {
  account: CloudAccount | null;
  client: CloudAuthClient;
  cloudAgentDefinitionsById: Record<string, CloudAgentDefinition>;
  cloudAgentRuntimeRoutesBySessionId?: Record<string, DesktopChatMessageRoute>;
  cloudLookupContacts: Contact[];
  cloudMessageIndex: CloudMessageIndex;
  defaultCloudAgentRuntimeRoute?: DesktopChatMessageRoute | null;
  initialMessagesSettled: boolean;
  processedRequestIdsRef: MutableRefObject<Set<string>>;
  turnIdsByRequestIdRef: MutableRefObject<Map<string, string>>;
  activityRef: MutableRefObject<CloudSessionActivityStore>;
  setLocalTurns: Dispatch<
    SetStateAction<Record<string, DesktopChatTurnSnapshot>>
  >;
  setActivity: Dispatch<SetStateAction<CloudSessionActivityStore>>;
  mergeMessage: (message: CloudMessage) => void;
  syncMessages: () => Promise<void>;
  reportWarning: (message: string, error: unknown) => void;
}) {
  useEffect(() => {
    if (!account || !initialMessagesSettled) return;
    for (const [peerId, messages] of cloudMessageIndex.byPeerId) {
      for (const message of messages) {
        if (!shouldRunLocalCloudAgentForCloudMessage({
          account,
          isGroupControl: cloudMessageIndex.groupRowByWireMessageId.has(
            message.messageId,
          ),
          peerId,
          message,
          peerMessages: messages,
        })) continue;
        if (processedRequestIdsRef.current.has(message.messageId)) continue;

        processedRequestIdsRef.current.add(message.messageId);
        const contact = cloudLookupContacts.find((candidate) => (
          candidate.sourceParticipantId
          || candidate.id.replace(/^cloud:/, '')
        ) === peerId);
        const peerHumanName = contact?.name?.trim()
          || contact?.owner?.trim()
          || peerId;
        const activitySessionId = message.sessionId
          ?? cloudSessionIdForCollaborationSend(
            account.accountId,
            peerId,
            `cloud:${peerId}`,
          );
        const targetCloudAgentId =
          cloudDirectMessageTargetCloudAgentId(message.body);
        const directDisplayMessage = {
          ...message,
          body: cloudDirectMessageDisplayText(message.body),
        };
        const prompt = promptTextForCloudAgentMention(
          directDisplayMessage.body,
        );
        const contextMessages = [
          ...cloudAgentContextMessagesFromDefinition(
            cloudAgentDefinitionsById[targetCloudAgentId ?? ''] ?? null,
          ),
          ...cloudAgentNativeContextMessagesFromDirectCloudSession({
            messages,
            requestMessage: message,
            localAccountId: account.accountId,
            localHumanName:
              account.displayName || account.primaryEmail || 'Me',
            peerHumanName,
            localAgentName: account.defaultAgent?.displayName || 'Kordi',
            peerAgentName: contact?.targetCloudAgentName || 'Kordi',
          }),
        ];
        const visibleTaskRecords = activitySessionId
          ? cloudVisibleTaskRecordsForSession(
            activityRef.current,
            activitySessionId,
          )
          : [];
        const runtimeSessionId = cloudAgentRuntimeSessionId(
          account.accountId,
          activitySessionId ?? peerId,
        );
        if (!runtimeSessionId) continue;
        const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
          setLocalTurns((current) => ({
            ...current,
            [message.messageId]: turn,
          }));
        };
        void (async () => {
          let session: Awaited<ReturnType<typeof loadSession>>;
          try {
            session = await loadSession();
          } catch (error) {
            rememberLocalTurn(cloudAgentFailedTurnSnapshot({
              requestId: message.messageId,
              sessionId: runtimeSessionId,
              prompt,
              error,
            }));
            reportWarning(
              '[cloud-agent-mention] local session unavailable',
              error,
            );
            return;
          }
          if (!session?.token) {
            rememberLocalTurn(cloudAgentFailedTurnSnapshot({
              requestId: message.messageId,
              sessionId: runtimeSessionId,
              prompt,
              error: new Error('Not signed in.'),
            }));
            return;
          }

          // Start these remote guards without awaiting them. Local provider
          // readiness and execution must not sit behind Cloud latency; the
          // guards only decide whether the completed response still needs to
          // be published.
          const responseGuardPromise = cloudAgentResponsePublicationIsBlocked({
            client,
            token: session.token,
            peerId,
            fallbackMessages: messages,
            account,
            requestMessageId: message.messageId,
          });

          let finalTurn: DesktopChatTurnSnapshot;
          try {
            const agentAttachments = message.attachments?.length
              ? await resolveCloudMessageAttachments({
                token: session.token,
                client,
                attachments: message.attachments,
              })
              : message.attachments ?? [];
            const agentAttachmentPaths = agentAttachments
              .map((attachment) => attachment.localPath?.trim() || '')
              .filter(Boolean);
            const startedTurn = await startDesktopSharedChatMessage(
              message.messageId,
              runtimeSessionId,
              prompt,
              agentAttachmentPaths,
              cloudAgentRuntimeRouteForTargetCloudAgent({
                targetCloudAgentId,
                cloudAgentDefinitionsById,
                routesByRuntimeSessionId: cloudAgentRuntimeRoutesBySessionId,
                runtimeSessionId,
                fallbackRoute: defaultCloudAgentRuntimeRoute,
                requestRoute: cloudDirectMessageAgentRuntimeRoute(message.body),
              }),
              contextMessages,
              visibleTaskRecords,
              activitySessionId,
            );
            rememberLocalTurn(startedTurn);
            turnIdsByRequestIdRef.current.set(
              message.messageId,
              startedTurn.id,
            );
            finalTurn = startedTurn.completed
              ? startedTurn
              : await waitForCloudAgentTurn(
                startedTurn.id,
                rememberLocalTurn,
              );
            rememberLocalTurn(finalTurn);
          } catch (error) {
            finalTurn = cloudAgentFailedTurnSnapshot({
              requestId: message.messageId,
              sessionId: runtimeSessionId,
              prompt,
              error,
            });
            rememberLocalTurn(finalTurn);
            reportWarning(
              '[cloud-agent-mention] local agent response failed',
              error,
            );
          } finally {
            turnIdsByRequestIdRef.current.delete(message.messageId);
          }

          if (finalTurn.status === 'cancelled') {
            void syncMessages();
            return;
          }

          try {
            const [initialResponseBlocked, finalResponseBlocked] =
              await Promise.all([
                responseGuardPromise,
                cloudAgentResponsePublicationIsBlocked({
                  client,
                  token: session.token,
                  peerId,
                  fallbackMessages: messages,
                  account,
                  requestMessageId: message.messageId,
                }),
              ] as const);
            if (initialResponseBlocked || finalResponseBlocked) {
              void syncMessages();
              return;
            }
            if (activitySessionId) {
              await publishDerivedCloudSessionActivity({
                client,
                token: session.token,
                accountId: account.accountId,
                sessionId: activitySessionId,
                participantAccountIds: [peerId],
                participantProfiles: [
                  {
                    accountId: account.accountId,
                    displayName:
                      account.displayName
                      || account.primaryEmail
                      || account.accountId,
                    avatarUrl: canonicalAvatarImageSource(account.avatar),
                    role: 'self',
                  },
                  {
                    accountId: peerId,
                    displayName: peerHumanName,
                    avatarUrl: contact?.profileImageUrl ?? null,
                    role: 'person',
                  },
                ],
                turn: finalTurn,
                mergeActivity: (snapshot) => {
                  setActivity((current) =>
                    mergeCloudSessionActivity(current, snapshot)
                  );
                },
                reportWarning,
              });
            }
            const responseSucceeded =
              finalTurn.succeeded
              && finalTurn.assistantText.trim().length > 0;
            const responseText = responseSucceeded
              ? finalTurn.assistantText.trim()
              : isCloudAgentNoProviderConfiguredError(
                finalTurn.error || finalTurn.message,
              )
                ? cloudAgentNoProviderNoticeText()
                : `Failed: ${
                  finalTurn.error
                  || finalTurn.message
                  || 'Cloud agent returned no text response'
                }`;
            const response = await client.sendMessage(
              session.token,
              peerId,
              encodeCloudAgentResponse({
                requestId: message.messageId,
                text: responseText,
                deliveryState: responseSucceeded ? 'complete' : 'failed',
                backgroundSessions: cloudAgentBackgroundSessionsFromTurn(finalTurn),
              }),
              { sessionId: message.sessionId ?? null },
            );
            mergeMessage(response);
            void syncMessages();
          } catch (error) {
            // The local turn is already terminal and visible. A Cloud publish
            // failure must not rerun the model or return the UI to Processing.
            reportWarning(
              '[cloud-agent-mention] response publish failed',
              error,
            );
          }
        })();
      }
    }
  }, [
    account,
    activityRef,
    client,
    cloudAgentDefinitionsById,
    cloudAgentRuntimeRoutesBySessionId,
    cloudLookupContacts,
    cloudMessageIndex,
    defaultCloudAgentRuntimeRoute,
    initialMessagesSettled,
    mergeMessage,
    processedRequestIdsRef,
    reportWarning,
    setActivity,
    setLocalTurns,
    syncMessages,
    turnIdsByRequestIdRef,
  ]);
}
