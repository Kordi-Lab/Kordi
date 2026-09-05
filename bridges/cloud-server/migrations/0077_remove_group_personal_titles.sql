UPDATE cloud_chat_conversation_members AS member
SET personal_title = NULL,
    preferences_version = preferences_version + 1
FROM cloud_chat_conversations AS conversation
WHERE conversation.conversation_id = member.conversation_id
  AND conversation.kind = 'group'
  AND member.personal_title IS NOT NULL;
