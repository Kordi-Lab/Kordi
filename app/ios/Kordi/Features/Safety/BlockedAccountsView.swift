import SwiftUI

/// The accounts this person blocked, each with Unblock. Unblocking does not
/// restore a contact.
struct BlockedAccountsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var action: SafetyAction?
    @State private var report: ReportTarget?

    var body: some View {
        List {
            if model.blockedAccounts.isEmpty {
                ContentUnavailableView(
                    SafetyCopy.noBlockedAccounts,
                    systemImage: "hand.raised"
                )
                .listRowSeparator(.hidden)
            } else {
                ForEach(model.blockedAccounts) { blocked in
                    BlockedAccountRow(account: blocked) {
                        action = .unblock(SafetyAccount(accountId: blocked.accountId, name: blocked.preferredName))
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(SafetyCopy.blockedAccountsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refreshBlockedAccounts() }
        .task { await model.refreshBlockedAccounts() }
        .safetyActions($action, report: $report)
    }
}

private struct BlockedAccountRow: View {
    let account: CloudBlockedAccount
    let onUnblock: () -> Void

    var body: some View {
        HStack(spacing: 11) {
            IdentityAvatar(
                name: account.preferredName,
                imageSource: account.avatarUrl.nonEmpty,
                kind: .person,
                size: 40,
                seed: account.accountId
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(account.preferredName)
                    .font(.body.weight(.medium))
                if let kordiId = account.kordiId.nonEmpty {
                    Text("@\(kordiId)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Button("Unblock", action: onUnblock)
                .buttonStyle(.bordered)
                .controlSize(.small)
                .frame(minHeight: 44)
                .accessibilityLabel("Unblock \(account.preferredName)")
        }
        .padding(.vertical, 2)
    }
}
