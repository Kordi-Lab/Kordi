import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import test from 'node:test';

const chatMessagesSource = () => readFileSync(new URL('../src/features/chat/messageActions/chatMessages.ts', import.meta.url), 'utf8');
const cloudBridgeSource = () => readFileSync(new URL('../src/features/cloud/useCloudCollaborationState.ts', import.meta.url), 'utf8');
const cloudGroupControlSenderSource = () => readFileSync(
  new URL(
    '../src/features/cloud/useCloudGroupControlSender.ts',
    import.meta.url,
  ),
  'utf8',
);
const cloudGroupOutboxSource = () => readFileSync(new URL('../src/features/cloud/cloudGroupOutbox.ts', import.meta.url), 'utf8');
const cloudOutboxDeliverySource = () => readFileSync(new URL('../src/features/cloud/useCloudGroupOutboxDelivery.ts', import.meta.url), 'utf8');

test('plain cloud group messages send through cloud group transport instead of falling through to unavailable', () => {
  const source = chatMessagesSource();
  const mentionBranch = source.indexOf('if (activeConversationUsesCollaborationRouting && shouldRouteMentionThroughCloudGroup({');
  const unavailableBranch = source.indexOf("if (activeConversationUsesCollaborationRouting && !localAgentMentioned)", mentionBranch);
  assert.notEqual(mentionBranch, -1, 'expected cloud group mention branch');
  assert.notEqual(unavailableBranch, -1, 'expected unavailable bridge-routing fallback branch');

  const between = source.slice(mentionBranch, unavailableBranch);
  assert.match(
    between,
    /activeGroupSessionIsGroup[\s\S]*cloudGroupTargetIds\.length > 0[\s\S]*kind:\s*'group-message'/,
    'plain cloud group messages with resolved cloud recipients must be sent as group-message controls before unavailable fallback',
  );
});

test('active composer sends prefer Cloud group routing before direct Cloud bridge routing', () => {
  const source = chatMessagesSource();
  const activeStart = source.indexOf('const handleSendChatMessage = useCallback(async (');
  assert.notEqual(activeStart, -1, 'expected active composer send handler');
  const activeEnd = source.indexOf('const isTransientDraftConversation = isLocalDraftChatConversationId(activeConvId);', activeStart);
  assert.notEqual(activeEnd, -1, 'expected local-send section after bridge routing');
  const bridgeRoutingSection = source.slice(activeStart, activeEnd);

  const normalSendStart = bridgeRoutingSection.indexOf('if (activeLocalTurnShouldDelayChatSend({');
  assert.notEqual(normalSendStart, -1, 'expected normal send path after retry handling');
  const normalSendSection = bridgeRoutingSection.slice(normalSendStart);
  const directCloudBranch = normalSendSection.indexOf('if (activeConversationUsesCollaborationRouting && isCloudCollaborationConversationId(activeConvId))');
  const mentionGroupBranch = normalSendSection.indexOf('if (activeConversationUsesCollaborationRouting && shouldRouteMentionThroughCloudGroup({');
  const plainGroupSend = normalSendSection.indexOf("kind: 'group-message'", mentionGroupBranch + 1);

  assert.notEqual(directCloudBranch, -1, 'expected direct Cloud bridge branch');
  assert.notEqual(mentionGroupBranch, -1, 'expected Cloud group mention branch');
  assert.notEqual(plainGroupSend, -1, 'expected Cloud group send before local fallback');
  assert.ok(
    mentionGroupBranch < directCloudBranch && plainGroupSend < directCloudBranch,
    'active composer must route Cloud group sessions before direct Cloud bridge sends; otherwise group messages are stored as plain direct messages',
  );
});

