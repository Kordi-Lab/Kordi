import Foundation

extension AppModel {
    static func applyingSessionPinEvents(
        _ events: [CloudSyncEvent],
        to current: [String: CloudSessionPin]
    ) -> [String: CloudSessionPin] {
        var pins = current
        for event in events where event.eventType == "session.pin.updated" {
            guard let payload = event.payload,
                  let sessionId = payload.sessionId?.nonEmpty,
                  let scope = payload.scope?.nonEmpty?.lowercased(),
                  scope == "private" || scope == "shared" else { continue }
            let targetId = payload.targetMessageId?.nonEmpty ?? payload.messageId?.nonEmpty
            let kind = payload.kind ?? (targetId == nil ? "unpinned" : "pinned")
            let legacyEvent: CloudPinHistoryEvent? = event.eventId.hasPrefix("bootstrap:session-pin:") ? nil : CloudPinHistoryEvent(
                id: "legacy-pin:\(event.eventId)", sessionId: sessionId,
                kind: kind, scope: scope,
                messageId: targetId, updatedByAccountId: payload.updatedByAccountId ?? "",
                updatedAt: payload.updatedAt?.nonEmpty ?? event.occurredAt)
            let history = CloudPinHistoryEvent.merging([pins[sessionId]?.history ?? [], (payload.pinHistoryEvent ?? legacyEvent).map { [$0] } ?? []])
            if var existing = pins[sessionId] { existing.history = history; pins[sessionId] = existing }
            let updatedAt = payload.updatedAt?.nonEmpty ?? event.occurredAt.nonEmpty
            if !event.eventId.hasPrefix("bootstrap:session-pin:"),
               let currentUpdatedAt = pins[sessionId]?.updatedAt?.nonEmpty,
               let updatedAt,
               updatedAt < currentUpdatedAt {
                continue
            }
            let currentPin = pins[sessionId]
            let messageId = payload.messageId?.nonEmpty
            let scopeIds = payload.messageIds ?? messageId.map { [$0] } ?? []
            let sharedIds = scope == "shared" ? scopeIds : currentPin?.messageIDs(scope: "shared") ?? []
            let privateIds = scope == "private" ? scopeIds : currentPin?.messageIDs(scope: "private") ?? []
            let sharedMessageId = sharedIds.last
            let privateMessageId = privateIds.last
            let isBootstrap = event.eventId.hasPrefix("bootstrap:session-pin:")
            pins[sessionId] = CloudSessionPin(
                sessionId: sessionId,
                sharedMessageId: sharedMessageId,
                privateMessageId: privateMessageId,
                effectiveMessageId: privateMessageId ?? sharedMessageId,
                updatedAt: updatedAt,
                lastAction: isBootstrap ? nil : CloudSessionPinAction(
                    kind: payload.pinHistoryEvent?.kind ?? kind,
                    scope: scope,
                    messageId: payload.pinHistoryEvent?.messageId ?? targetId,
                    updatedByAccountId: payload.updatedByAccountId?.nonEmpty,
                    updatedAt: updatedAt
                ),
                history: history,
                sharedMessageIds: sharedIds, privateMessageIds: privateIds
            )
        }
        return pins
    }

}
