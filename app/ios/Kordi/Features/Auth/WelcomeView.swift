import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The signed-out screen: Log in and Sign up through the system browser.
/// The in-app email form appears only when the server has no browser sign-in
/// for this app (404, 405, or `invalid_client`).
struct WelcomeView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

    /// Set once the server is known to lack browser sign-in; picks the form's mode.
    @State private var fallback: AppSignInIntent? = WelcomeView.previewFallback
    @State private var activeIntent: AppSignInIntent?
    @State private var isSigningInWithApple = false
    /// Restores a sign-in kept after a failed launch. Log in and Sign up stay
    /// usable meanwhile; tapping one cancels the restore.
    @State private var resumeTask: Task<Void, Never>?

    /// `--preview-signup` and `--preview-email-sign-in` open the email form directly.
    private static var previewFallback: AppSignInIntent? {
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--preview-signup") { return .signup }
        return arguments.contains("--preview-email-sign-in") ? .login : nil
    }

    var body: some View {
        Group {
            if let fallback {
                LoginView(signup: fallback == .signup)
            } else {
                welcome
            }
        }
        .task {
            resume()
            await settleAvailability()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { resume() }
        }
    }

    private var isAccessibilitySize: Bool { dynamicTypeSize.isAccessibilitySize }

    private var welcome: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 32)
                    header
                    Spacer(minLength: 32)
                    actions
                }
                .padding(.horizontal, 24)
                .padding(.top, 28)
                .padding(.bottom, 20)
                .frame(maxWidth: 440)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private var header: some View {
        VStack(spacing: 14) {
            KordiMark(size: isAccessibilitySize ? 62 : 74)
            VStack(spacing: 7) {
                Text(KordiLoginCopy.title(signup: false))
                    .font(isAccessibilitySize ? .title.bold() : .largeTitle.bold())
                    .tracking(-0.6)
                Text(KordiLoginCopy.subtitle(signup: false, accessibility: isAccessibilitySize)
                    ?? "Building Next-generation Supercollaboration")
                    .font(isAccessibilitySize ? .body.weight(.medium) : .subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .multilineTextAlignment(.center)
        }
        .accessibilityElement(children: .combine)
    }

    private var actions: some View {
        VStack(spacing: 12) {
            if let error = model.errorMessage {
                Label {
                    Text(error).fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "exclamationmark.circle.fill")
                }
                .font(.subheadline)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 4)
            }
            appleButton
            actionButton(.login, title: "Log in", primary: true)
            actionButton(.signup, title: "Sign up", primary: false)
            Text(KordiLegalLinks.agreement)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .tint(.primary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
                .accessibilityIdentifier("welcome-legal")
        }
    }

    /// Apple's button in the style that stands apart from the ink Log in:
    /// white with an outline in light mode, white in dark mode (Apple's
    /// guidelines rule out the black style on a dark background).
    private var appleButton: some View {
        AppleSignInButton(style: colorScheme == .dark ? .white : .whiteOutline, cornerRadius: 26) {
            Task { await startApple() }
        }
        .id(colorScheme)
        .frame(maxWidth: .infinity, minHeight: 52, maxHeight: 52)
        .disabled(activeIntent != nil || isSigningInWithApple)
        .opacity(activeIntent != nil || isSigningInWithApple ? 0.6 : 1)
        .accessibilityIdentifier("welcome-apple")
    }

    private func actionButton(_ intent: AppSignInIntent, title: String, primary: Bool) -> some View {
        Button {
            Task { await start(intent) }
        } label: {
            ZStack {
                Text(title)
                    .font(.headline)
                    .opacity(activeIntent == intent ? 0 : 1)
                if activeIntent == intent {
                    ProgressView().tint(primary ? KordiTheme.loginPrimaryText : nil)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 52)
        }
        .buttonStyle(WelcomeButtonStyle(primary: primary))
        .disabled(activeIntent != nil || isSigningInWithApple)
        .accessibilityLabel(title)
    }

    private func settleAvailability() async {
        guard fallback == nil, await model.browserSignInAvailability() == .unavailable,
              activeIntent == nil else { return }
        fallback = .login
    }

    private func resume() {
        guard resumeTask == nil, activeIntent == nil else { return }
        resumeTask = Task {
            await model.resumeStoredBrowserSession()
            resumeTask = nil
        }
    }

    private func startApple() async {
        guard activeIntent == nil, !isSigningInWithApple else { return }
        resumeTask?.cancel()
        resumeTask = nil
        isSigningInWithApple = true
        defer { isSigningInWithApple = false }
        guard await model.signInWithApple() else { return }
#if canImport(UIKit)
        UIAccessibility.post(notification: .announcement, argument: "Signed in")
#endif
    }

    private func start(_ intent: AppSignInIntent) async {
        guard activeIntent == nil, !isSigningInWithApple else { return }
        resumeTask?.cancel()
        resumeTask = nil
        activeIntent = intent
        model.errorMessage = nil
        defer { activeIntent = nil }
        // Settle availability first so an older server falls back to the form.
        if await model.browserSignInAvailability() == .unavailable {
            fallback = intent
            return
        }
        guard await model.signInWithBrowser(intent) else { return }
#if canImport(UIKit)
        // The page may have signed in to an existing account, so never claim one was created.
        UIAccessibility.post(notification: .announcement, argument: "Signed in")
#endif
    }
}

struct WelcomeButtonStyle: ButtonStyle {
    let primary: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(primary ? KordiTheme.loginPrimaryText : Color.primary)
            .background(
                primary ? KordiTheme.loginPrimaryFill : Color(uiColor: .secondarySystemGroupedBackground),
                in: Capsule()
            )
            .overlay {
                if !primary {
                    Capsule().stroke(Color(uiColor: .separator).opacity(0.30), lineWidth: 0.5)
                }
            }
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.6)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

#Preview("Welcome") {
    WelcomeView()
        .environmentObject(AppModel(previewMode: true))
}
