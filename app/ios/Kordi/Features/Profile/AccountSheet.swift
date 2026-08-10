import PhotosUI
import SwiftUI
import UIKit

struct AccountSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue

    var body: some View {
        NavigationStack {
            List {
                Section {
                    accountHeader
                }

                Section {
                    NavigationLink {
                        ProfileSettingsView()
                    } label: {
                        SettingsNavigationLabel(title: "Profile", systemImage: "person")
                    }

                    NavigationLink {
                        ProviderAuthenticationView()
                    } label: {
                        SettingsNavigationLabel(title: "Authentication", systemImage: "key")
                    }

                    NavigationLink {
                        AppearanceSettingsView()
                    } label: {
                        SettingsNavigationLabel(title: "Appearance", systemImage: "paintpalette")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(model.account?.preferredName ?? "Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(preferredColorScheme)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var preferredColorScheme: ColorScheme? {
        switch AppAppearance(rawValue: appearanceRawValue) ?? .system {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    private var accountHeader: some View {
        HStack(spacing: 14) {
            IdentityAvatar(
                name: model.account?.preferredName ?? "Me",
                imageSource: model.account?.avatarUrl.nonEmpty,
                kind: .person,
                size: 54,
                seed: model.account?.accountId
            )
            VStack(alignment: .leading, spacing: 3) {
                Text(model.account?.preferredName ?? "Kordi account")
                    .font(.headline)
                if let email = model.account?.primaryEmail.nonEmpty {
                    Text(email)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}

private struct SettingsNavigationLabel: View {
    let title: String
    let systemImage: String

    var body: some View {
        Label {
            Text(title)
                .foregroundStyle(.primary)
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 22)
        }
        .frame(minHeight: 30)
    }
}

private struct ProfileSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var displayName = ""
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var avatarDraft: String?
    @State private var isSaving = false
    @State private var didLoad = false
    @State private var saved = false
    @State private var copiedKordiID = false

    var body: some View {
        Form {
            Section {
                VStack(spacing: 12) {
                    IdentityAvatar(
                        name: displayName.nonEmpty ?? model.account?.preferredName ?? "Me",
                        imageSource: avatarDraft?.nonEmpty ?? model.account?.avatarUrl.nonEmpty,
                        kind: .person,
                        size: 88,
                        seed: model.account?.accountId
                    )

                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Label("Change photo", systemImage: "photo")
                            .font(.subheadline.weight(.semibold))
                    }
                    .buttonStyle(.bordered)

                    VStack(spacing: 4) {
                        Text(displayName.nonEmpty ?? model.account?.preferredName ?? "Kordi account")
                            .font(.title3.weight(.semibold))
                            .lineLimit(2)
                            .multilineTextAlignment(.center)

                        if let kordiId = model.account?.kordiId.nonEmpty {
                            Button { copyKordiID(kordiId) } label: {
                                HStack(spacing: 6) {
                                    Text("@\(kordiId)")
                                        .monospacedDigit()
                                    Image(systemName: copiedKordiID ? "checkmark" : "doc.on.doc")
                                }
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(copiedKordiID ? Color.green : Color.secondary)
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(copiedKordiID ? "Kordi ID copied" : "Copy Kordi ID @\(kordiId)")
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }

            Section("Display name") {
                HStack(spacing: 12) {
                    Image(systemName: "person")
                        .foregroundStyle(.secondary)
                        .frame(width: 22)

                    TextField("Name", text: $displayName)
                        .textContentType(.name)
                        .autocorrectionDisabled()
                }
            }

            Section("Account") {
                if let email = model.account?.primaryEmail.nonEmpty {
                    LabeledContent {
                        Text(email)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "envelope")
                                .foregroundStyle(.secondary)
                                .frame(width: 22)
                            Text("Email")
                        }
                    }
                }
                if let kordiId = model.account?.kordiId.nonEmpty {
                    Button { copyKordiID(kordiId) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "number")
                                .foregroundStyle(.secondary)
                                .frame(width: 22)
                            Text("Kordi ID")
                                .foregroundStyle(.primary)
                            Spacer(minLength: 8)
                            Text("@\(kordiId)")
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Image(systemName: copiedKordiID ? "checkmark" : "doc.on.doc")
                                .foregroundStyle(copiedKordiID ? Color.green : Color.secondary)
                        }
                        .frame(minHeight: 30)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(copiedKordiID ? "Kordi ID copied" : "Copy Kordi ID @\(kordiId)")
                }
            }

            if let error = model.errorMessage.nonEmpty {
                Section {
                    Label(error, systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        if isSaving { ProgressView() }
                        Text(isSaving ? "Saving…" : saved ? "Saved" : "Save profile")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isSaving || displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .listRowBackground(Color.clear)

            Section {
                Button("Sign out", role: .destructive) {
                    Task { await model.signOut() }
                }
            }
        }
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { loadOnce() }
        .onChange(of: selectedPhoto) { _, item in
            guard let item else { return }
            Task { await loadAvatar(item) }
        }
        .onChange(of: displayName) { _, _ in saved = false }
    }

    private func copyKordiID(_ kordiId: String) {
        UIPasteboard.general.string = "@\(kordiId)"
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        withAnimation(.easeOut(duration: 0.18)) { copiedKordiID = true }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            withAnimation(.easeOut(duration: 0.18)) { copiedKordiID = false }
        }
    }

    private func loadOnce() {
        guard !didLoad else { return }
        didLoad = true
        displayName = model.account?.preferredName ?? ""
        avatarDraft = model.account?.avatarUrl
        model.errorMessage = nil
    }

    private func loadAvatar(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self),
              let prepared = SignupAvatarRenderer.uploadedImage(from: data) else {
            model.errorMessage = "Choose a smaller PNG, JPEG, or WebP photo."
            return
        }
        avatarDraft = prepared.dataURL
        saved = false
        model.errorMessage = nil
    }

    private func save() async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        saved = await model.updateProfile(
            displayName: displayName,
            avatarUrl: avatarDraft == model.account?.avatarUrl ? nil : avatarDraft
        )
    }
}

private struct ProviderAuthenticationView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        List {
            Section {
                HStack(spacing: 11) {
                    Image(systemName: model.providerAuthSnapshots.isEmpty ? "key" : "checkmark.shield.fill")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(model.providerAuthSnapshots.isEmpty ? Color.secondary : Color.green)
                        .frame(width: 32, height: 32)
                        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.providerAuthSnapshots.isEmpty ? "Add provider access" : "Authentication synced")
                            .font(.body.weight(.semibold))
                        Text(authenticationSummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)
            }

            Section("Providers") {
                ForEach(ProviderAuthenticationDefinition.all) { provider in
                    NavigationLink {
                        ProviderAuthenticationDetailView(provider: provider)
                    } label: {
                        ProviderAuthenticationRow(
                            provider: provider,
                            snapshot: model.authenticationSnapshot(for: provider.id)
                        )
                    }
                }
            }

            if let error = model.providerAuthenticationErrorMessage.nonEmpty {
                Section {
                    AuthenticationErrorRow(error: error) {
                        Task { await model.refreshProviderAuthentication() }
                    }
                }
            }

            Section {} footer: {
                Text("API keys are encrypted in your Kordi account and available to Cloud sessions on iPhone and Mac. Local-model access stays on your Mac.")
            }
        }
        .listStyle(.insetGrouped)
        .environment(\.defaultMinListRowHeight, 44)
        .navigationTitle("Authentication")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await model.refreshProviderAuthentication() }
                } label: {
                    if model.isRefreshingProviderAuthentication {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(model.isRefreshingProviderAuthentication)
                .accessibilityLabel("Refresh authentication")
            }
        }
        .refreshable { await model.refreshProviderAuthentication() }
        .task {
            if model.providerAuthSnapshots.isEmpty {
                await model.refreshProviderAuthentication()
            }
        }
    }

    private var authenticationSummary: String {
        let count = model.providerAuthSnapshots.count
        return count == 0 ? "Choose a provider below to connect it." : "\(count) \(count == 1 ? "provider" : "providers") available across your Kordi account."
    }
}

private struct ProviderAuthenticationRow: View {
    let provider: ProviderAuthenticationDefinition
    let snapshot: CloudProviderAuthSnapshot?

    var body: some View {
        HStack(spacing: 11) {
            ProviderAuthenticationIcon(provider: provider, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.name)
                    .font(.body.weight(.medium))
                Text(snapshot == nil ? provider.subtitle : savedAccessLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if snapshot != nil {
                Circle()
                    .fill(.green)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel("Connected")
            }
        }
        .padding(.vertical, 1)
    }

    private var savedAccessLabel: String {
        guard let snapshot else { return provider.subtitle }
        let choice = snapshot.authChoice.lowercased()
        if choice.contains("oauth") { return "Subscription account" }
        if choice.contains("api") || choice.contains("key") { return "API key" }
        return "Saved access"
    }
}

private struct ProviderAuthenticationIcon: View {
    let provider: ProviderAuthenticationDefinition
    let size: CGFloat

    var body: some View {
        Image(systemName: provider.systemImage)
            .font(.body.weight(.semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }

    private var tint: Color {
        switch provider.id {
        case "openai": .teal
        case "anthropic": .brown
        case "github-copilot": .indigo
        case "google": .blue
        case "groq": .purple
        case "openrouter": .cyan
        case "xai": .primary
        default: .orange
        }
    }
}

private struct ProviderAuthenticationDetailView: View {
    @EnvironmentObject private var model: AppModel
    let provider: ProviderAuthenticationDefinition

    @State private var apiKey = ""
    @State private var isSaving = false
    @State private var saved = false
    @State private var showRemoveConfirmation = false
    @FocusState private var apiKeyFocused: Bool

    private var snapshot: CloudProviderAuthSnapshot? {
        model.authenticationSnapshot(for: provider.id)
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 11) {
                    ProviderAuthenticationIcon(provider: provider, size: 40)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(provider.name)
                            .font(.body.weight(.semibold))
                        Text(provider.subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding(.vertical, 2)
            }

            if let snapshot {
                Section("Current access") {
                    HStack(spacing: 11) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Connected")
                                .font(.body.weight(.medium))
                            HStack(spacing: 4) {
                                Text(methodLabel(snapshot.authChoice))
                                if let date = ISO8601DateFormatter().date(from: snapshot.createdAt) {
                                    Text("·")
                                    Text(date.formatted(date: .abbreviated, time: .omitted))
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        Text("Synced")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }

            if provider.acceptsAPIKeyOnPhone {
                Section {
                    HStack(spacing: 10) {
                        Image(systemName: "key")
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                            .accessibilityHidden(true)
                        SecureField("Paste API key", text: $apiKey)
                            .textContentType(.password)
                            .keyboardType(.asciiCapable)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .privacySensitive()
                            .focused($apiKeyFocused)
                    }

                    Button {
                        Task { await saveAPIKey() }
                    } label: {
                        HStack(spacing: 8) {
                            if isSaving { ProgressView().controlSize(.small) }
                            Text(apiKeyActionTitle)
                        }
                        .frame(maxWidth: .infinity, alignment: .center)
                    }
                    .disabled(isSaving || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: {
                    Text(snapshot == nil ? "Connect with API key" : "Change access")
                } footer: {
                    Text("Encrypted in your Kordi account and available to Cloud sessions on iPhone and Mac. The key is cleared from this screen after saving.")
                }
            } else {
                Section {
                    HStack(alignment: .top, spacing: 11) {
                        Image(systemName: "macbook")
                            .foregroundStyle(.secondary)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(macRuntimeTitle)
                                .font(.body.weight(.medium))
                            Text(macRuntimeDetail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Mac runtime")
                }
            }

            if let error = model.providerAuthenticationErrorMessage.nonEmpty {
                Section {
                    AuthenticationErrorRow(error: error) {
                        Task { await model.refreshProviderAuthentication() }
                    }
                }
            }

            if snapshot != nil {
                Section("Advanced") {
                    Button("Remove saved access", role: .destructive) {
                        showRemoveConfirmation = true
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .environment(\.defaultMinListRowHeight, 44)
        .navigationTitle(provider.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await model.refreshProviderAuthentication() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(model.isRefreshingProviderAuthentication)
                .accessibilityLabel("Refresh authentication")
            }
        }
        .onAppear { model.clearProviderAuthenticationError() }
        .confirmationDialog(
            "Remove \(provider.name) access?",
            isPresented: $showRemoveConfirmation,
            titleVisibility: .visible
        ) {
            Button("Remove saved access", role: .destructive) {
                guard let snapshot else { return }
                Task { _ = await model.revokeProviderAuthentication(snapshot) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Cloud sessions using this saved access may stop until another profile is available.")
        }
    }

    private func saveAPIKey() async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        saved = await model.saveProviderAPIKey(provider: provider, apiKey: apiKey)
        if saved {
            apiKey = ""
            apiKeyFocused = false
        }
    }

    private var apiKeyActionTitle: String {
        if isSaving { return "Saving…" }
        if saved { return "Saved" }
        return snapshot == nil ? "Save API key" : "Replace with this API key"
    }

    private func methodLabel(_ authChoice: String) -> String {
        let normalized = authChoice.lowercased()
        if normalized.contains("oauth") { return "Subscription account" }
        if normalized.contains("api") || normalized.contains("key") { return "API key" }
        return authChoice.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private var macRuntimeTitle: String {
        switch provider.id {
        case "github-copilot": "Sign in with GitHub on your Mac"
        case "lm-studio", "ollama": "Connect the local runtime on your Mac"
        default: "Managed by Kordi on your Mac"
        }
    }

    private var macRuntimeDetail: String {
        switch provider.id {
        case "github-copilot":
            "Copilot uses an interactive GitHub subscription login. Open Settings → Authentication on your Mac, then refresh this page to see its Cloud access status."
        case "lm-studio", "ollama":
            "This provider runs on your Mac's local network and cannot run directly on iPhone or Kordi Cloud. Configure it in Settings → Authentication on your Mac."
        default:
            "Open Settings → Authentication on your Mac to add or switch this access, then refresh this page."
        }
    }
}

private struct AuthenticationErrorRow: View {
    let error: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                Button("Try again", action: retry)
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 32)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }
}

private struct AppearanceSettingsView: View {
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var selectedAppearance: AppAppearance {
        AppAppearance(rawValue: appearanceRawValue) ?? .system
    }

    private var columns: [GridItem] {
        if dynamicTypeSize.isAccessibilitySize {
            return [GridItem(.flexible())]
        }
        return Array(repeating: GridItem(.flexible(), spacing: 12), count: 3)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Choose how Kordi looks on this iPhone.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                LazyVGrid(columns: columns, spacing: 12) {
                ForEach(AppAppearance.allCases) { appearance in
                        AppearanceOptionButton(
                            appearance: appearance,
                            isSelected: appearance == selectedAppearance,
                            usesWideLayout: dynamicTypeSize.isAccessibilitySize
                        ) {
                            UISelectionFeedbackGenerator().selectionChanged()
                            withAnimation(.easeOut(duration: 0.18)) {
                                appearanceRawValue = appearance.rawValue
                            }
                        }
                    }
                }

                Label(selectedAppearance.detail, systemImage: selectedAppearance.systemImage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                    .contentTransition(.opacity)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 20)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .preferredColorScheme(preferredColorScheme)
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var preferredColorScheme: ColorScheme? {
        switch selectedAppearance {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

private struct AppearanceOptionButton: View {
    let appearance: AppAppearance
    let isSelected: Bool
    let usesWideLayout: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if usesWideLayout {
                    HStack(spacing: 14) {
                        AppearancePreviewThumbnail(appearance: appearance)
                            .frame(width: 112, height: 80)
                        selectionLabel
                    }
                } else {
                    VStack(spacing: 10) {
                        AppearancePreviewThumbnail(appearance: appearance)
                            .aspectRatio(4 / 3, contentMode: .fit)
                        selectionLabel
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isSelected
                    ? KordiTheme.signalBlue.opacity(0.09)
                    : Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(
                        isSelected ? KordiTheme.signalBlue : Color(uiColor: .separator).opacity(0.45),
                        lineWidth: isSelected ? 2 : 0.5
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(appearance.label) appearance")
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    private var selectionLabel: some View {
        HStack(spacing: 6) {
            Text(appearance.label)
                .font(.subheadline.weight(isSelected ? .semibold : .medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 0)
            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(KordiTheme.signalBlue)
                    .accessibilityHidden(true)
            }
        }
    }
}

private struct AppearancePreviewThumbnail: View {
    @Environment(\.colorScheme) private var systemColorScheme
    let appearance: AppAppearance

    var body: some View {
        AppearancePreviewCanvas()
            .environment(\.colorScheme, previewColorScheme)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color(uiColor: .separator).opacity(0.55), lineWidth: 0.5)
            }
            .overlay(alignment: .bottomTrailing) {
                if appearance == .system {
                    Image(systemName: "circle.lefthalf.filled")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.primary)
                        .padding(5)
                        .background(.thinMaterial, in: Circle())
                        .padding(5)
                        .accessibilityHidden(true)
                }
            }
    }

    private var previewColorScheme: ColorScheme {
        switch appearance {
        case .system: systemColorScheme
        case .light: .light
        case .dark: .dark
        }
    }
}

private struct AppearancePreviewCanvas: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 5) {
                Circle()
                    .fill(Color(uiColor: .systemGray4))
                    .frame(width: 12, height: 12)
                Spacer(minLength: 0)
                HStack(spacing: 2) {
                    ForEach(0..<3, id: \.self) { index in
                        Circle()
                            .fill(markColors[index])
                            .frame(width: 4, height: 4)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "plus")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(.primary)
            }

            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(Color(uiColor: .tertiarySystemFill))
                .frame(height: 9)

            conversationRow(accent: KordiTheme.brandCyan, primaryWidth: 29, secondaryWidth: 38)
            conversationRow(accent: KordiTheme.agentViolet, primaryWidth: 35, secondaryWidth: 27)
        }
        .padding(8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }

    private var markColors: [Color] {
        if colorScheme == .dark {
            return [Color(uiColor: .systemGray), Color(uiColor: .systemGray3), .white]
        }
        return [KordiTheme.brandPink, KordiTheme.brandCyan, KordiTheme.brandAmber]
    }

    private func conversationRow(
        accent: Color,
        primaryWidth: CGFloat,
        secondaryWidth: CGFloat
    ) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(accent.opacity(0.78))
                .frame(width: 12, height: 12)
            VStack(alignment: .leading, spacing: 3) {
                Capsule()
                    .fill(Color.primary.opacity(0.68))
                    .frame(width: primaryWidth, height: 3)
                Capsule()
                    .fill(Color.secondary.opacity(0.42))
                    .frame(width: secondaryWidth, height: 3)
            }
            Spacer(minLength: 0)
        }
    }
}

private extension AppAppearance {
    var detail: String {
        switch self {
        case .system: "Matches your iPhone appearance automatically."
        case .light: "Keeps Kordi light in every environment."
        case .dark: "Keeps Kordi dark in every environment."
        }
    }
}

#Preview("Account settings") {
    AccountSheet()
        .environmentObject(AppModel(previewMode: true))
        .tint(KordiTheme.signalBlue)
}

struct AccountAuthenticationPreview: View {
    var body: some View {
        NavigationStack {
            ProviderAuthenticationView()
        }
    }
}

struct AccountAuthenticationDetailPreview: View {
    let providerID: String

    var body: some View {
        NavigationStack {
            if let provider = ProviderAuthenticationDefinition.all.first(where: { $0.id == providerID }) {
                ProviderAuthenticationDetailView(provider: provider)
            }
        }
        .tint(KordiTheme.signalBlue)
    }
}

struct AppearanceSettingsPreview: View {
    var body: some View {
        NavigationStack {
            AppearanceSettingsView()
        }
        .tint(KordiTheme.signalBlue)
    }
}

struct ProfileSettingsPreview: View {
    var body: some View {
        NavigationStack {
            ProfileSettingsView()
        }
        .tint(KordiTheme.signalBlue)
    }
}
