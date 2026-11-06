import SwiftUI

/// "Join <Group>?" for a group invitation, or one short notice when the
/// link cannot be used.
struct GroupInviteJoinSheet: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let sheet: GroupInviteFlow.Sheet
    let isJoining: Bool
    let joinError: String?
    let onJoin: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        SettingsPage {
            switch sheet {
            case let .invitation(pending):
                invitation(pending)
            case let .notice(notice):
                title(notice.title)
                SettingsCaption(notice.line)
                Button("Done", action: onDismiss)
                    .font(SettingsFont.action)
                    .frame(maxWidth: .infinity, minHeight: SettingsMetrics.textRowMinHeight)
                    .padding(.top, 16)
                    .accessibilityIdentifier("group-invite-done")
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isJoining)
    }

    @ViewBuilder
    private func invitation(_ pending: GroupInvitePending) -> some View {
        title("Join \(pending.groupName)?")
        SettingsCaption("\(pending.inviterName) invited you · \(Self.memberText(pending.memberCount))")

        if let joinError {
            Text(joinError)
                .font(SettingsFont.subtitle)
                .foregroundStyle(KordiTheme.destructiveText)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)
        }

        Button(action: onJoin) {
            HStack(spacing: 8) {
                if isJoining { ProgressView() }
                Text("Join")
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(chatTheme.accent)
        .controlSize(.large)
        .disabled(isJoining)
        .padding(.top, 20)
        .accessibilityIdentifier("group-invite-join")

        Button("Not now", action: onDismiss)
            .font(SettingsFont.action)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: SettingsMetrics.textRowMinHeight)
            .padding(.top, 4)
            .disabled(isJoining)
            .accessibilityIdentifier("group-invite-not-now")
    }

    private func title(_ text: String) -> some View {
        Text(text)
            .font(.title3.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 12)
            .accessibilityAddTraits(.isHeader)
    }

    static func memberText(_ count: Int) -> String {
        count == 1 ? "1 member" : "\(count) members"
    }
}
