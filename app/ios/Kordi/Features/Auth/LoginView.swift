import PhotosUI
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct LoginView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Namespace private var modeSelection

    @State private var mode: AuthMode
    @State private var displayName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var activeSubmission: Submission?
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var avatarImage: UIImage?
    @State private var avatarDataURL: String?
    @State private var avatarPalette = 0
    @State private var avatarError: String?
    @FocusState private var focusedField: Field?

    private enum AuthMode: String, CaseIterable, Identifiable {
        case login
        case signup

        var id: String { rawValue }
        var label: String { self == .login ? "Log in" : "Sign up" }
    }

    private enum Field { case displayName, email, password, confirmPassword }
    private enum Submission: Equatable { case form, social(CloudOAuthProvider) }

    init() {
        let startsInSignup = ProcessInfo.processInfo.arguments.contains("--preview-signup")
        _mode = State(initialValue: startsInSignup ? .signup : .login)
    }

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                ScrollView {
                    VStack(spacing: dynamicTypeSize.isAccessibilitySize ? 24 : 28) {
                        header
                        socialSignIn
                        divider
                        modePicker
                        form

                        Text("Use the same Kordi account on iPhone and Mac.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 28)
                    .frame(maxWidth: 440)
                    .frame(
                        maxWidth: .infinity,
                        minHeight: proxy.size.height,
                        alignment: dynamicTypeSize.isAccessibilitySize || mode == .signup ? .top : .center
                    )
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar(.hidden, for: .navigationBar)
        }
        .onChange(of: selectedPhoto) { _, item in
            guard let item else { return }
            Task { await loadAvatar(item) }
        }
    }

    private var isSignup: Bool { mode == .signup }
    private var isBusy: Bool { activeSubmission != nil }
    private var cleanEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var emailIsValid: Bool {
        let parts = cleanEmail.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") && !cleanEmail.contains(where: \.isWhitespace)
    }
    private var canSubmit: Bool {
        !isBusy && emailIsValid && password.count >= 8 && (!isSignup || password == confirmPassword)
    }

    private var header: some View {
        VStack(spacing: 14) {
            KordiMark(size: dynamicTypeSize.isAccessibilitySize ? 62 : 74)

            VStack(spacing: 7) {
                Text(isSignup ? "Create your account" : "Welcome to Kordi")
                    .font(dynamicTypeSize.isAccessibilitySize ? .title.bold() : .largeTitle.bold())
                    .tracking(-0.6)
                    .multilineTextAlignment(.center)

                Text(headerSubtitle)
                    .font(dynamicTypeSize.isAccessibilitySize ? .body.weight(.medium) : .subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var headerSubtitle: String {
        if dynamicTypeSize.isAccessibilitySize { return "People and agents, together." }
        return isSignup
            ? "Sign up for Next-generation Supercollaboration"
            : "Building Next-generation Supercollaboration"
    }

    private var socialSignIn: some View {
        HStack(spacing: 18) {
            ForEach(CloudOAuthProvider.allCases) { provider in
                Button {
                    Task { await submitSocial(provider) }
                } label: {
                    ZStack {
                        Image(provider == .google ? "GoogleMark" : "GitHubMark")
                            .resizable()
                            .scaledToFit()
                            .frame(width: provider == .google ? 20 : 23, height: provider == .google ? 20 : 23)
                            .foregroundStyle(.primary)
                            .opacity(activeSubmission == .social(provider) ? 0 : 1)

                        if activeSubmission == .social(provider) {
                            ProgressView()
                        }
                    }
                    .frame(width: 50, height: 50)
                }
                .buttonStyle(KordiSocialButtonStyle())
                .disabled(isBusy)
                .accessibilityLabel("Continue with \(provider.displayName)")
            }
        }
    }

    private var divider: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Color(uiColor: .separator).opacity(0.55)).frame(height: 0.5)
            Text("or")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            Rectangle().fill(Color(uiColor: .separator).opacity(0.55)).frame(height: 0.5)
        }
        .accessibilityHidden(true)
    }

    private var modePicker: some View {
        HStack(spacing: 4) {
            ForEach(AuthMode.allCases) { item in
                Button {
                    switchMode(to: item)
                } label: {
                    Text(item.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(mode == item ? .primary : .secondary)
                        .frame(maxWidth: .infinity, minHeight: 38)
                        .background {
                            if mode == item {
                                Capsule()
                                    .fill(Color(uiColor: .secondarySystemGroupedBackground))
                                    .matchedGeometryEffect(id: "auth-mode", in: modeSelection)
                                    .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(mode == item ? .isSelected : [])
            }
        }
        .padding(4)
        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            if isSignup {
                signupIdentity
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }

            authField(label: "Email") {
                TextField("you@company.com", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focusedField, equals: .email)
                    .onSubmit { focusedField = .password }
            }

            authField(label: "Password", hint: passwordHint) {
                SecureField("••••••••", text: $password)
                    .textContentType(isSignup ? .newPassword : .password)
                    .submitLabel(isSignup ? .next : .go)
                    .focused($focusedField, equals: .password)
                    .onSubmit {
                        if isSignup { focusedField = .confirmPassword }
                        else { Task { await submitForm() } }
                    }
            }

            if isSignup {
                authField(label: "Confirm Password", hint: confirmationHint) {
                    SecureField("••••••••", text: $confirmPassword)
                        .textContentType(.newPassword)
                        .submitLabel(.go)
                        .focused($focusedField, equals: .confirmPassword)
                        .onSubmit { Task { await submitForm() } }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            if let error = model.errorMessage ?? avatarError {
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
                .accessibilityLabel("Authentication error: \(error)")
            }

            Button {
                Task { await submitForm() }
            } label: {
                HStack(spacing: 9) {
                    if activeSubmission == .form {
                        ProgressView().tint(KordiTheme.loginPrimaryText)
                    }
                    Text(submitLabel).font(.headline)
                }
                .frame(maxWidth: .infinity, minHeight: 52)
            }
            .buttonStyle(KordiLoginButtonStyle())
            .disabled(!canSubmit)
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.20), value: mode)
    }

    private var signupIdentity: some View {
        HStack(spacing: 14) {
            PhotosPicker(selection: $selectedPhoto, matching: .images) {
                ZStack(alignment: .bottomTrailing) {
                    SignupAvatarView(
                        image: avatarImage,
                        initials: SignupAvatarRenderer.initials(for: displayName),
                        paletteIndex: avatarPalette
                    )
                    Image(systemName: "camera.fill")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 26, height: 26)
                        .background(KordiTheme.signalBlue, in: Circle())
                        .overlay(Circle().stroke(Color(uiColor: .systemGroupedBackground), lineWidth: 2))
                }
            }
            .buttonStyle(.plain)
            .disabled(isBusy)
            .accessibilityLabel("Choose profile photo")

            VStack(alignment: .leading, spacing: 8) {
                TextField("Display name", text: $displayName)
                    .textContentType(.name)
                    .submitLabel(.next)
                    .focused($focusedField, equals: .displayName)
                    .onSubmit { focusedField = .email }
                    .kordiLoginField(isFocused: focusedField == .displayName)

                Button {
                    avatarImage = nil
                    avatarDataURL = nil
                    avatarPalette = (avatarPalette + 1) % SignupAvatarRenderer.colors.count
                    avatarError = nil
                } label: {
                    Label("New look", systemImage: "shuffle")
                        .font(.caption.weight(.semibold))
                }
                .disabled(isBusy)
            }
        }
    }

    private var passwordHint: String? {
        guard isSignup, !password.isEmpty, password.count < 8 else { return nil }
        return "Use at least 8 characters."
    }

    private var confirmationHint: String? {
        guard !confirmPassword.isEmpty, confirmPassword != password else { return nil }
        return "Passwords do not match."
    }

    private var submitLabel: String {
        if activeSubmission == .form { return isSignup ? "Creating account…" : "Signing in…" }
        return isSignup ? "Create account" : "Continue"
    }

    private func authField<Content: View>(
        label: String,
        hint: String? = nil,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            content()
                .kordiLoginField(isFocused: fieldIsFocused(label))
            if let hint {
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 4)
            }
        }
    }

    private func fieldIsFocused(_ label: String) -> Bool {
        switch label {
        case "Email": focusedField == .email
        case "Password": focusedField == .password
        case "Confirm Password": focusedField == .confirmPassword
        default: false
        }
    }

    private func switchMode(to nextMode: AuthMode) {
        guard mode != nextMode, !isBusy else { return }
        focusedField = nil
        model.errorMessage = nil
        avatarError = nil
        if reduceMotion { mode = nextMode }
        else {
            withAnimation(.easeOut(duration: 0.20)) { mode = nextMode }
        }
    }

    private func submitForm() async {
        guard canSubmit else { return }
        activeSubmission = .form
        model.errorMessage = nil
        avatarError = nil
        defer { activeSubmission = nil }

        let succeeded: Bool
        if isSignup {
            guard let avatar = avatarDataURL ?? SignupAvatarRenderer.generatedDataURL(
                displayName: displayName,
                paletteIndex: avatarPalette
            ) else {
                avatarError = "Could not prepare your profile photo. Try again."
                return
            }
            succeeded = await model.signUp(
                email: email,
                password: password,
                displayName: displayName,
                avatarUrl: avatar
            )
        } else {
            succeeded = await model.signIn(email: email, password: password)
        }
        announceSuccess(succeeded)
    }

    private func submitSocial(_ provider: CloudOAuthProvider) async {
        guard !isBusy else { return }
        activeSubmission = .social(provider)
        model.errorMessage = nil
        defer { activeSubmission = nil }
        announceSuccess(await model.signIn(with: provider))
    }

    private func loadAvatar(_ item: PhotosPickerItem) async {
        avatarError = nil
        guard let data = try? await item.loadTransferable(type: Data.self),
              let prepared = SignupAvatarRenderer.uploadedImage(from: data) else {
            avatarError = "Choose a smaller PNG, JPEG, or WebP photo."
            return
        }
        avatarImage = prepared.image
        avatarDataURL = prepared.dataURL
    }

    private func announceSuccess(_ succeeded: Bool) {
        guard succeeded, !reduceMotion else { return }
#if canImport(UIKit)
        UIAccessibility.post(notification: .announcement, argument: isSignup ? "Account created" : "Signed in")
#endif
    }
}

private struct SignupAvatarView: View {
    let image: UIImage?
    let initials: String
    let paletteIndex: Int

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ZStack {
                    Color(uiColor: SignupAvatarRenderer.colors[abs(paletteIndex) % SignupAvatarRenderer.colors.count].background)
                    Text(initials)
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Color(uiColor: SignupAvatarRenderer.colors[abs(paletteIndex) % SignupAvatarRenderer.colors.count].foreground))
                }
            }
        }
        .frame(width: 68, height: 68)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color(uiColor: .separator).opacity(0.35), lineWidth: 0.5))
    }
}

private extension View {
    func kordiLoginField(isFocused: Bool) -> some View {
        padding(.horizontal, 16)
            .frame(minHeight: 52)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: Capsule())
            .overlay {
                if isFocused {
                    Capsule().stroke(KordiTheme.signalBlue.opacity(0.55), lineWidth: 1.5)
                }
            }
    }
}

private struct KordiSocialButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: Circle())
            .overlay(Circle().stroke(Color(uiColor: .separator).opacity(0.30), lineWidth: 0.5))
            .opacity(isEnabled ? (configuration.isPressed ? 0.72 : 1) : 0.5)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

private struct KordiLoginButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(KordiTheme.loginPrimaryText)
            .background(KordiTheme.loginPrimaryFill, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.42)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

#Preview("Login") {
    LoginView()
        .environmentObject(AppModel(previewMode: false))
        .tint(KordiTheme.signalBlue)
}
