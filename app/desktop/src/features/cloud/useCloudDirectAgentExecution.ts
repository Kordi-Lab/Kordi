import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { useVoiceAgentRequestGate } from './useVoiceAgentRequestGate';
import { acquireDesktopExecutionLease } from './cloudDesktopExecutionLease';
import { publishModelSubsessions } from './agentSubsessionSync';
import { cloudAgentContextMessagesFromDefinition } from '@/features/chat/chatCreateFlows';
import {
  cancelDesktopChatTurn,
  type DesktopChatMessageRoute,
} from '@/lib/desktop';
import {
  desktopSharedRequestAlreadyStarted,
  startDesktopSharedChatMessage,
} from '@/lib/desktopBackgroundSessions';
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
  cloudDirectAgentReplyThreadAction,
  cloudAgentProviderFailureNotice,
  encodeCloudAgentResponse,
  promptTextForCloudAgentMention,
} from './cloudAgentMessages';
import { cloudAgentBackgroundSessionsFromTurn } from './cloudAgentBackgroundSessions';
import {
  registerCloudBackgroundFollowUpHandler,
  type CloudDirectBackgroundFollowUpRoute,
} from './cloudBackgroundFollowUps';
import { publishCloudDirectBackgroundFollowUp } from './cloudDirectBackgroundFollowUp';
import {
  cloudAgentRuntimeSessionId,
} from './cloudAgentRuntime';
import { cloudAgentRuntimeRouteForTargetCloudAgent } from './cloudAgentTargetRuntimeRoute';
import {
  cloudDirectMessageAgentRuntimeRoute,
  cloudDirectMessageDisplayText,
  cloudDirectMessageTargetCloudAgentId,
} from './cloudDirectMessages';
import {
  cloudAgentFailedTurnSnapshot,
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
import { createCloudSharedAgentProgress } from './cloudSharedAgentProgress';
import { cloudAgentTurnReplyText } from './cloudAgentReplyText';
import { useDocumentAgentRequests } from '@/features/documents/useDocumentAgentRequests';
import { useDigestMacRuns } from '@/features/digest/useDigestMacRuns';
import { useScheduledMacRuns } from './useScheduledMacRuns';

export function useCloudDirectAgentExecution({
  account,
  client,
  cloudAgentDefinitionsById,
  cloudAgentRuntimeRoutesBySessionId,
  cloudLookupContacts,
  cloudMessageIndex,
  defaultCloudAgentRuntimeRoute,
  initialMessagesSettled,
  runtimeReady = true,
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
  runtimeReady?: boolean;
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
  const voiceGate = useVoiceAgentRequestGate();
  // Background follow-ups publish from the route their parent registered, so
  // a reloaded webview still delivers them.
  useEffect(() => {
    const accountId = account?.accountId;
    if (!accountId) return;
    return registerCloudBackgroundFollowUpHandler('direct', async (route, reply) => {
      const current = await loadSession();
      if (!current?.token || current.accountId !== accountId || route.accountId !== accountId) return false;
      await publishCloudDirectBackgroundFollowUp({ client, token: current.token, mergeMessage, syncMessages }, route, reply);
      return true;
    });
  }, [account?.accountId, client, mergeMessage, syncMessages]);
  // Comment requests in shared documents run on this Mac like chat mentions.
  useDocumentAgentRequests({
    account, client, agentDefinitionsById: cloudAgentDefinitionsById,
    routesBySessionId: cloudAgentRuntimeRoutesBySessionId,
    defaultRoute: defaultCloudAgentRuntimeRoute, runtimeReady, reportWarning,
  });
  // Digest runs of this account run on this Mac when it has a local provider.
  useDigestMacRuns({ account, client, defaultRoute: defaultCloudAgentRuntimeRoute, runtimeReady, reportWarning });
  // Scheduled tasks of this account run on this Mac while it is ready.
  useScheduledMacRuns({ account, client, defaultRoute: defaultCloudAgentRuntimeRoute, runtimeReady, reportWarning });
  useEffect(() => {
    if (!account || !initialMessagesSettled || !runtimeReady) return;
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
        // A voice message sent without transcription waits (bounded) for the sender's transcript.
        const voice = voiceGate.check(message);
        if (voice === undefined) continue;

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
          directDisplayMessage.body, voice,
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
        const replyMessageAction = cloudDirectAgentReplyThreadAction(messages, message, account.accountId);
        const rememberLocalTurn = (turn: DesktopChatTurnSnapshot) => {
          void publishModelSubsessions(turn).catch(() => undefined);
          setLocalTurns((current) => ({
            ...current,
            [message.messageId]: { ...turn, messageAction: replyMessageAction },
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

          if (!activitySessionId) return;
          const requestedRoute = cloudAgentRuntimeRouteForTargetCloudAgent({
                targetCloudAgentId,
                cloudAgentDefinitionsById,
                routesByRuntimeSessionId: cloudAgentRuntimeRoutesBySessionId,
                runtimeSessionId,
                fallbackRoute: defaultCloudAgentRuntimeRoute,
                requestRoute: cloudDirectMessageAgentRuntimeRoute(message.body),
              });
          const lease = await acquireDesktopExecutionLease(client, session.token, {
            requestMessageId: message.messageId, sessionId: activitySessionId,
            ownerAccountId: account.accountId, requesterAccountId: message.fromAccountId,
            prompt, idempotencyKey: `shared:${message.messageId}:${account.accountId}`,
            runtimeRoute: requestedRoute ? { defaultModel: requestedRoute.model, defaultAuthProvider: requestedRoute.authProvider, defaultAuthChoice: requestedRoute.authChoice, thinking: requestedRoute.thinking } : undefined,
          }).catch((error) => {
            if (message.fromAccountId === account.accountId) rememberLocalTurn(cloudAgentFailedTurnSnapshot({ requestId: message.messageId, sessionId: runtimeSessionId, prompt, error }));
            reportWarning('Agent execution admission failed', error); return null;
          });
          if (!lease) return;
          const token = session.token;
          const progress = createCloudSharedAgentProgress({
            requestId: message.messageId, messageAction: replyMessageAction,
            publish: (body, clientMessageId) => lease.publisher.sendMessage(token, peerId, body, { sessionId: message.sessionId ?? null, clientMessageId }),
            onPublished: mergeMessage,
            onError: (error) => reportWarning('[cloud-agent-mention] progress publish failed', error),
          });
          try {
          if (!await lease.admitted()) return;
          progress.start();
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
              requestedRoute,
              lease.contextMessages(contextMessages),
              visibleTaskRecords,
              activitySessionId,
              lease.deadline,
              {
                kind: 'direct',
                accountId: account.accountId,
                peerId,
                sessionId: message.sessionId ?? null,
                requestMessageId: message.messageId,
                messageAction: replyMessageAction ?? null,
              } satisfies CloudDirectBackgroundFollowUpRoute,
            );
            lease.attach(startedTurn.id);
            lease.onStopRequested(() => { void cancelDesktopChatTurn(startedTurn.id).catch(() => undefined); });
            rememberLocalTurn(startedTurn);
            turnIdsByRequestIdRef.current.set(message.messageId, startedTurn.id);
            progress.update(startedTurn);
            finalTurn = startedTurn.completed
              ? startedTurn
              : await waitForCloudAgentTurn(startedTurn.id, (turn) => {
                rememberLocalTurn(turn);
                progress.update(turn);
              });
            rememberLocalTurn(finalTurn);
            void publishModelSubsessions(finalTurn).catch(() => undefined);
          } catch (error) {
            if (desktopSharedRequestAlreadyStarted(error)) return;
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
            await progress.finish();
          }

          try {
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
            const replyText = cloudAgentTurnReplyText(finalTurn);
            const responseSucceeded = replyText.length > 0;
            const responseText = responseSucceeded
              ? replyText
              : finalTurn.status === 'cancelled'
                ? 'Request stopped.'
              : cloudAgentProviderFailureNotice(finalTurn.error || finalTurn.message)
                ?? `Failed: ${
                  finalTurn.error
                  || finalTurn.message
                  || 'Cloud agent returned no text response'
                }`;
            const response = await lease.publisher.sendMessage(
              session.token,
              peerId,
              encodeCloudAgentResponse({
                requestId: message.messageId,
                text: responseText,
                deliveryState: finalTurn.status === 'cancelled' ? 'cancelled' : responseSucceeded ? 'complete' : 'failed',
                backgroundSessions: cloudAgentBackgroundSessionsFromTurn(finalTurn),
                messageAction: replyMessageAction,
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
          } catch (error) {
            if (message.fromAccountId === account.accountId) rememberLocalTurn(cloudAgentFailedTurnSnapshot({ requestId: message.messageId, sessionId: runtimeSessionId, prompt, error }));
            reportWarning('Agent execution admission failed', error);
          } finally { lease.dispose(); }
        })();
      }
    }
    return voiceGate.scheduleWake();
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
    runtimeReady,
    mergeMessage,
    processedRequestIdsRef,
    reportWarning,
    setActivity,
    setLocalTurns,
    syncMessages,
    turnIdsByRequestIdRef,
    voiceGate,
  ]);
}
