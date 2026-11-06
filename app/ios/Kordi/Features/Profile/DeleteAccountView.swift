import SwiftUI
import UIKit

/// Edit profile › Delete account (owner decision B1).
struct DeleteAccountView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var callCoordinator: KordiCallCoordinator
    @State private var mode: AccountDeletionProofMode = .loading
    @State private var password = ""
    @State private var challenge: CloudSignupCodeChallenge?
    @State private var code = ""
    @State private var resendAt = Date.distantPast
    @State private var isSendingCode = false
    @State private var isDeleting = false
    @State private var confirms: Bool
    @State private var error: String?
    @FocusState private var focused: Bool

    static let summary = "Your account, contacts, files, agents and memories are deleted. This can't be undone."

    init(showingConfirmation: Bool = ProcessInfo.processInfo.arguments.contains("--preview-delete-account-confirm")) {
        _confirms = State(initialValue: showingConfirmation)
    }

    private var codeIsComplete: Bool {
        code.utf8.count == 6 && code.utf8.allSatisfy { (48...57).contains($0) }
    }

    private var canDelete: Bool {
        guard !isDeleting else { return false }
        switch mode {
        case .loading, .signInAgain: return false
        case .password: return !password.isEmpty || (challenge != nil && codeIsComplete)
        case .emailCode: return challenge != nil && codeIsComplete
        case .recentSignIn: return true
        }
    }

    var body: some View {
        SettingsPage {
            Text(Self.summary)
                .font(SettingsFont.rowTitle)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 8)
            proofSection
            if let error {
                SettingsErrorLabel(error)
            }
            Button(role: .destructive) {
                focused = false
                confirms = true
            } label: {
                HStack {
                    if isDeleting { ProgressView() }
                    Text("Delete account")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .controlSize(.large)
            .disabled(!canDelete)
            .padding(.top, 16)
            .accessibilityIdentifier("delete-account-submit")
        }
        .navigationTitle("Delete account")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(isDeleting)
        .task {
            guard mode == .loading else { return }
            mode = await model.accountDeletionProofMode()
        }
        .alert("Delete account?", isPresented: $confirms) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { Task { await delete() } }
        } message: {
            Text("This can't be undone.")
        }
    }

    @ViewBuilder
    private var proofSection: some View {
        switch mode {
        case .loading:
            SettingsLoadingRow("Loading…")
        case .recentSignIn:
            EmptyView()
        case .signInAgain:
            Text("Sign in again to delete your account.")
                .font(SettingsFont.rowTitle)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)
                .accessibilityIdentifier("delete-account-sign-in-again")
        case .password(let allowsEmailCode):
            SettingsSectionTitle("Confirm it's you")
                .padding(.top, 8)
            if challenge == nil {
                SecureField("Current password", text: $password)
                    .textContentType(.password)
                    .submitLabel(.done)
                    .settingsField()
                    .focused($focused)
                    .disabled(isDeleting)
                    .accessibilityIdentifier("delete-account-password")
                if allowsEmailCode {
                    sendCodeButton(title: "Email me a code instead")
                }
            } else {
                codeField
            }
        case .emailCode:
            SettingsSectionTitle("Confirm it's you")
                .padding(.top, 8)
            if challenge == nil {
                sendCodeButton(title: "Email me a code")
            } else {
                codeField
            }
        }
    }

    private func sendCodeButton(title: String) -> some View {
        Button {
            Task { await sendCode() }
        } label: {
            HStack(spacing: 8) {
                if isSendingCode { ProgressView() }
                Text(title)
            }
        }
        .font(SettingsFont.inlineAction)
        .frame(minHeight: SettingsMetrics.textRowMinHeight)
        .disabled(isSendingCode || isDeleting)
        .accessibilityIdentifier("delete-account-send-code")
    }

    @ViewBuilder
    private var codeField: some View {
        TextField("123456", text: $code)
            .textContentType(.oneTimeCode)
            .keyboardType(.numberPad)
            .font(.title3.monospacedDigit())
            .settingsField()
            .focused($focused)
            .disabled(isDeleting)
            .onChange(of: code) { _, next in
                let digits = String(next.filter { $0.isASCII && $0.isNumber }.prefix(6))
                if digits != next { code = digits }
            }
            .accessibilityIdentifier("delete-account-code")
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let seconds = max(0, Int(ceil(resendAt.timeIntervalSince(context.date))))
            Button(seconds > 0 ? "Resend in \(seconds)s" : "Resend code") {
                Task { await sendCode() }
            }
            .font(SettingsFont.inlineAction)
            .frame(minHeight: SettingsMetrics.textRowMinHeight)
            .disabled(isSendingCode || isDeleting || seconds > 0)
        }
    }

    private func sendCode() async {
        guard !isSendingCode else { return }
        isSendingCode = true
        error = nil
        defer { isSendingCode = false }
        do {
            let next = try await model.requestAccountDeletionCode()
            challenge = next
            code = ""
            resendAt = Date().addingTimeInterval(TimeInterval(next.retryAfterSeconds))
            focused = true
        } catch {
            self.error = model.userFacing(error, fallback: "Could not send a code. Try again.")
        }
    }

    private var proof: AccountDeletionRequest {
        if let challenge, codeIsComplete {
            return AccountDeletionRequest(verificationId: challenge.verificationId, verificationCode: code)
        }
        if case .password = mode, !password.isEmpty {
            return AccountDeletionRequest(currentPassword: password)
        }
        return AccountDeletionRequest()
    }

    private func delete() async {
        guard canDelete else { return }
        isDeleting = true
        error = nil
        defer { isDeleting = false }
        do {
            try await model.deleteAccount(proof, callCoordinator: callCoordinator)
            UIAccessibility.post(notification: .announcement, argument: "Account deleted")
        } catch {
            let next = AccountDeletionProofMode.after(error, current: mode)
            if next != mode {
                mode = next
                challenge = nil
                code = ""
            }
            self.error = model.userFacing(error, fallback: "Could not delete your account. Try again.")
        }
    }
}

#if DEBUG
/// `--preview-delete-account` and `--preview-delete-account-confirm`.
struct DeleteAccountPreview: View {
    @Environment(\.kordiChatTheme) private var chatTheme

    var body: some View {
        NavigationStack {
            DeleteAccountView()
        }
        .tint(chatTheme.accent)
    }
}
#endif
