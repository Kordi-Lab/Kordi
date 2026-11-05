import SwiftUI

/// Below a limit notice: View usage for owners and admins. It loads the
/// viewer's organizations once, which also decides the notice's wording.
struct UsageLimitNoticeFooter: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.kordiChatTheme) private var chatTheme
    let showsUsageLink: Bool
    let onOpenUsage: () -> Void

    var body: some View {
        Group {
            if showsUsageLink {
                Button("View usage", action: onOpenUsage)
                    .font(SettingsFont.inlineAction)
                    .foregroundStyle(chatTheme.accent)
                    .buttonStyle(.plain)
                    .frame(minHeight: 28)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Lines up with the bubble beside the 44 pt avatar column.
                    .padding(.leading, 56)
                    .padding(.bottom, 4)
                    .accessibilityIdentifier("usage-limit-view-usage")
            } else {
                Color.clear.frame(height: 0)
            }
        }
        .task { await model.loadOrganizationsIfNeeded() }
    }
}
