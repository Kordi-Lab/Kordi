import SwiftUI

struct ConversationTrajectoryViewport: Equatable {
    private var expandedMessageIDs = Set<String>()
    private(set) var leadingSpace: CGFloat?
    var isPinned: Bool { !expandedMessageIDs.isEmpty }

    mutating func update(messageID: String, expanded: Bool, leadingSpace: CGFloat) {
        if expanded {
            if expandedMessageIDs.isEmpty {
                self.leadingSpace = max(0, leadingSpace)
            }
            expandedMessageIDs.insert(messageID)
        } else {
            expandedMessageIDs.remove(messageID)
            if expandedMessageIDs.isEmpty { self.leadingSpace = nil }
        }
    }

    mutating func reset() {
        expandedMessageIDs.removeAll()
        leadingSpace = nil
    }

    mutating func retainMessageIDs(_ messageIDs: Set<String>) {
        expandedMessageIDs.formIntersection(messageIDs)
        if expandedMessageIDs.isEmpty { leadingSpace = nil }
    }
}
