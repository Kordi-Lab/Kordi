import SwiftUI

/// Settings › Blocked: the accounts this person blocked, each with Unblock.
/// Unblocking does not restore a contact.
struct BlockedAccountsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var unblockTarget: CloudBlockedAccount?
    @State private var unblockError: String?
    @State private var isMutating = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let accounts = model.blockedAccounts, !accounts.isEmpty {
                    ForEach(accounts) { blocked in
                        BlockedAccountRow(account: blocked, isDisabled: isMutating) { unblockTarget = blocked }
                    }
                } else if model.blockedAccounts == nil && (isLoading || loadError == nil) {
                    SettingsLoadingRow("Loading…")
                } else if model.blockedAccounts != nil {
                    ContentUnavailableView("No one blocked", systemImage: "hand.raised")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                }

                if let loadError {
                    SettingsDivider()
                    SettingsErrorLabel(loadError)
                    Button("Try again") { Task { await load() } }
                        .font(SettingsFont.action)
                        .frame(minHeight: SettingsMetrics.textRowMinHeight)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle("Blocked")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog(
            unblockTarget.map { "Unblock \($0.preferredName)?" } ?? "",
            isPresented: Binding(get: { unblockTarget != nil }, set: { if !$0 { unblockTarget = nil } }),
            titleVisibility: .visible,
            presenting: unblockTarget
        ) { blocked in
            Button("Unblock") { unblock(blocked) }
            Button("Cancel", role: .cancel) { unblockTarget = nil }
        }
        .alert(
            "Could not unblock",
            isPresented: Binding(get: { unblockError != nil }, set: { if !$0 { unblockError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(unblockError ?? "")
        }
    }

    private func load() async {
        isLoading = true
        loadError = await model.refreshBlockedAccounts()
        isLoading = false
    }

    private func unblock(_ blocked: CloudBlockedAccount) {
        isMutating = true
        Task {
            if case .failed(let message) = await model.unblock(blocked) {
                unblockError = message
            }
            isMutating = false
            unblockTarget = nil
        }
    }
}

/// A blocked person in the flat settings style: avatar, name, Kordi ID, Unblock.
private struct BlockedAccountRow: View {
    let account: CloudBlockedAccount
    let isDisabled: Bool
    let onUnblock: () -> Void

    var body: some View {
        HStack(spacing: SettingsMetrics.iconSpacing) {
            IdentityAvatar(
                name: account.preferredName,
                imageSource: account.avatarUrl?.nonEmpty,
                kind: .person,
                size: 36,
                seed: account.accountId,
                cornerRadius: 18
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(account.preferredName)
                    .font(SettingsFont.rowTitle)
                    .lineLimit(1)
                if let kordiId = account.kordiId?.nonEmpty {
                    Text("@\(kordiId)")
                        .font(SettingsFont.subtitle)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            Button("Unblock", action: onUnblock)
                .font(SettingsFont.inlineAction)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(.primary)
                .disabled(isDisabled)
                .accessibilityLabel("Unblock \(account.preferredName)")
                .accessibilityIdentifier("blocked-unblock-\(account.accountId)")
        }
        .padding(.vertical, 6)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
    }
}
