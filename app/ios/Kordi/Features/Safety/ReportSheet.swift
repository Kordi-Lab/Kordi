import SwiftUI

/// Reports an account or one message, with an optional block.
struct ReportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    let target: ReportTarget
    /// Called when the report also blocked the account.
    var onBlocked: (() -> Void)? = nil

    @State private var reason: CloudReportReason?
    @State private var details = ""
    @State private var alsoBlock = false
    @State private var isSending = false
    @State private var isSent = false
    @State private var failure: String?
    @State private var attempt: ReportAttempt?

    private var offersBlock: Bool {
        guard target.offersBlock, let account = target.account else { return false }
        return model.allowsSafetyActions(for: account.accountId) && !model.isBlocked(account.accountId)
    }

    var body: some View {
        NavigationStack {
            Group {
                if isSent {
                    sentView
                } else {
                    form
                }
            }
            .navigationTitle(isSent ? "" : target.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isSending)
        .task { if model.blockedAccounts == nil { await model.refreshBlockedAccounts() } }
        .alert(
            "Could not send the report",
            isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
    }

    private var form: some View {
        Form {
            Section {
                ForEach(CloudReportReason.allCases) { option in
                    Button {
                        reason = option
                    } label: {
                        HStack {
                            Text(option.label)
                                .foregroundStyle(.primary)
                            Spacer(minLength: 8)
                            if reason == option {
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(.tint)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .accessibilityAddTraits(reason == option ? .isSelected : [])
                    .accessibilityIdentifier("report-reason-\(option.rawValue)")
                }
            }

            Section {
                TextField("Add details (optional)", text: $details, axis: .vertical)
                    .lineLimit(3...8)
                    .onChange(of: details) { _, newValue in
                        if newValue.count > CloudReportRequest.maxDetailsLength {
                            details = String(newValue.prefix(CloudReportRequest.maxDetailsLength))
                        }
                    }
                    .accessibilityIdentifier("report-details")
            }

            if offersBlock, let account = target.account {
                Section {
                    Toggle("Also block \(account.name)", isOn: $alsoBlock)
                        .accessibilityIdentifier("report-also-block")
                }
            }
        }
        .disabled(isSending)
    }

    private var sentView: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 44))
                .foregroundStyle(.green)
                .accessibilityHidden(true)
            Text("Report sent")
                .font(.title3.weight(.semibold))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .task {
            try? await Task.sleep(for: .seconds(1.2))
            dismiss()
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if !isSent {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
                    .disabled(isSending)
            }
            ToolbarItem(placement: .confirmationAction) {
                if isSending {
                    ProgressView()
                } else {
                    Button("Send", action: send)
                        .fontWeight(.semibold)
                        .disabled(reason == nil)
                        .accessibilityIdentifier("report-send")
                }
            }
        }
    }

    private func send() {
        guard let reason, !isSending else { return }
        let block = offersBlock && alsoBlock
        let next = ReportAttempt.next(after: attempt, key: ReportAttempt.key(reason: reason, details: details, alsoBlock: block))
        attempt = next
        isSending = true
        Task {
            defer { isSending = false }
            switch await model.report(target, reason: reason, details: details, alsoBlock: block, clientReportId: next.clientReportId) {
            case .success(let result):
                withAnimation { isSent = true }
                AccessibilityNotification.Announcement("Report sent").post()
                if result.blocked { onBlocked?() }
            case .failure(let error):
                failure = error.message
            }
        }
    }
}