test('cloud group messages stay sending until the persistent recipient outbox reports delivery', () => {
  const source = chatMessagesSource();
  const cloudGroupPreparations = [...source.matchAll(/'cloud-group-ui',\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(cloudGroupPreparations.length >= 3, 'expected targeted and active group send preparations');
  assert.deepEqual([...new Set(cloudGroupPreparations)], ['sending']);

  const bridgeSource = cloudBridgeSource();
  const groupSenderSource = cloudGroupControlSenderSource();
  assert.match(bridgeSource, /new CloudGroupOutbox/);
  assert.match(groupSenderSource, /clientMessageId,/);
  assert.match(groupSenderSource, /persistOutboxDelivery/);
  assert.match(cloudGroupOutboxSource(), /clientMessageId:\s*`\$\{entry\.canonicalMessageId\}:\$\{recipientId\}`/);
});

test('outbox delivery persistence mutates the exact canonical message without loading a transcript page', () => {
  const source = cloudOutboxDeliverySource();
  const start = source.indexOf('const persistCloudGroupOutboxDelivery = useCallback');
  const end = source.indexOf('\n\n  useEffect(() => {', start);
  assert.notEqual(start, -1, 'expected the outbox delivery persistence closure');
  assert.notEqual(end, -1, 'expected the next effect after outbox persistence');
  const persistence = source.slice(start, end);

  assert.match(
    persistence,
    /if \(entry\.trackCanonicalDelivery === false\) \{[\s\S]*?await outbox\?\.acknowledgeCanonicalDelivery\([\s\S]*?entry\.canonicalMessageId,[\s\S]*?\);[\s\S]*?return;/,
    'untracked terminal sends should acknowledge without invoking native storage',
  );
  assert.match(persistence, /cloudGroupOutboxDeliveryStatus\(entry\)/);
  assert.match(persistence, /await updateCanonicalMessageDelivery\(\{[\s\S]*?messageId:\s*entry\.canonicalMessageId,[\s\S]*?sessionId:\s*entry\.sessionId,/);
  assert.match(persistence, /if \(!delta\) return;/, 'a missing native row must keep the terminal outbox entry for replay');
  assert.match(persistence, /canonicalStateRef\.current\s*=\s*[\s\S]*?mergeCanonicalMessageDeliveryDelta\(/);
  assert.match(persistence, /setCanonicalState\?\.\(\(current\) =>[\s\S]*?mergeCanonicalMessageDeliveryDelta\(current, delta\)[\s\S]*?\)/);
  assert.doesNotMatch(persistence, /fetchCanonicalSessionMessages/);
  assert.doesNotMatch(persistence, /\b200\b/);
  assert.doesNotMatch(persistence, /upsertCanonicalMessageFast/);
  assert.equal((persistence.match(/setCanonicalState\?\.\(/g) ?? []).length, 1);
  const nativeUpdate = persistence.indexOf('await updateCanonicalMessageDelivery');
  const missingCanonicalGuard = persistence.indexOf('if (!delta) return;');
  const acknowledgement = persistence.lastIndexOf('await outbox?.acknowledgeCanonicalDelivery');
  assert.ok(nativeUpdate >= 0 && acknowledgement > nativeUpdate, 'native persistence must succeed before terminal acknowledgement');
  assert.ok(
    missingCanonicalGuard > nativeUpdate && acknowledgement > missingCanonicalGuard,
    'the outbox must remain durable when the canonical row is not available yet',
  );
});

test('cloud group image sends persist local sources before starting upload', () => {
  const source = cloudGroupControlSenderSource();
  const start = source.indexOf('const sendCloudGroupControl = useCallback');
  const end = source.indexOf(
    '\n\n  useCloudGroupSessionTitleSync({',
    start,
  );
  assert.notEqual(start, -1, 'expected the cloud group send closure');
  assert.notEqual(
    end,
    -1,
    'expected title synchronization after cloud group sending',
  );
  const groupSend = source.slice(start, end);

  const enqueue = groupSend.indexOf('await outbox.enqueue(outboxEntry)');
  const firstUpload = groupSend.indexOf('uploadComposerAttachments');
  assert.match(
    groupSend,
    /pendingAttachments:\s*cloudGroupOutboxAttachmentSources\(\s*input\.attachments \?\? \[\],?\s*\)/,
  );
  assert.ok(enqueue >= 0 && firstUpload > enqueue, 'attachment upload must not begin before the local source is durable');
  assert.match(groupSend, /prepareCloudGroupOutboxEntryAttachments\(/);
  assert.match(groupSend, /clientMessageId,/);
});

test('group send failures upsert a durable failed canonical row with retry recipients', () => {
  const source = chatMessagesSource();
  assert.match(source, /function persistCanonicalGroupMessageFailure[\s\S]*await upsertCanonicalMessage\(request\);/);
  assert.match(source, /deliveryState:\s*'failed'/);
  assert.match(source, /exhaustedRecipientIds:/);
  assert.ok(
    (source.match(/await persistCanonicalGroupMessageFailure\(/g) ?? []).length >= 3,
    'targeted, mentioned, and normal group sends must all persist terminal failures',
  );
});
