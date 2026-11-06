import SwiftUI
import UIKit

/// The consent sheet: title, one line, the privacy policy, Allow and Don't allow.
struct AIConsentSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    let onFinish: () -> Void
    @State private var saving: AIConsentStatus?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(AIConsentCopy.title)
                .font(.title3.bold())
                .accessibilityAddTraits(.isHeader)
            Text(AIConsentCopy.body)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Privacy policy") { openURL(KordiLegalLinks.privacy) }
                .font(SettingsFont.action)
                .tint(.primary)
            if let error {
                SettingsErrorLabel(error)
            }
            VStack(spacing: 10) {
                choiceButton("Allow", status: .allowed, primary: true)
                choiceButton("Don't allow", status: .declined, primary: false)
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 28)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func choiceButton(_ title: String, status: AIConsentStatus, primary: Bool) -> some View {
        Button {
            Task { await choose(status) }
        } label: {
            ZStack {
                Text(title).font(.headline).opacity(saving == status ? 0 : 1)
                if saving == status {
                    ProgressView().tint(primary ? KordiTheme.loginPrimaryText : nil)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 52)
        }
        .buttonStyle(WelcomeButtonStyle(primary: primary))
        .disabled(saving != nil)
        .accessibilityIdentifier(status == .allowed ? "ai-consent-allow" : "ai-consent-decline")
    }

    private func choose(_ status: AIConsentStatus) async {
        guard saving == nil else { return }
        saving = status
        error = nil
        let failure = await model.setAIConsent(status)
        saving = nil
        if let failure {
            error = failure
        } else {
            onFinish()
        }
    }
}

/// Presents the AI choice above whatever is on screen, including other sheets,
/// so every AI entry point can ask without its own presentation state.
@MainActor
enum AIConsentPresenter {
    private static weak var presented: UIViewController?
    private static var promptedAccountIds: Set<String> = []

    /// The sheet rises by itself once per account and launch.
    static func shouldPromptAfterSignIn(accountId: String) -> Bool {
        promptedAccountIds.insert(accountId).inserted
    }

    static func presentConsent(model: AppModel) {
        guard presented == nil, let host = topController() else { return }
        let holder = WeakControllerBox()
        let sheet = AIConsentSheet(onFinish: { holder.controller?.dismiss(animated: true) })
            .environmentObject(model)
        let controller = UIHostingController(rootView: sheet)
        holder.controller = controller
        controller.isModalInPresentation = true
        // Size the sheet to its content at the screen's width instead of a fixed half height.
        let width = host.view.window?.bounds.width ?? host.view.bounds.width
        if let sheetController = controller.sheetPresentationController {
            sheetController.detents = [.custom(identifier: .init("ai-consent")) { [weak controller] context in
                let fitting = CGSize(width: width, height: .greatestFiniteMagnitude)
                let height = controller?.sizeThatFits(in: fitting).height ?? 0
                return height > 0 ? min(height, context.maximumDetentValue) : context.maximumDetentValue * 0.5
            }]
            sheetController.prefersGrabberVisible = false
        }
        presented = controller
        host.present(controller, animated: true)
    }

    static func presentDeclined(model: AppModel) {
        guard presented == nil, let host = topController() else { return }
        let alert = UIAlertController(
            title: AIConsentCopy.declinedTitle,
            message: AIConsentCopy.declinedMessage,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        let allow = UIAlertAction(title: "Allow", style: .default) { [weak model] _ in
            guard let model else { return }
            Task { @MainActor in
                if let failure = await model.setAIConsent(.allowed) { model.errorMessage = failure }
            }
        }
        alert.addAction(allow)
        alert.preferredAction = allow
        presented = alert
        host.present(alert, animated: true)
    }

    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.first { $0.activationState == .foregroundActive }?.windows.first(where: \.isKeyWindow)
            ?? scenes.flatMap(\.windows).first(where: \.isKeyWindow)
        var top = window?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed {
            top = next
        }
        if top is UIAlertController { return nil }
        return top
    }

    private final class WeakControllerBox {
        weak var controller: UIViewController?
    }
}

/// Settings › Privacy: the AI switch and the legal pages.
struct PrivacySettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var isSaving = false
    @State private var error: String?

    var body: some View {
        SettingsPage {
            Toggle(isOn: Binding(
                get: { AIConsentGate.sharesWithAI(model.aiConsent?.status) },
                set: { allowed in Task { await save(allowed ? .allowed : .declined) } }
            )) {
                CompactSettingsLabel(title: AIConsentCopy.toggle, systemImage: "sparkles")
            }
            .frame(minHeight: SettingsMetrics.rowMinHeight)
            .disabled(isSaving)
            .accessibilityIdentifier("privacy-ai-toggle")
            SettingsCaption(AIConsentCopy.caption)
            if let error {
                SettingsErrorLabel(error)
            }
            SettingsDivider()
            LegalLinkRow(title: "Privacy policy", systemImage: "hand.raised", url: KordiLegalLinks.privacy)
            LegalLinkRow(title: "Terms of service", systemImage: "doc.plaintext", url: KordiLegalLinks.terms)
        }
        .navigationTitle("Privacy")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.refreshAIConsent() }
    }

    private func save(_ status: AIConsentStatus) async {
        isSaving = true
        error = await model.setAIConsent(status)
        isSaving = false
    }
}

/// Kordi's public legal pages.
enum KordiLegalLinks {
    static let terms = URL(string: "https://kordi.ai/terms")!
    static let privacy = URL(string: "https://kordi.ai/privacy")!
}

/// A settings row that opens one of Kordi's legal pages in Safari.
struct LegalLinkRow: View {
    @Environment(\.openURL) private var openURL
    let title: String
    let systemImage: String
    let url: URL

    var body: some View {
        Button {
            openURL(url)
        } label: {
            HStack(spacing: 10) {
                CompactSettingsLabel(title: title, systemImage: systemImage)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: SettingsMetrics.rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isLink)
    }
}

#if DEBUG
/// `--preview-privacy-settings`: Settings opened on Privacy.
struct PrivacySettingsPreview: View {
    var body: some View {
        AccountSheet(previewing: .privacy)
    }
}
#endif
