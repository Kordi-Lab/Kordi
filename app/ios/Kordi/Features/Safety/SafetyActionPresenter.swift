import SwiftUI

/// Copy shared by the safety confirmations.
enum SafetyCopy {
    static func requestDisclosure(_ name: String) -> String {
        "If you accept, \(name) can message you, add you to groups, see when you're online, and ask your Kordi agent for help."
    }

    static func blockTitle(_ name: String) -> String { "Block \(name)?" }

    static let blockDetails = [
        "They won't be able to message or call you, send you contact requests, add you to groups, see when you're online, or use your agents.",
        "They'll be removed from your contacts, and any call between you ends. If you unblock them later, you'll need to connect again.",
        "In groups you're both in, you'll still see their messages, but you won't get notifications for them. You can leave those groups.",
        "Kordi doesn't tell them you blocked them, but they may notice that their messages and requests don't go through.",
        "Blocking doesn't send anything to Kordi. To tell us about a problem, choose Report.",
    ]

    static var blockMessage: String {
        blockDetails.map { "• \($0)" }.joined(separator: "\n\n")
    }

    static func blocked(_ name: String) -> String { "\(name) is blocked." }
    static func unblockTitle(_ name: String) -> String { "Unblock \(name)?" }
    static let unblockMessage = "They'll be able to send you a contact request again. They won't be added back to your contacts."
    static func unblocked(_ name: String) -> String { "\(name) is unblocked." }

    static func removeTitle(_ name: String) -> String { "Remove \(name) from your contacts?" }
    static let removeMessage = "You won't be able to message or call each other or see each other's online status until one of you sends a new contact request and the other accepts. Your chat history stays."
    static func removed(_ name: String) -> String { "\(name) was removed from your contacts." }

    static func withdrawTitle(_ name: String) -> String { "Withdraw your contact request to \(name)?" }

    static func leaveTitle(_ groupName: String) -> String {
        "Leave \(groupName.nonEmpty ?? "this group")?"
    }

    static let blockedAccountsTitle = "Blocked accounts"
    static let noBlockedAccounts = "You haven't blocked anyone."
}

struct SafetyAccount: Hashable {
    let accountId: String
    let name: String
}

/// A safety action that needs confirmation before it runs.
enum SafetyAction: Identifiable, Hashable {
    case block(SafetyAccount)
    case unblock(SafetyAccount)
    case removeContact(SafetyAccount)
    case withdraw(CloudContactRequest)
    case leaveGroup(GroupSpaceSummary)

    var id: String {
        switch self {
        case .block(let account): "block:\(account.accountId)"
        case .unblock(let account): "unblock:\(account.accountId)"
        case .removeContact(let account): "remove:\(account.accountId)"
        case .withdraw(let request): "withdraw:\(request.requestId)"
        case .leaveGroup(let space): "leave:\(space.id)"
        }
    }
}

extension View {
    /// Presents the confirmation for `action`, the report sheet for
    /// `report`, and the result of either.
    func safetyActions(
        _ action: Binding<SafetyAction?>,
        report: Binding<ReportTarget?>,
        onLeftGroup: (() -> Void)? = nil
    ) -> some View {
        modifier(SafetyActionPresenter(action: action, report: report, onLeftGroup: onLeftGroup))
    }
}

