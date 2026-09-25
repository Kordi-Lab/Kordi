import PhotosUI
import SwiftUI
import UIKit

private enum AccountSettingsRoute: Hashable {
    case profile
    case activeSessions
    case authentication
    case notifications
    case appearance
}

struct AccountSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue
    @State private var path: [AccountSettingsRoute]
    private let embeddedInNavigationStack: Bool

    init(embeddedInNavigationStack: Bool = false) {
        _path = State(initialValue: [])
        self.embeddedInNavigationStack = embeddedInNavigationStack
    }

    init(openingAuthentication: Bool) {
        _path = State(initialValue: openingAuthentication ? [.authentication] : [])
        embeddedInNavigationStack = false
    }

    fileprivate init(previewing route: AccountSettingsRoute) {
        _path = State(initialValue: [route])
        embeddedInNavigationStack = false
    }

    @ViewBuilder
    var body: some View {
        if embeddedInNavigationStack {
            settingsContent
                .preferredColorScheme(preferredColorScheme)
        } else {
            NavigationStack(path: $path) {
                settingsContent
            }
            .preferredColorScheme(preferredColorScheme)
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            // Start chat opens the conversation behind this sheet.
            .onChange(of: model.startedAgentChatRevision) { _, _ in dismiss() }
        }
    }

    private var settingsContent: some View {
        List {
            Section {
                accountHeader
            }

            Section {
                NavigationLink(value: AccountSettingsRoute.profile) {
                    SettingsNavigationLabel(title: "Profile", systemImage: "person")
                }

                NavigationLink(value: AccountSettingsRoute.activeSessions) {
                    HStack {
                        SettingsNavigationLabel(title: "Active sessions", systemImage: "iphone.and.arrow.forward")
                        Spacer(minLength: 8)
                        if model.deviceReviewRequired {
                            Text("Review")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.orange)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(.orange.opacity(0.12), in: Capsule())
                                .accessibilityLabel("New device needs review")
                        }
                    }
                }

                NavigationLink(value: AccountSettingsRoute.authentication) {
                    HStack {
                        SettingsNavigationLabel(title: "Authentication", systemImage: "key")
                        Spacer(minLength: 8)
                        if !model.providerAuthProfiles.isEmpty {
                            let count = model.providerAuthProfiles.count
                            Text("\(count) \(count == 1 ? "account" : "accounts")")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityIdentifier("settings-authentication")

                NavigationLink(value: AccountSettingsRoute.notifications) {
                    SettingsNavigationLabel(title: "Notifications", systemImage: "bell")
                }

                NavigationLink(value: AccountSettingsRoute.appearance) {
                    SettingsNavigationLabel(title: "Appearance", systemImage: "paintpalette")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: AccountSettingsRoute.self) { route in
            switch route {
            case .profile:
                ProfileSettingsView()
            case .activeSessions:
                DevicesSettingsView()
            case .authentication:
                ProviderAuthenticationView()
            case .notifications:
                NotificationSettingsView()
            case .appearance:
                AppearanceSettingsView()
            }
        }
        .toolbar {
            if !embeddedInNavigationStack {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
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
                imageSource: model.account?.avatar.imageSource,
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

private struct NotificationSettingsView: View {
    @EnvironmentObject private var coordinator: KordiNotificationCoordinator

    var body: some View {
        List {
            Section {
                HStack {
                    Label("System permission", systemImage: "bell.badge")
                    Spacer()
                    Text(permissionLabel)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if coordinator.authorizationState == .notDetermined {
                    Button("Enable notifications") {
                        Task { await coordinator.requestAuthorization() }
                    }
                } else if coordinator.authorizationState == .denied {
                    Button("Open iPhone Settings") {
                        coordinator.openSystemSettings()
                    }
                }
            } footer: {
                Text("iOS controls whether Kordi can show notifications. Kordi controls which message details are included.")
            }

            Section("Messages") {
                Toggle("Message notifications", isOn: preferenceBinding(.messages))
                Toggle("Notification sound", isOn: preferenceBinding(.sound))
                    .disabled(!coordinator.messagesEnabled)
                Toggle("Message previews", isOn: preferenceBinding(.previews))
                    .disabled(!coordinator.messagesEnabled)
                Toggle("App icon badge", isOn: preferenceBinding(.badge))
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await coordinator.refreshAuthorizationState()
        }
    }

    private var permissionLabel: String {
        switch coordinator.authorizationState {
        case .notDetermined: "Not requested"
        case .denied: "Off"
        case .authorized: "On"
        case .provisional: "Provisional"
        case .ephemeral: "Temporary"
        }
    }

    private func preferenceBinding(_ preference: KordiMessageNotificationPreference) -> Binding<Bool> {
        Binding(
            get: {
                switch preference {
                case .messages: coordinator.messagesEnabled
                case .sound: coordinator.soundEnabled
                case .previews: coordinator.previewsEnabled
                case .badge: coordinator.badgeEnabled
                }
            },
            set: { coordinator.setPreference(preference, enabled: $0) }
        )
    }
}

struct ActiveSessionsPreview: View {
    var body: some View {
        AccountSheet(previewing: .activeSessions)
    }
}

private struct DevicesSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var renameTarget: CloudDeviceAuthorization?
    @State private var renameDraft = ""
    @State private var revokeTarget: CloudDeviceAuthorization?
    @State private var showRevokeOthers = false
    @State private var isMutating = false

    private var currentDevice: CloudDeviceAuthorization? {
        model.devices.first(where: \.currentDevice)
    }

    private var otherDevices: [CloudDeviceAuthorization] {
        model.devices.filter { !$0.currentDevice }
    }

    @ViewBuilder
    private var deviceSections: some View {
        if let currentDevice {
            currentDeviceSection(currentDevice)
        } else {
            Section {
                Label(
                    "Kordi could not identify this iPhone in the active session list. Refresh before terminating another session.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .foregroundStyle(.orange)
            }
        }
        activeDevicesSection
    }

    private func currentDeviceSection(_ device: CloudDeviceAuthorization) -> some View {
        Section {
            DeviceAuthorizationRow(
                device: device,
                isMutating: isMutating,
                confirm: {},
                requestRevoke: {}
            )

            if !otherDevices.isEmpty {
                Button(role: .destructive) {
                    showRevokeOthers = true
                } label: {
                    Label("Terminate all other sessions", systemImage: "hand.raised")
                        .frame(minHeight: 32)
                }
                .disabled(isMutating)
            }
        } header: {
            HStack {
                Text("This device")
                Spacer()
                Button("Rename") {
                    renameDraft = device.displayTitle
                    renameTarget = device
                }
                .font(.caption.weight(.semibold))
                .textCase(nil)
                .disabled(isMutating)
            }
        } footer: {
            if otherDevices.isEmpty {
                Text("No other active sessions are connected to this account.")
            } else {
                Text("Terminates every other Kordi session except this one. Files already saved on those devices are not erased.")
            }
        }
    }

    private var activeDevicesSection: some View {
        Section {
            if otherDevices.isEmpty {
                Text("Your other devices will appear here after they sign in.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(otherDevices) { device in
                    DeviceAuthorizationRow(
                        device: device,
                        isMutating: isMutating,
                        confirm: {
                            isMutating = true
                            Task {
                                _ = await model.confirmDevice(device)
                                isMutating = false
                            }
                        },
                        requestRevoke: { revokeTarget = device }
                    )
                }
            }
        } header: {
            Text("Active devices")
        }
    }

    var body: some View {
        List {
            if model.isRefreshingDevices && model.devices.isEmpty {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading active sessions…")
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 44)
                    .accessibilityElement(children: .combine)
                }
            } else if model.devices.isEmpty {
                Section {
                    ContentUnavailableView(
                        "No active sessions",
                        systemImage: "laptopcomputer.and.iphone",
                        description: Text("Refresh the list, or sign in again if this iPhone is missing.")
                    )
                }
            } else {
                deviceSections
            }

            if let error = model.deviceErrorMessage.nonEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(error, systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(.red)
                        if !model.devices.isEmpty {
                            Text("The saved list remains visible. Reconnect and refresh to verify changes.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Button("Try again") { Task { await model.refreshDevices() } }
                            .font(.subheadline.weight(.semibold))
                            .frame(minHeight: 32)
                    }
                }
            }

        }
        .listStyle(.insetGrouped)
        .environment(\.defaultMinListRowHeight, 44)
        .navigationTitle("Active sessions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await model.refreshDevices() }
                } label: {
                    if model.isRefreshingDevices {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(model.isRefreshingDevices || isMutating)
                .accessibilityLabel("Refresh active sessions")
            }
        }
        .refreshable { await model.refreshDevices() }
        .task {
            model.markDeviceReviewSeen()
            await model.refreshDevices()
        }
        .alert(
            "Rename this device",
            isPresented: Binding(
                get: { renameTarget != nil },
                set: { if !$0 { renameTarget = nil } }
            )
        ) {
            TextField("Device name", text: $renameDraft)
            Button("Save") {
                guard let device = renameTarget else { return }
                isMutating = true
                Task {
                    _ = await model.renameDevice(device, displayName: renameDraft)
                    isMutating = false
                    renameTarget = nil
                }
            }
            .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) { renameTarget = nil }
        } message: {
            Text("Use a name that helps you recognize this session in Kordi.")
        }
        .confirmationDialog(
            "Terminate this device?",
            isPresented: Binding(
                get: { revokeTarget != nil },
                set: { if !$0 { revokeTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: revokeTarget
        ) { device in
            Button("Terminate \(device.displayTitle)", role: .destructive) {
                isMutating = true
                Task {
                    _ = await model.revokeDevice(device)
                    isMutating = false
                    revokeTarget = nil
                }
            }
            Button("Cancel", role: .cancel) { revokeTarget = nil }
        } message: { _ in
            Text("Every Kordi Cloud session on this device will be revoked. Local files on it will not be erased.")
        }
        .confirmationDialog(
            "Terminate all other sessions?",
            isPresented: $showRevokeOthers,
            titleVisibility: .visible
        ) {
            Button("Terminate all other sessions", role: .destructive) {
                isMutating = true
                Task {
                    _ = await model.revokeOtherDevices()
                    isMutating = false
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every other Kordi Cloud authorization and session will be revoked. This iPhone stays signed in.")
        }
    }
}

private struct DeviceAuthorizationRow: View {
    let device: CloudDeviceAuthorization
    let isMutating: Bool
    let confirm: () -> Void
    let requestRevoke: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 11) {
                ZStack {
                    Circle()
                        .fill((device.needsReview ? Color.orange : KordiTheme.signalBlue).opacity(0.12))
                    Image(systemName: device.needsReview ? "exclamationmark.shield.fill" : device.systemImage)
                        .foregroundStyle(device.needsReview ? Color.orange : KordiTheme.signalBlue)
                }
                .frame(width: 38, height: 38)
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(device.displayTitle)
                        .font(.body.weight(.semibold))
                    if let detailLine = device.detailLine {
                        Text(detailLine)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let activityLine = device.activityLine {
                        Text(activityLine)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if !device.currentDevice {
                    VStack(alignment: .trailing, spacing: 2) {
                        if device.needsReview {
                            Text("Needs review")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.orange)
                        }
                        Button(role: .destructive, action: requestRevoke) {
                            Image(systemName: "xmark")
                                .font(.caption.weight(.semibold))
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isMutating)
                        .accessibilityLabel("Terminate \(device.displayTitle)")
                    }
                }
            }

            if !device.currentDevice && device.needsReview {
                Button("This was me", action: confirm)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(isMutating)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }
}

private extension CloudDeviceAuthorization {
    var displayTitle: String {
        displayName?.nonEmpty ?? (platform == "ios" ? "iPhone" : platform == "macos" ? "Mac" : "Kordi device")
    }

    var systemImage: String { platform == "ios" ? "iphone" : "laptopcomputer" }

    var detailLine: String? {
        [platform?.uppercased(), osVersion?.nonEmpty, appVersion.nonEmpty.map { "Kordi \($0)" }]
            .compactMap { $0 }
            .joined(separator: " · ")
            .nonEmpty
    }

    var activityLine: String? {
        let lastActive = DeviceDateFormatting.iso8601.date(from: lastActiveAt)
            .map { "Active \($0.formatted(.relative(presentation: .named)))" }
        return [approximateLocation.nonEmpty, lastActive]
            .compactMap { $0 }
            .joined(separator: " · ")
            .nonEmpty
    }
}

private enum DeviceDateFormatting {
    static let iso8601 = ISO8601DateFormatter()
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
    @EnvironmentObject private var callCoordinator: KordiCallCoordinator
    @State private var displayName = ""
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var avatarDraft: String?
    @State private var avatarMutation: CanonicalAvatarMutation?
    @State private var isSaving = false
    @State private var didLoad = false
    @State private var saved = false
    @State private var copiedKordiID = false

    var body: some View {
        Form {
            Section {
                VStack(spacing: 16) {
                    VStack(spacing: 8) {
                        IdentityAvatar(
                            name: displayName.nonEmpty ?? model.account?.preferredName ?? "Me",
                            imageSource: avatarDraft?.nonEmpty ?? model.account?.avatar.imageSource,
                            kind: .person,
                            size: 88,
                            seed: model.account?.accountId
                        )

                        AvatarActionPill(
                            selectedPhoto: $selectedPhoto,
                            disabled: isSaving,
                            onRandomize: updateGeneratedAvatarPreview,
                            randomLabel: "Random profile avatar",
                            uploadLabel: "Upload profile avatar"
                        )
                    }

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
                    Task {
                        await callCoordinator.prepareForAccountTeardown()
                        await model.signOut()
                    }
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
        avatarDraft = model.account?.avatar.imageSource
        avatarMutation = nil
        model.errorMessage = nil
    }

    private func loadAvatar(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self),
              let prepared = SignupAvatarRenderer.uploadedImage(from: data) else {
            model.errorMessage = "Choose a supported photo up to 2 MiB."
            return
        }
        avatarDraft = prepared.dataURL
        avatarMutation = .upload(
            prepared.dataURL,
            expectedVersion: model.account?.avatar.version
        )
        saved = false
        model.errorMessage = nil
    }

    private func save() async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        saved = await model.updateProfile(
            displayName: displayName,
            avatarMutation: avatarMutation
        )
        if saved { avatarMutation = nil }
    }

    private func updateGeneratedAvatarPreview() {
        guard let account = model.account else { return }
        let seed = CanonicalAvatarSystem.newSeed()
        guard let previewURL = CanonicalAvatarSystem.previewURL(
            style: account.avatar.style,
            seed: seed
        ) else { return }
        avatarDraft = previewURL.absoluteString
        avatarMutation = .regenerate(
            seed: seed,
            expectedVersion: account.avatar.version
        )
        saved = false
        model.errorMessage = nil
    }
}

private struct AppearanceSettingsView: View {
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue
    @AppStorage(KordiChatTheme.storageKey) private var chatThemeRawValue = KordiChatTheme.quiet.rawValue
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var selectedAppearance: AppAppearance {
        AppAppearance(rawValue: appearanceRawValue) ?? .system
    }

    private var selectedChatTheme: KordiChatTheme {
        KordiChatTheme(rawValue: chatThemeRawValue) ?? .quiet
    }

    private var appearanceColumns: [GridItem] {
        if dynamicTypeSize.isAccessibilitySize {
            return [GridItem(.flexible())]
        }
        return Array(repeating: GridItem(.flexible(), spacing: 12), count: 3)
    }

    private var chatThemeColumns: [GridItem] {
        if dynamicTypeSize.isAccessibilitySize {
            return [GridItem(.flexible())]
        }
        return Array(repeating: GridItem(.flexible(), spacing: 12), count: 2)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Choose how Kordi looks on this iPhone.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Text("App appearance")
                    .font(.headline)

                LazyVGrid(columns: appearanceColumns, spacing: 12) {
                    ForEach(AppAppearance.allCases) { appearance in
                        AppearanceOptionButton(
                            appearance: appearance,
                            isSelected: appearance == selectedAppearance,
                            usesWideLayout: dynamicTypeSize.isAccessibilitySize
                        ) {
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
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

                Divider()

                VStack(alignment: .leading, spacing: 5) {
                    Text("Chat theme")
                        .font(.headline)
                    Text("Changes conversation backgrounds and message colors on this iPhone.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                LazyVGrid(columns: chatThemeColumns, spacing: 12) {
                    ForEach(KordiChatTheme.allCases) { theme in
                        ChatThemeOptionButton(
                            theme: theme,
                            isSelected: theme == selectedChatTheme,
                            usesWideLayout: dynamicTypeSize.isAccessibilitySize
                        ) {
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                                chatThemeRawValue = theme.rawValue
                            }
                        }
                    }
                }

                Label(selectedChatTheme.detail, systemImage: selectedChatTheme.systemImage)
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
        .sensoryFeedback(.selection, trigger: appearanceRawValue + ":" + chatThemeRawValue)
    }

    private var preferredColorScheme: ColorScheme? {
        switch selectedAppearance {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

private struct ChatThemeOptionButton: View {
    let theme: KordiChatTheme
    let isSelected: Bool
    let usesWideLayout: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if usesWideLayout {
                    HStack(spacing: 14) {
                        ChatThemePreviewThumbnail(theme: theme)
                            .frame(width: 112, height: 80)
                        selectionLabel
                    }
                } else {
                    VStack(spacing: 10) {
                        ChatThemePreviewThumbnail(theme: theme)
                            .aspectRatio(4 / 3, contentMode: .fit)
                        selectionLabel
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isSelected
                    ? theme.accent.opacity(0.09)
                    : Color(uiColor: .secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(
                        isSelected ? theme.accent : Color(uiColor: .separator).opacity(0.45),
                        lineWidth: isSelected ? 2 : 0.5
                    )
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(theme.label) chat theme")
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    private var selectionLabel: some View {
        HStack(spacing: 6) {
            Text(theme.label)
                .font(.subheadline.weight(isSelected ? .semibold : .medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 0)
            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(theme.accent)
                    .accessibilityHidden(true)
            }
        }
    }
}

private struct ChatThemePreviewThumbnail: View {
    let theme: KordiChatTheme

    var body: some View {
        KordiChatWallpaper(theme: theme)
            .overlay {
                VStack(spacing: 7) {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(KordiTheme.agentViolet)
                            .frame(width: 12, height: 12)
                        Capsule()
                            .fill(theme.peerText.opacity(0.45))
                            .frame(width: 34, height: 4)
                        Spacer(minLength: 0)
                    }
                    HStack {
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(theme.peerBubble)
                            .frame(width: 44, height: 13)
                        Spacer(minLength: 0)
                    }
                    HStack {
                        Spacer(minLength: 0)
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(theme.ownBubble)
                            .frame(width: 58, height: 13)
                    }
                }
                .padding(8)
            }
            .compositingGroup()
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color(uiColor: .separator).opacity(0.55), lineWidth: 0.5)
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
        .environmentObject(KordiCallCoordinator())
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
    @EnvironmentObject private var model: AppModel
    let providerID: String

    var body: some View {
        NavigationStack {
            if let provider = PreviewLoginSteps.definition(for: providerID, in: model.authenticationProviderDefinitions) {
                ProviderAuthenticationDetailView(provider: provider)
                    .navigationDestination(item: $model.startedAgentChat) { chat in
                        ConversationView(conversation: chat)
                    }
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
