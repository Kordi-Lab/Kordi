import Foundation
import SwiftData

struct LocalMessagePage {
    let messages: [ChatMessage]
    let hasMore: Bool
}

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
    var unreadMentionCount: Int = 0
    var lastReadSequence: Int64 = 0
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
        unreadMentionCount = conversation.unreadMentionCount
        lastReadSequence = conversation.lastReadSequence
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
            forkedFromSessionId: forkedFromSessionId,
            unreadMentionCount: unreadMentionCount,
            lastReadSequence: lastReadSequence
        )
    }
}

@Model
final class CachedMessageRecord {
    @Attribute(.unique) var id: String
    var accountId: String = ""
    var messageId: String = ""
    var conversationId: String
    var conversationSequence: Int64?
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
    var reactionTargetMessageId: String?
    var messageActionJSON: String?
    var messageKind: String?
    var agentExecutionJSON: String?
    var backgroundAgentSessionsJSON: String?
    var reactionsJSON: String?
    var mentionsJSON: String?

    init(accountId: String, message: ChatMessage) {
        id = scopedCacheRecordID(accountId: accountId, entityId: message.id)
        self.accountId = accountId
        messageId = message.id
        conversationId = message.conversationId
        conversationSequence = message.conversationSequence
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
        reactionTargetMessageId = message.reactionTargetMessageId
        messageActionJSON = Self.encode(message.messageAction)
        messageKind = message.messageKind
        agentExecutionJSON = Self.encode(message.agentExecution)
        backgroundAgentSessionsJSON = Self.encode(message.backgroundAgentSessions)
        reactionsJSON = Self.encode(message.reactions)
        mentionsJSON = Self.encode(message.mentions)
    }

    func update(from message: ChatMessage) {
        conversationId = message.conversationId
        conversationSequence = message.conversationSequence
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
        reactionTargetMessageId = message.reactionTargetMessageId
        messageActionJSON = Self.encode(message.messageAction)
        messageKind = message.messageKind
        agentExecutionJSON = Self.encode(message.agentExecution)
        backgroundAgentSessionsJSON = Self.encode(message.backgroundAgentSessions)
        reactionsJSON = Self.encode(message.reactions)
        mentionsJSON = Self.encode(message.mentions)
    }