private struct SafetyActionPresenter: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @Binding var action: SafetyAction?
    @Binding var report: ReportTarget?
    let onLeftGroup: (() -> Void)?
    @State private var leaveSummary: (isOwner: Bool, successorName: String?) = (false, nil)
    @State private var notice: String?
    @State private var failure: String?
    @State private var isWorking = false

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                title,
                isPresented: Binding(
                    get: { action != nil },
                    set: { if !$0 { action = nil } }
                ),
                titleVisibility: .visible,
                presenting: action
            ) { action in
                buttons(for: action)
            } message: { action in
                Text(message(for: action))
            }
            .sheet(item: $report) { target in
                ReportSheet(target: target)
            }
            .alert(
                failure ?? "",
                isPresented: Binding(
                    get: { failure != nil },
                    set: { if !$0 { failure = nil } }
                )
            ) {
                Button("OK") { failure = nil }
            }
            .overlay(alignment: .bottom) {
                if let notice {
                    Text(notice)
                        .font(.subheadline.weight(.medium))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)
                        .background(.regularMaterial, in: Capsule())
                        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
                        .padding(.horizontal, 24)
                        .padding(.bottom, 24)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .accessibilityAddTraits(.isStaticText)
                        .task(id: notice) {
                            try? await Task.sleep(for: .seconds(3))
                            withAnimation { self.notice = nil }
                        }
                }
            }
            .task(id: action?.id) {
                leaveSummary = (false, nil)
                guard case .leaveGroup(let space) = action else { return }
                let summary = await model.groupLeaveSummary(space)
                leaveSummary = (summary.isOwner, summary.successor?.displayName)
            }
    }

    private var title: String {
        switch action {
        case .block(let account): SafetyCopy.blockTitle(account.name)
        case .unblock(let account): SafetyCopy.unblockTitle(account.name)
        case .removeContact(let account): SafetyCopy.removeTitle(account.name)
        case .withdraw(let request): SafetyCopy.withdrawTitle(request.counterpart?.preferredName ?? "this person")
        case .leaveGroup(let space): SafetyCopy.leaveTitle(space.displayName)
        case nil: ""
        }
    }

    private func message(for action: SafetyAction) -> String {
        switch action {
        case .block: SafetyCopy.blockMessage
        case .unblock: SafetyCopy.unblockMessage
        case .removeContact: SafetyCopy.removeMessage
        case .withdraw: "They won't see your request anymore. You can send a new one later."
        case .leaveGroup:
            GroupLeavePlan.confirmationMessage(
                isOwner: leaveSummary.isOwner,
                successorName: leaveSummary.successorName
            )
        }
    }

    @ViewBuilder
    private func buttons(for action: SafetyAction) -> some View {
        switch action {
        case .block(let account):
            Button("Block", role: .destructive) { run(action) }
            Button("Report \(account.name)…") {
                let target = ReportTarget.account(accountId: account.accountId, name: account.name)
                // Let the dialog finish dismissing before the sheet appears.
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(350))
                    report = target
                }
            }
            Button("Cancel", role: .cancel) {}
        case .unblock:
            Button("Unblock") { run(action) }
            Button("Cancel", role: .cancel) {}
        case .removeContact:
            Button("Remove contact", role: .destructive) { run(action) }
            Button("Cancel", role: .cancel) {}
        case .withdraw:
            Button("Withdraw", role: .destructive) { run(action) }
            Button("Cancel", role: .cancel) {}
        case .leaveGroup:
            Button("Leave group", role: .destructive) { run(action) }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func run(_ action: SafetyAction) {
        guard !isWorking else { return }
        isWorking = true
        Task {
            defer { isWorking = false }
            let result: SafetyActionResult
            var success: String?
            switch action {
            case .block(let account):
                result = await model.block(accountId: account.accountId, name: account.name)
                success = SafetyCopy.blocked(account.name)
            case .unblock(let account):
                result = await model.unblock(accountId: account.accountId, name: account.name)
                success = SafetyCopy.unblocked(account.name)
            case .removeContact(let account):
                result = await model.removeContact(accountId: account.accountId, name: account.name)
                success = SafetyCopy.removed(account.name)
            case .withdraw(let request):
                result = await model.withdrawContactRequest(request)
            case .leaveGroup(let space):
                result = await model.leaveGroup(space)
            }
            switch result {
            case .done:
                if case .leaveGroup = action { onLeftGroup?() }
                if let success { show(success) }
            case .failed(let message):
                failure = message
            }
        }
    }

    private func show(_ message: String) {
        withAnimation { notice = message }
        AccessibilityNotification.Announcement(message).post()
    }
}
