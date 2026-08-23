import Foundation

struct CloudGroupDeliverySummary: Equatable {
    let state: MessageDeliveryState
    let readByAccountIds: [String]
}

enum CloudReadScope: Equatable {
    case peer(String)
    case session(String)
    case sessions(Set<String>)
}

enum CloudMessageStateProjector {
    static func latestAgentModelChanges(
        in messagesByPeer: [String: [CloudMessageDTO]],
        sessionIds: Set<String>? = nil,
        ownAccountId: String? = nil
    ) -> [CloudMessageDTO] {
        var latestBySessionID: [String: CloudMessageDTO] = [:]
        for message in messagesByPeer.values.flatMap({ $0 }) {
            guard CloudMessageCodec.isAgentModelChange(message),
                  let sessionID = message.sessionId?.nonEmpty,
                  ownAccountId.map({ message.fromAccountId == $0 }) ?? true,
                  sessionIds?.contains(sessionID) ?? true else {
                continue
            }
            if let current = latestBySessionID[sessionID],
               !synchronizationOrder(current, precedes: message) {
                continue
            }
            latestBySessionID[sessionID] = message
        }
        return latestBySessionID
            .sorted { $0.key < $1.key }
            .map(\.value)
    }

    static func deliveryState(for message: CloudMessageDTO, ownAccountId: String) -> MessageDeliveryState {
        if message.readAt != nil { return .read }
        // Kordi Cloud accepts and durably records the message before returning
        // it. macOS therefore presents every successful outgoing write as
        // delivered even if an older payload omitted deliveredAt.
        if message.fromAccountId == ownAccountId { return .delivered }
        return message.deliveredAt != nil ? .delivered : .sent
    }

    static func groupDeliverySummary(
        messageId: String,
        messages: [CloudMessageDTO],
        ownAccountId: String
    ) -> CloudGroupDeliverySummary? {
        let copies = messages.filter { wire in
            guard wire.fromAccountId == ownAccountId,
                  let envelope = CloudGroupMessageCodec.parse(wire.body),
                  envelope.kind == "group-message" else { return false }
            return envelope.message?.id == messageId
        }
        guard !copies.isEmpty else { return nil }
        let readers = Set(copies.flatMap { wire -> [String] in
            if let readByAccountIds = wire.readByAccountIds {
                return readByAccountIds.compactMap(\.nonEmpty)
            }
            return wire.readAt == nil ? [] : wire.toAccountId.nonEmpty.map { [$0] } ?? []
        }.filter { $0 != ownAccountId }).sorted()
        return CloudGroupDeliverySummary(
            state: readers.isEmpty ? .delivered : .read,
            readByAccountIds: readers
        )
    }

    static func markingIncomingRead(
        _ messagesByPeer: [String: [CloudMessageDTO]],
        ownAccountId: String,
        scope: CloudReadScope,
        readAt: String
    ) -> [String: [CloudMessageDTO]] {
        messagesByPeer.mapValues { messages in
            messages.map { message in
                guard message.toAccountId == ownAccountId,
                      message.fromAccountId != ownAccountId,
                      message.direction == "incoming",
                      message.readAt == nil,
                      matches(message, scope: scope) else { return message }
                return CloudMessageDTO(
                    messageId: message.messageId,
                    clientMessageId: message.clientMessageId,
                    fromAccountId: message.fromAccountId,
                    toAccountId: message.toAccountId,
                    body: message.body,
                    createdAt: message.createdAt,
                    deliveredAt: message.deliveredAt ?? readAt,
                    readAt: readAt,
                    readByAccountIds: message.readByAccountIds,
                    direction: message.direction,
                    sessionId: message.sessionId,
                    attachments: message.attachments,
                    messageKind: message.messageKind,
                    conversationId: message.conversationId,
                    conversationSequence: message.conversationSequence
                )
            }
        }
    }

    static func sessionKeys(for message: CloudMessageDTO) -> Set<String> {
        var keys = Set<String>()
        if let sessionId = message.sessionId?.nonEmpty { keys.insert(sessionId) }
        if let groupId = CloudGroupMessageCodec.parse(message.body)?.groupId.nonEmpty { keys.insert(groupId) }
        return keys
    }

    private static func matches(_ message: CloudMessageDTO, scope: CloudReadScope) -> Bool {
        switch scope {
        case let .peer(peerAccountId):
            return message.fromAccountId == peerAccountId
        case let .session(sessionId):
            return sessionKeys(for: message).contains(sessionId)
        case let .sessions(sessionIds):
            return !sessionKeys(for: message).isDisjoint(with: sessionIds)
        }
    }

    private static func synchronizationOrder(
        _ left: CloudMessageDTO,
        precedes right: CloudMessageDTO
    ) -> Bool {
        if let leftSequence = left.conversationSequence,
           let rightSequence = right.conversationSequence,
           leftSequence != rightSequence {
            return leftSequence < rightSequence
        }
        if left.createdAt != right.createdAt {
            return left.createdAt < right.createdAt
        }
        return left.messageId < right.messageId
    }
}
