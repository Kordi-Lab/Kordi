import Foundation

struct CloudSessionPin: Codable, Hashable {
    let sessionId: String
    let sharedMessageId: String?
    let privateMessageId: String?
    let effectiveMessageId: String?
    let updatedAt: String?
    var lastAction: CloudSessionPinAction? = nil
    var history: [CloudPinHistoryEvent]? = nil
    var sharedMessageIds: [String]? = nil
    var privateMessageIds: [String]? = nil

    static let maximumMessageCount = 5

    func messageIDs(scope: String) -> [String] {
        let ids = scope == "shared" ? sharedMessageIds : privateMessageIds
        let legacy = scope == "shared" ? sharedMessageId : privateMessageId
        var seen = Set<String>()
        return (ids ?? legacy.map { [$0] } ?? []).compactMap(\.nonEmpty).filter { seen.insert($0).inserted }
    }

    var visibleMessageIDs: [String] {
        var seen = Set<String>()
        return (messageIDs(scope: "shared") + messageIDs(scope: "private")).filter { seen.insert($0).inserted }
    }

    func bootstrapEvents(serverTime: String) -> [CloudSyncEvent] {
        ["shared", "private"].map { scope in
            let ids = messageIDs(scope: scope)
            let time = updatedAt ?? serverTime
            return CloudSyncEvent(
                eventId: "bootstrap:session-pin:\(sessionId):\(scope)", eventType: "session.pin.updated",
                peerAccountId: nil, messageId: ids.last,
                payload: CloudSyncEventPayload(message: nil, messageIds: ids, messageId: ids.last, readAt: nil,
                    sessionId: sessionId, scope: scope, updatedAt: time,
                    forkSessionId: nil, parentSessionId: nil, parentMessageId: nil,
                    createdByAccountId: nil, createdAt: nil, sessionTitle: nil, deviceId: nil, call: nil),
                occurredAt: time
            )
        }
    }

    func mergingHistory(from current: Self?) -> Self {
        var result = self
        // Legacy responses timestamp the remaining pin rather than the unpin action.
        if history != nil, let current, let old = current.updatedAt.flatMap(CloudPinHistoryEvent.parseTimestamp),
           updatedAt.flatMap(CloudPinHistoryEvent.parseTimestamp).map({ $0 < old }) ?? true {
            result = current
        }
        result.history = CloudPinHistoryEvent.merging([current?.history ?? [], history ?? []])
        return result
    }

    func recording(_ action: CloudSessionPinAction?) -> Self {
        Self(
            sessionId: sessionId,
            sharedMessageId: sharedMessageId,
            privateMessageId: privateMessageId,
            effectiveMessageId: effectiveMessageId,
            updatedAt: updatedAt,
            lastAction: action,
            history: history,
            sharedMessageIds: sharedMessageIds,
            privateMessageIds: privateMessageIds
        )
    }
}
