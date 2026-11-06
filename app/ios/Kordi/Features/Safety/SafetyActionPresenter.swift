import SwiftUI

extension View {
    /// Presents the block confirmation for `block` and the report sheet for
    /// `report`. `onBlocked` runs after a block succeeds, or after the report
    /// sheet closes when the report also blocked the account.
    func safetyActions(
        block: Binding<SafetyAccount?>,
        report: Binding<ReportTarget?>,
        onBlocked: (() -> Void)? = nil
    ) -> some View {
        modifier(SafetyActionPresenter(block: block, report: report, onBlocked: onBlocked))
    }

    /// Long press on an incoming contact request offers Block and Report.
    func contactRequestSafetyActions(_ request: CloudContactRequest) -> some View {
        modifier(ContactRequestSafetyMenu(request: request))
    }
}

private struct SafetyActionPresenter: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @Binding var block: SafetyAccount?
    @Binding var report: ReportTarget?
    let onBlocked: (() -> Void)?
    @State private var failure: (title: String, message: String)?
    @State private var isBlocking = false
    @State private var reportBlocked = false

    func body(content: Content) -> some View {
        content
            .alert(
                block.map { "Block \($0.name)?" } ?? "",
                isPresented: Binding(get: { block != nil }, set: { if !$0 { block = nil } }),
                presenting: block
            ) { account in
                Button("Cancel", role: .cancel) {}
                Button("Block", role: .destructive) { run(account) }
            } message: { _ in
                Text("They can't message, call or invite you.")
            }
            .sheet(item: $report, onDismiss: finishReport) { target in
                ReportSheet(target: target) { reportBlocked = true }
            }
            .alert(
                failure?.title ?? "",
                isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(failure?.message ?? "")
            }
    }

    private func run(_ account: SafetyAccount) {
        guard !isBlocking else { return }
        isBlocking = true
        Task {
            defer { isBlocking = false }
            switch await model.block(account) {
            case .done:
                AccessibilityNotification.Announcement("\(account.name) is blocked").post()
                onBlocked?()
            case .failed(let message):
                failure = ("Could not block \(account.name)", message)
            }
        }
    }

    private func finishReport() {
        guard reportBlocked else { return }
        reportBlocked = false
        onBlocked?()
    }
}

/// Block and Report for an incoming contact request, behind a long press so
/// the row keeps its Accept and Decline buttons as they are.
private struct ContactRequestSafetyMenu: ViewModifier {
    @EnvironmentObject private var model: AppModel
    let request: CloudContactRequest
    @State private var block: SafetyAccount?
    @State private var report: ReportTarget?

    private var account: SafetyAccount? {
        guard request.isIncoming, model.allowsSafetyActions(for: request.fromAccountId) else { return nil }
        return SafetyAccount(
            accountId: request.fromAccountId,
            name: request.counterpart?.preferredName ?? "Kordi user",
            kordiId: request.counterpart?.kordiId,
            avatarUrl: request.counterpart?.avatarUrl
        )
    }

    func body(content: Content) -> some View {
        if let account {
            content
                .contextMenu {
                    Button("Block", systemImage: "nosign", role: .destructive) { block = account }
                    Button("Report", systemImage: "flag") {
                        report = .account(account, contactRequestId: request.requestId)
                    }
                }
                .safetyActions(block: $block, report: $report) {
                    // The server drops the request; preview data does it locally.
                    if model.isPreviewMode { Task { await model.rejectContactRequest(request) } }
                }
        } else {
            content
        }
    }
}
