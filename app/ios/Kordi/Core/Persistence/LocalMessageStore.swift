import Foundation
import SwiftData

private func scopedCacheRecordID(accountId: String, entityId: String) -> String {
    "\(accountId.count):\(accountId)\(entityId)"
}

@Model
final class CachedConversationRecord {
    @Attribute(.unique) var id: String
    var accountId: String = ""
    var conversationId: String = ""
    var kind: String
    var peerAccountId: String
    var agentId: String?
    var ownerDisplayName: String?
    var displayName: String
    var lastMessage: String
    var lastActivityAt: Date
    var unreadCount: Int
    var avatarURL: String?
    var agentActivity: String?
    var sessionId: String
    var agentDisplayName: String?
    var groupSpaceId: String?
    var groupParticipantsJSON: String?
    var messageCount: Int?
    var forkedFromSessionId: String?

    init(accountId: String, conversation: ConversationSummary) {
        id = scopedCacheRecordID(accountId: accountId, entityId: conversation.id)
        self.accountId = accountId
        conversationId = conversation.id
        kind = conversation.kind.rawValue
        peerAccountId = conversation.peerAccountId
        agentId = conversation.agentId
        ownerDisplayName = conversation.ownerDisplayName
        displayName = conversation.displayName
        lastMessage = conversation.lastMessage
        lastActivityAt = conversation.lastActivityAt
        unreadCount = conversation.unreadCount
        avatarURL = conversation.avatarSource
        agentActivity = conversation.agentActivity?.rawValue
        sessionId = conversation.sessionId
        agentDisplayName = conversation.agentDisplayName
        groupSpaceId = conversation.groupSpaceId
        messageCount = conversation.messageCount
        forkedFromSessionId = conversation.forkedFromSessionId
        groupParticipantsJSON = try? String(
            data: JSONEncoder().encode(conversation.groupParticipants),
            encoding: .utf8
        )
    }

    var value: ConversationSummary? {
        guard let kind = ConversationKind(rawValue: kind) else { return nil }
        let groupParticipants = groupParticipantsJSON
            .flatMap { $0.data(using: .utf8) }
            .flatMap { try? JSONDecoder().decode([CloudGroupParticipant].self, from: $0) }
            ?? []
        return ConversationSummary(
            id: conversationId,
            kind: kind,
            peerAccountId: peerAccountId,
            agentId: agentId,
            ownerDisplayName: ownerDisplayName,
            displayName: displayName,
            lastMessage: lastMessage,
            lastActivityAt: lastActivityAt,
            unreadCount: unreadCount,
            avatarSource: avatarURL,
            agentActivity: agentActivity.flatMap(AgentActivity.init(rawValue:)),
            sessionId: sessionId,
            agentDisplayName: agentDisplayName,
            groupSpaceId: groupSpaceId,
            groupParticipants: groupParticipants,
            messageCount: messageCount,
            forkedFromSessionId: forkedFromSessionId
        )
    }
}

@Model
final class CachedMessageRecord {
    @Attribute(.unique) var id: String
    var accountId: String = ""
    var messageId: String = ""
    var conversationId: String
    var author: String
    var authorName: String
    var text: String
    var createdAt: Date
    var deliveryState: String
    var errorMessage: String?
    var requestMessageId: String?
    var readByCount: Int?
    var readByAccountIdsJSON: String?
    var attachmentsJSON: String?
    var replyToMessageId: String?
    var messageActionJSON: String?
    var messageKind: String?
    var agentExecutionJSON: String?
    var backgroundAgentSessionsJSON: String?

    init(accountId: String, message: ChatMessage) {
        id = scopedCacheRecordID(accountId: accountId, entityId: message.id)
        self.accountId = accountId
        messageId = message.id
        conversationId = message.conversationId
        author = message.author.rawValue
        authorName = message.authorName
        text = message.text
        createdAt = message.createdAt
        deliveryState = message.deliveryState.rawValue
        errorMessage = message.errorMessage
        requestMessageId = message.requestMessageId
        readByCount = message.readByCount
        readByAccountIdsJSON = Self.encode(message.readByAccountIds)
        attachmentsJSON = Self.encode(message.attachments)
        replyToMessageId = message.replyToMessageId
        messageActionJSON = Self.encode(message.messageAction)
        messageKind = message.messageKind
        agentExecutionJSON = Self.encode(message.agentExecution)
        backgroundAgentSessionsJSON = Self.encode(message.backgroundAgentSessions)
    }

    func update(from message: ChatMessage) {
        conversationId = message.conversationId
        author = message.author.rawValue
        authorName = message.authorName
        text = message.text
        createdAt = message.createdAt
        deliveryState = message.deliveryState.rawValue
        errorMessage = message.errorMessage
        requestMessageId = message.requestMessageId
        readByCount = message.readByCount
        readByAccountIdsJSON = Self.encode(message.readByAccountIds)
        attachmentsJSON = Self.encode(message.attachments)
        replyToMessageId = message.replyToMessageId
        messageActionJSON = Self.encode(message.messageAction)
        messageKind = message.messageKind
        agentExecutionJSON = Self.encode(message.agentExecution)
        backgroundAgentSessionsJSON = Self.encode(message.backgroundAgentSessions)
    }

