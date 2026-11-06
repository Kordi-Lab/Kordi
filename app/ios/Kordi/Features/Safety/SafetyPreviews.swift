import SwiftUI

/// Network-free screens for `--preview-blocked` and `--preview-report`.
/// Both turn on preview data by themselves; actions change local state only.
enum SafetyPreview {
    case blocked
    case report

    static var requested: SafetyPreview? {
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--preview-blocked") { return .blocked }
        if arguments.contains("--preview-report") { return .report }
        return nil
    }
}

struct SafetyPreviewHost: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: AppModel
    let kind: SafetyPreview
    @State private var report: ReportTarget?
    @State private var block: SafetyAccount?

    var body: some View {
        switch kind {
        case .blocked:
            AccountSheet(previewing: .blocked)
                .task { model.seedPreviewBlockedAccounts() }
        case .report:
            NavigationStack {
                ContactsView()
            }
            .tint(chatTheme.accent)
            .safetyActions(block: $block, report: $report)
            .task {
                guard report == nil else { return }
                report = .account(SafetyAccount(accountId: "acct_maya", name: "Maya Chen", kordiId: "284106395"))
            }
        }
    }
}
