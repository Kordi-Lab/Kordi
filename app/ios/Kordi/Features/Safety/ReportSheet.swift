import SwiftUI

/// Reports one message or an account to the Kordi team, with an optional
/// block. Only the chosen message's id is sent; the server copies it.
struct ReportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    let target: ReportTarget

    @State private var reason: CloudReportReason?
    @State private var details = ""
    @State private var alsoBlock = false
    @State private var isSending = false
    @State private var failure: String?
    @State private var attempt: ReportAttempt?
    @State private var receipt: CloudReportReceipt?
    @State private var blockOutcome: SafetyActionResult?

    private var detailsRemaining: Int {
        max(0, CloudReportRequest.maxDetailsLength - details.count)
    }

    private var canOfferBlock: Bool {
        guard let accountId = target.accountId else { return false }
        return model.safetyActionsAllowed(for: accountId) && !model.isBlocked(accountId)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let receipt {
                    receiptView(receipt)
                } else {
                    form
                }
            }
            // The title is the first row of the form, where a long name can
            // wrap; the bar between Cancel and Send report would cut it short.
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
        .interactiveDismissDisabled(isSending)
    }

    private var form: some View {
        Form {
            Section {
                Text(target.title)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
            }

            if let failure {
                Section {
                    Label(failure, systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }

            Section {
                Picker("What's happening?", selection: $reason) {
                    ForEach(CloudReportReason.allCases) { reason in
                        Text(reason.label).tag(Optional(reason))
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("What's happening?")
            }

            Section {
                if target.isMessageReport {
                    Text("1 message you selected. Only these messages are included, with details about any files attached to them. Nothing else from this chat is sent.")
                        .font(.subheadline)
                    if let preview = target.messagePreview {
                        Text(preview)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(4)
                            .accessibilityLabel("Selected message: \(preview)")
                    }
                } else {
                    Text("No messages are included. To include messages, choose Report on a message.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                TextField("Anything else we should know? (optional)", text: $details, axis: .vertical)
                    .lineLimit(3...8)
                    .onChange(of: details) { _, newValue in
                        if newValue.count > CloudReportRequest.maxDetailsLength {
                            details = String(newValue.prefix(CloudReportRequest.maxDetailsLength))
                        }
                    }
            } footer: {
                Text("\(detailsRemaining) characters left")
                    .monospacedDigit()
            }

            if canOfferBlock {
                Section {
                    Toggle("Also block \(target.name)", isOn: $alsoBlock)
                }
            }

            Section {
            } footer: {
                Text("Your report goes to the Kordi team with your account name. We keep reports for up to 90 days after we close them. We may not be able to reply or tell you what we did.")
            }
        }
        .disabled(isSending)
    }

    private func receiptView(_ receipt: CloudReportReceipt) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.green)
                .accessibilityHidden(true)
            Text("Report sent")
                .font(.title2.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Text("Reference \(receipt.reference). Thanks for telling us.")
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
            switch blockOutcome {
            case .done:
                Text(SafetyCopy.blocked(target.name))
                    .foregroundStyle(.secondary)
            case .failed(let message):
                Text(message)
                    .foregroundStyle(.red)
            case nil:
                EmptyView()
            }
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .frame(minHeight: 44)
                .padding(.top, 8)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if receipt == nil {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
                    .disabled(isSending)
            }
            ToolbarItem(placement: .confirmationAction) {
                if isSending {
                    ProgressView()
                } else {
                    Button("Send report", action: send)
                        .fontWeight(.semibold)
                        .disabled(reason == nil)
                        .accessibilityHint(reason == nil ? "Choose what's happening first." : "")
                }
            }
        }
    }

    private func send() {
        guard let reason, !isSending else { return }
        let next = ReportAttempt.next(after: attempt, key: ReportAttempt.key(reason: reason, details: details))
        attempt = next
        isSending = true
        failure = nil
        Task {
            defer { isSending = false }
            switch await model.report(target, reason: reason, details: details, clientReportId: next.clientReportId) {
            case .success(let sent):
                if alsoBlock, let accountId = target.accountId {
                    blockOutcome = await model.block(accountId: accountId, name: target.name)
                }
                receipt = sent
                var announcement = "Report sent. Reference \(sent.reference)."
                if blockOutcome == .done { announcement += " \(SafetyCopy.blocked(target.name))" }
                AccessibilityNotification.Announcement(announcement).post()
            case .failure(let error):
                failure = error.message
                AccessibilityNotification.Announcement(error.message).post()
            }
        }
    }
}