    var value: ChatMessage? {
        guard messageKind != CloudMessageCodec.agentSessionIdentityMessageKind,
              let author = MessageAuthor(rawValue: author),
              let state = MessageDeliveryState(rawValue: deliveryState) else { return nil }
        return ChatMessage(
            id: messageId,
            conversationId: conversationId,
            conversationSequence: conversationSequence,
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
            reactionTargetMessageId: reactionTargetMessageId,
            messageAction: Self.decode(MessageActionMetadata.self, from: messageActionJSON),
            mentions: Self.decode([MessageMention].self, from: mentionsJSON) ?? [],
            messageKind: messageKind,
            agentExecution: Self.decode(
                AgentExecutionSnapshot.self,
                from: agentExecutionJSON
            ),
            backgroundAgentSessions: Self.decode(
                [BackgroundAgentSession].self,
                from: backgroundAgentSessionsJSON
            ) ?? [],
            reactions: Self.decode([MessageReaction].self, from: reactionsJSON) ?? []
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

@Model
final class CachedMessagePageRecord {
    @Attribute(.unique) var id: String
    var accountId: String
    var conversationId: String
    var messagesData: Data
    var hasMore: Bool

    init(accountId: String, conversationId: String, messages: [ChatMessage], hasMore: Bool) throws {
        id = scopedCacheRecordID(accountId: accountId, entityId: conversationId)
        self.accountId = accountId
        self.conversationId = conversationId
        messagesData = try JSONEncoder().encode(messages)
        self.hasMore = hasMore
    }

    func update(messages: [ChatMessage], hasMore: Bool) throws {
        messagesData = try JSONEncoder().encode(messages)
        self.hasMore = hasMore
    }

    func page(limit: Int) -> LocalMessagePage? {
        guard let messages = try? JSONDecoder().decode([ChatMessage].self, from: messagesData) else {
            return nil
        }
        return LocalMessagePage(
            messages: Array(messages.suffix(limit)),
            hasMore: hasMore || messages.count > limit
        )
    }
}

@MainActor
final class LocalMessageStore {
    private static let latestPageLimit = 64

    private let container: ModelContainer
    private var context: ModelContext { container.mainContext }
    private var conversationFingerprints: [String: Int] = [:]
    private var messageFingerprints: [String: [String: Int]] = [:]
    private var messageHasEarlier: [String: [String: Bool]] = [:]

    init(inMemory: Bool = false) throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: inMemory)
        container = try ModelContainer(
            for: CachedConversationRecord.self,
            CachedMessageRecord.self,
            CachedMessagePageRecord.self,
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
        let messages = ((try? context.fetch(descriptor))?.compactMap(\.value) ?? [])
            .sorted(by: ChatMessage.timelinePrecedes)
        messageFingerprints[accountId, default: [:]][conversationId] = fingerprint(messages)
        return messages
    }

    func loadMessagePage(
        accountId: String,
        conversationId: String,
        before: ChatMessage? = nil,
        limit: Int
    ) -> LocalMessagePage {
        guard !accountId.isEmpty, limit > 0 else {
            return LocalMessagePage(messages: [], hasMore: false)
        }
        if before == nil {
            let pageID = scopedCacheRecordID(accountId: accountId, entityId: conversationId)
            var pageDescriptor = FetchDescriptor<CachedMessagePageRecord>(
                predicate: #Predicate { $0.id == pageID }
            )
            pageDescriptor.fetchLimit = 1
            if let records = try? context.fetch(pageDescriptor),
               let page = records.first?.page(limit: limit) {
                return page
            }
        }
        let scope = accountId
        let conversation = conversationId
        let canonicalDescriptor: FetchDescriptor<CachedMessageRecord>
        let legacyDescriptor: FetchDescriptor<CachedMessageRecord>
        if let before, let beforeSequence = before.conversationSequence {
            canonicalDescriptor = FetchDescriptor(
                predicate: #Predicate {
                    $0.accountId == scope
                        && $0.conversationId == conversation
                        && ($0.conversationSequence ?? 0) > 0
                        && ($0.conversationSequence ?? 0) < beforeSequence
                },
                sortBy: [
                    SortDescriptor(\.conversationSequence, order: .reverse),
                    SortDescriptor(\.messageId, order: .reverse),
                ]
            )
            let beforeDate = before.createdAt
            let beforeMessageId = before.id
            legacyDescriptor = FetchDescriptor(
                predicate: #Predicate {
                    $0.accountId == scope
                        && $0.conversationId == conversation
                        && $0.conversationSequence == nil
                        && ($0.createdAt < beforeDate
                            || ($0.createdAt == beforeDate && $0.messageId < beforeMessageId))
                },
                sortBy: [
                    SortDescriptor(\.createdAt, order: .reverse),
                    SortDescriptor(\.messageId, order: .reverse),
                ]
            )
        } else if let before {
            let beforeDate = before.createdAt
            let beforeMessageId = before.id
            canonicalDescriptor = FetchDescriptor(
                predicate: #Predicate {
                    $0.accountId == scope
                        && $0.conversationId == conversation
                        && $0.conversationSequence != nil
                        && ($0.createdAt < beforeDate
                            || ($0.createdAt == beforeDate && $0.messageId < beforeMessageId))
                },
                sortBy: [
                    SortDescriptor(\.createdAt, order: .reverse),
                    SortDescriptor(\.messageId, order: .reverse),
                ]
            )
            legacyDescriptor = FetchDescriptor(
                predicate: #Predicate {
                    $0.accountId == scope
                        && $0.conversationId == conversation
                        && $0.conversationSequence == nil
                        && ($0.createdAt < beforeDate
                            || ($0.createdAt == beforeDate && $0.messageId < beforeMessageId))
                },
                sortBy: [
                    SortDescriptor(\.createdAt, order: .reverse),
                    SortDescriptor(\.messageId, order: .reverse),
                ]
            )
        } else {
            canonicalDescriptor = FetchDescriptor(
                predicate: #Predicate {
                    $0.accountId == scope
                        && $0.conversationId == conversation
                        && $0.conversationSequence != nil
                },
                sortBy: [
                    SortDescriptor(\.conversationSequence, order: .reverse),
                    SortDescriptor(\.messageId, order: .reverse),
                ]
            )
            legacyDescriptor = FetchDescriptor(
                predicate: #Predicate {
                    $0.accountId == scope
                        && $0.conversationId == conversation
                        && $0.conversationSequence == nil
                },
                sortBy: [
                    SortDescriptor(\.createdAt, order: .reverse),
                    SortDescriptor(\.messageId, order: .reverse),
                ]
            )
        }
        var boundedCanonical = canonicalDescriptor
        var boundedLegacy = legacyDescriptor
        boundedCanonical.fetchLimit = limit + 1
        boundedLegacy.fetchLimit = limit + 1
        let messages = [boundedCanonical, boundedLegacy]
            .flatMap { (try? context.fetch($0)) ?? [] }
            .compactMap(\.value)
            .sorted(by: ChatMessage.timelinePrecedes)
        let page = LocalMessagePage(
            messages: Array(messages.suffix(limit)),
            hasMore: messages.count > limit
        )
        if before == nil {
            do {
                try saveLatestPageRecord(
                    page.messages,
                    conversationId: conversationId,
                    accountId: accountId,
                    hasMore: page.hasMore
                )
                try context.save()
            } catch {
                context.rollback()
            }
        }
        return page
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

    func saveMessages(
        _ messages: [ChatMessage],
        conversationId: String,
        accountId: String,
        hasEarlier: Bool? = nil
    ) {
        guard !accountId.isEmpty else { return }
        let nextFingerprint = fingerprint(messages)
        let sameMessages = nextFingerprint == messageFingerprints[accountId]?[conversationId]
        let sameHistoryState = hasEarlier == nil
            || hasEarlier == messageHasEarlier[accountId]?[conversationId]
        guard !sameMessages || !sameHistoryState else { return }
        do {
            let recordIDs = messages.map {
                scopedCacheRecordID(accountId: accountId, entityId: $0.id)
            }
            let descriptor = FetchDescriptor<CachedMessageRecord>(
                predicate: #Predicate { recordIDs.contains($0.id) }
            )
            let existing = try context.fetch(descriptor)
            let existingById = Dictionary(uniqueKeysWithValues: existing.map { ($0.messageId, $0) })
            for message in messages {
                if let record = existingById[message.id] {
                    if record.value != message { record.update(from: message) }
                } else {
                    context.insert(CachedMessageRecord(accountId: accountId, message: message))
                }
            }
            let visibleMessageCount = messages.reduce(into: 0) { count, message in
                if message.messageKind != CloudMessageCodec.agentSessionIdentityMessageKind {
                    count += 1
                }
            }
            let pageHasMore = hasEarlier ?? (visibleMessageCount > Self.latestPageLimit)
            try saveLatestPageRecord(
                messages,
                conversationId: conversationId,
                accountId: accountId,
                hasMore: pageHasMore
            )
            try context.save()
            messageFingerprints[accountId, default: [:]][conversationId] = nextFingerprint
            if let hasEarlier {
                messageHasEarlier[accountId, default: [:]][conversationId] = hasEarlier
            }
        } catch {
            context.rollback()
        }
    }

    private func saveLatestPageRecord(
        _ messages: [ChatMessage],
        conversationId: String,
        accountId: String,
        hasMore: Bool
    ) throws {
        let visibleMessages = messages.filter {
            $0.messageKind != CloudMessageCodec.agentSessionIdentityMessageKind
        }
        let latestMessages = Array(
            visibleMessages.sorted(by: ChatMessage.timelinePrecedes).suffix(Self.latestPageLimit)
        )
        let pageID = scopedCacheRecordID(accountId: accountId, entityId: conversationId)
        var pageDescriptor = FetchDescriptor<CachedMessagePageRecord>(
            predicate: #Predicate { $0.id == pageID }
        )
        pageDescriptor.fetchLimit = 1
        if let page = try context.fetch(pageDescriptor).first {
            try page.update(messages: latestMessages, hasMore: hasMore)
        } else {
            context.insert(try CachedMessagePageRecord(
                accountId: accountId,
                conversationId: conversationId,
                messages: latestMessages,
                hasMore: hasMore
            ))
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
            let messagePages = try context.fetch(FetchDescriptor<CachedMessagePageRecord>(
                predicate: #Predicate { $0.accountId == scope }
            ))
            conversations.forEach(context.delete)
            messages.forEach(context.delete)
            messagePages.forEach(context.delete)
            try context.save()
            conversationFingerprints[accountId] = nil
            messageFingerprints[accountId] = nil
            messageHasEarlier[accountId] = nil
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
            let messagePages = try context.fetch(FetchDescriptor<CachedMessagePageRecord>(
                predicate: #Predicate { $0.accountId == legacyScope }
            ))
            guard !conversations.isEmpty || !messages.isEmpty || !messagePages.isEmpty else { return }
            conversations.forEach(context.delete)
            messages.forEach(context.delete)
            messagePages.forEach(context.delete)
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