    var value: ChatMessage? {
        guard messageKind != CloudMessageCodec.agentSessionIdentityMessageKind,
              let author = MessageAuthor(rawValue: author),
              let state = MessageDeliveryState(rawValue: deliveryState) else { return nil }
        return ChatMessage(
            id: messageId,
            conversationId: conversationId,
            author: author,
            authorName: authorName,
            text: text,
            createdAt: createdAt,
            deliveryState: state,
            errorMessage: errorMessage,
            requestMessageId: requestMessageId,
            readByCount: readByCount,
            readByAccountIds: Self.decode([String].self, from: readByAccountIdsJSON) ?? [],
            attachments: Self.decode([ChatAttachment].self, from: attachmentsJSON) ?? [],
            replyToMessageId: replyToMessageId,
            messageAction: Self.decode(MessageActionMetadata.self, from: messageActionJSON),
            messageKind: messageKind,
            agentExecution: Self.decode(
                AgentExecutionSnapshot.self,
                from: agentExecutionJSON
            ),
            backgroundAgentSessions: Self.decode(
                [BackgroundAgentSession].self,
                from: backgroundAgentSessionsJSON
            ) ?? []
        )
    }

    private static func encode<T: Encodable>(_ value: T) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func decode<T: Decodable>(_ type: T.Type, from value: String?) -> T? {
        guard let data = value?.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

@MainActor
final class LocalMessageStore {
    private let container: ModelContainer
    private var context: ModelContext { container.mainContext }
    private var conversationFingerprints: [String: Int] = [:]
    private var messageFingerprints: [String: [String: Int]] = [:]

    init(inMemory: Bool = false) throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: inMemory)
        container = try ModelContainer(
            for: CachedConversationRecord.self,
            CachedMessageRecord.self,
            configurations: configuration
        )
        context.autosaveEnabled = false
        purgeLegacyRecords()
    }

    func loadConversations(accountId: String) -> [ConversationSummary] {
        guard !accountId.isEmpty else { return [] }
        let scope = accountId
        let descriptor = FetchDescriptor<CachedConversationRecord>(
            predicate: #Predicate { $0.accountId == scope },
            sortBy: [SortDescriptor(\.lastActivityAt, order: .reverse)]
        )
        let conversations = (try? context.fetch(descriptor))?.compactMap(\.value) ?? []
        conversationFingerprints[accountId] = fingerprint(conversations)
        return conversations
    }

    func loadMessages(accountId: String, conversationId: String) -> [ChatMessage] {
        guard !accountId.isEmpty else { return [] }
        let scope = accountId
        let conversation = conversationId
        let descriptor = FetchDescriptor<CachedMessageRecord>(
            predicate: #Predicate {
                $0.accountId == scope && $0.conversationId == conversation
            },
            sortBy: [SortDescriptor(\.createdAt)]
        )
        let messages = (try? context.fetch(descriptor))?.compactMap(\.value) ?? []
        messageFingerprints[accountId, default: [:]][conversationId] = fingerprint(messages)
        return messages
    }

    func saveConversations(_ conversations: [ConversationSummary], accountId: String) {
        guard !accountId.isEmpty else { return }
        let nextFingerprint = fingerprint(conversations)
        guard nextFingerprint != conversationFingerprints[accountId] else { return }
        do {
            let scope = accountId
            let existing = try context.fetch(FetchDescriptor<CachedConversationRecord>(
                predicate: #Predicate { $0.accountId == scope }
            ))
            existing.forEach(context.delete)
            conversations.forEach {
                context.insert(CachedConversationRecord(accountId: accountId, conversation: $0))
            }
            try context.save()
            conversationFingerprints[accountId] = nextFingerprint
        } catch {
            context.rollback()
        }
    }

    func saveMessages(_ messages: [ChatMessage], conversationId: String, accountId: String) {
        guard !accountId.isEmpty else { return }
        let nextFingerprint = fingerprint(messages)
        guard nextFingerprint != messageFingerprints[accountId]?[conversationId] else { return }
        do {
            let scope = accountId
            let conversation = conversationId
            let descriptor = FetchDescriptor<CachedMessageRecord>(
                predicate: #Predicate {
                    $0.accountId == scope && $0.conversationId == conversation
                }
            )
            let existing = try context.fetch(descriptor)
            var existingById = Dictionary(uniqueKeysWithValues: existing.map { ($0.messageId, $0) })
            for message in messages {
                if let record = existingById.removeValue(forKey: message.id) {
                    if record.value != message { record.update(from: message) }
                } else {
                    context.insert(CachedMessageRecord(accountId: accountId, message: message))
                }
            }
            for stale in existingById.values { context.delete(stale) }
            try context.save()
            messageFingerprints[accountId, default: [:]][conversationId] = nextFingerprint
        } catch {
            context.rollback()
        }
    }

    func clear(accountId: String) {
        guard !accountId.isEmpty else { return }
        do {
            let scope = accountId
            let conversations = try context.fetch(FetchDescriptor<CachedConversationRecord>(
                predicate: #Predicate { $0.accountId == scope }
            ))
            let messages = try context.fetch(FetchDescriptor<CachedMessageRecord>(
                predicate: #Predicate { $0.accountId == scope }
            ))
            conversations.forEach(context.delete)
            messages.forEach(context.delete)
            try context.save()
            conversationFingerprints[accountId] = nil
            messageFingerprints[accountId] = nil
        } catch {
            context.rollback()
        }
    }

    private func purgeLegacyRecords() {
        do {
            let legacyScope = ""
            let conversations = try context.fetch(FetchDescriptor<CachedConversationRecord>(
                predicate: #Predicate { $0.accountId == legacyScope }
            ))
            let messages = try context.fetch(FetchDescriptor<CachedMessageRecord>(
                predicate: #Predicate { $0.accountId == legacyScope }
            ))
            guard !conversations.isEmpty || !messages.isEmpty else { return }
            conversations.forEach(context.delete)
            messages.forEach(context.delete)
            try context.save()
        } catch {
            context.rollback()
        }
    }

    private func fingerprint<T: Hashable>(_ values: [T]) -> Int {
        var hasher = Hasher()
        hasher.combine(values.count)
        for value in values { hasher.combine(value) }
        return hasher.finalize()
    }
}
