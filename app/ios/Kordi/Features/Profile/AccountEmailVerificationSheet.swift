import SwiftUI
import UIKit

/// Shows whether the signed-in account's primary email is verified.
struct AccountEmailVerificationStatus: View {
    let verified: Bool

    var body: some View {
        Label(
            verified ? "Verified" : "Not verified",
            systemImage: verified ? "checkmark.seal.fill" : "exclamationmark.circle"
        )
        .font(.caption)
        .foregroundStyle(verified ? Color.green : Color.orange)
        .labelStyle(.titleAndIcon)
    }
}

/// Sends a six-digit code to the account's primary email and confirms it.
struct AccountEmailVerificationSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    let email: String

    @State private var challenge: CloudSignupCodeChallenge?
    @State private var verificationCode = ""
    @State private var resendAt = Date.distantPast
    @State private var isSending = false
    @State private var isVerifying = false
    @State private var didRequestInitialCode = false
    @FocusState private var codeFieldFocused: Bool

    private var isBusy: Bool { isSending || isVerifying }

    private var codeIsComplete: Bool {
        verificationCode.utf8.count == 6 && verificationCode.utf8.allSatisfy { (48...57).contains($0) }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(instructions)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Section("Email verification code") {
                    TextField("123456", text: $verificationCode)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .font(.title3.monospacedDigit())
                        .focused($codeFieldFocused)
                        .disabled(isBusy || challenge == nil)
                        .onChange(of: verificationCode) { _, next in
                            let digits = String(next.filter { $0.isASCII && $0.isNumber }.prefix(6))
                            if digits != next { verificationCode = digits }
                        }
                        .accessibilityIdentifier("account-email-code")

                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let seconds = max(0, Int(ceil(resendAt.timeIntervalSince(context.date))))
                        Button {
                            Task { await requestCode() }
                        } label: {
                            HStack(spacing: 8) {
                                if isSending { ProgressView() }
                                Text(resendLabel(seconds: seconds))
                            }
                        }
                        .font(.footnote)
                        .disabled(isBusy || seconds > 0)
                        .accessibilityIdentifier("account-email-resend")
                    }
                }

                if let error = model.errorMessage {
                    Section {
                        Label {
                            Text(error).fixedSize(horizontal: false, vertical: true)
                        } icon: {
                            Image(systemName: "exclamationmark.circle.fill")
                        }
                        .font(.subheadline)
                        .foregroundStyle(.red)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .accessibilityLabel("Email verification error: \(error)")
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }

                Section {
                    Button {
                        Task { await verify() }
                    } label: {
                        HStack {
                            if isVerifying { ProgressView() }
                            Text(isVerifying ? "Verifying…" : "Verify email")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(isBusy || challenge == nil || !codeIsComplete)
                    .accessibilityIdentifier("account-email-verify")
                }
                .listRowBackground(Color.clear)
            }
            .navigationTitle("Verify email")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { close() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isVerifying)
        .task {
            guard !didRequestInitialCode else { return }
            didRequestInitialCode = true
            await requestCode()
        }
        .onChange(of: model.account?.primaryEmailVerified) { _, verified in
            // The server can report that another device already verified it.
            if verified == true { close() }
        }
    }

    private var instructions: String {
        guard challenge != nil else {
            return isSending
                ? "Sending a 6-digit code to \(email)…"
                : "We’ll email a 6-digit code to \(email)."
        }
        return "Enter the 6-digit code sent to \(email). It expires in 10 minutes. Check your spam folder too."
    }

    private func resendLabel(seconds: Int) -> String {
        if seconds > 0 { return "Resend in \(seconds)s" }
        if isSending { return "Sending code…" }
        return challenge == nil ? "Send code" : "Resend code"
    }

    private func requestCode() async {
        guard !isBusy else { return }
        isSending = true
        defer { isSending = false }
        if let next = await model.requestAccountEmailCode() {
            challenge = next
            verificationCode = ""
            resendAt = Date().addingTimeInterval(TimeInterval(next.retryAfterSeconds))
            codeFieldFocused = true
        }
    }

    private func verify() async {
        guard let challenge, codeIsComplete, !isBusy else { return }
        isVerifying = true
        defer { isVerifying = false }
        let verified = await model.verifyAccountEmail(
            verificationId: challenge.verificationId,
            verificationCode: verificationCode
        )
        guard verified else { return }
        UIAccessibility.post(notification: .announcement, argument: "Email verified")
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        close()
    }

    private func close() {
        model.errorMessage = nil
        dismiss()
    }
}
