import Observation
import SwiftUI

/// The blocked-account messages a person opened on one conversation screen.
/// It lives as long as the screen, so a revealed message stays open until
/// the person leaves.
@MainActor
@Observable
final class BlockedMessageReveals {
    var filter = BlockedAuthorFilter()
    private(set) var revealedMessageIds = Set<String>()

    func collapses(_ message: ChatMessage, in conversation: ConversationSummary) -> Bool {
        !revealedMessageIds.contains(message.id) && filter.collapses(message, in: conversation)
    }

    func reveal(_ messageId: String) {
        revealedMessageIds.insert(messageId)
    }
}

extension View {
    /// Shows a blocked account's group message as one row until tapped.
    func blockedAuthorCollapse(_ message: ChatMessage, in conversation: ConversationSummary) -> some View {
        modifier(BlockedAuthorCollapse(message: message, conversation: conversation))
    }

    /// The conversation screen's report sheet and blocked-message state. Loads
    /// the block list once per account without holding up the timeline.
    func conversationSafety(report: Binding<ReportTarget?>) -> some View {
        modifier(ConversationSafety(report: report))
    }
}

private struct ConversationSafety: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @Binding var report: ReportTarget?
    @State private var reveals = BlockedMessageReveals()

    func body(content: Content) -> some View {
        content
            .environment(reveals)
            .safetyActions(block: .constant(nil), report: $report)
            .onChange(of: model.blockedAuthorFilter, initial: true) { _, filter in
                reveals.filter = filter
            }
            .task(id: model.account?.accountId) {
                guard model.account != nil, model.blockedAccounts == nil else { return }
                await model.refreshBlockedAccounts()
            }
    }
}

private struct BlockedAuthorCollapse: ViewModifier {
    @Environment(BlockedMessageReveals.self) private var reveals: BlockedMessageReveals?
    let message: ChatMessage
    let conversation: ConversationSummary

    func body(content: Content) -> some View {
        if let reveals, reveals.collapses(message, in: conversation) {
            Button {
                reveals.reveal(message.id)
            } label: {
                SystemNoticeRow(text: "Message from a blocked account")
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, 6)
        } else {
            content
        }
    }
}
