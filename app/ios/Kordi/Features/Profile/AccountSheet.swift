import SwiftUI
import UIKit

enum AccountSettingsRoute: String, Hashable {
    case profile
    case activeSessions = "active-sessions"
    case authentication
    case notifications
    case connectors
    case memory
    case appearance
}

struct AccountSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue
    @State private var path: [AccountSettingsRoute]
    // Sample connectors for the debug preview argument; nil otherwise.
    @State private var previewConnectorsClient: (any ConnectorsClient)? = ConnectorsAvailability.makeClient()
    private let embeddedInNavigationStack: Bool
    private var connectorsRequest: ConnectorsSettingsRequest?

    init(embeddedInNavigationStack: Bool = false) {
        _path = State(initialValue: [])
        self.embeddedInNavigationStack = embeddedInNavigationStack
    }

    init(openingAuthentication: Bool) {
        _path = State(initialValue: openingAuthentication ? [.authentication] : [])
        embeddedInNavigationStack = false
    }

    /// Opens on Connectors for a settings link; a later request navigates within the open sheet.
    init(connectorsRequest: ConnectorsSettingsRequest?) {
        _path = State(initialValue: connectorsRequest?.path ?? [])
        embeddedInNavigationStack = false
        self.connectorsRequest = connectorsRequest
    }

    fileprivate init(previewing route: AccountSettingsRoute) {
        _path = State(initialValue: [route])
        embeddedInNavigationStack = false
    }

    // Present only when the server reports connectors or the preview argument is set.
    private var connectorsClient: (any ConnectorsClient)? {
        previewConnectorsClient ?? ConnectorsAvailability.makeClient(
            arguments: [],
            connectorsVersion: model.connectorsVersion,
            cloudClient: model.cloudConnectorsClient
        )
    }

    @ViewBuilder
    var body: some View {
        if embeddedInNavigationStack {
            settingsContent
                .preferredColorScheme(preferredColorScheme)
                .task { await model.refreshConnectorsCapabilityIfNeeded() }
        } else {
            NavigationStack(path: $path) {
                settingsContent
            }
            .task { await model.refreshConnectorsCapabilityIfNeeded() }
            .preferredColorScheme(preferredColorScheme)
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            // Start chat opens the conversation behind this sheet.
            .onChange(of: model.startedAgentChatRevision) { _, _ in dismiss() }
            .onChange(of: connectorsRequest) { _, request in
                if let request { path = request.path }
            }
        }
    }

    private var settingsContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                settingsLink(.profile) { accountHeader }
                SettingsDivider()

                SettingsSectionTitle("Notifications")
                settingsLink(.notifications) {
                    CompactSettingsLabel(title: "Notifications", subtitle: "Messages, sounds, and previews", systemImage: "bell")
                }
                SettingsDivider()

                if connectorsClient != nil {
                    SettingsSectionTitle("Connectors")
                    settingsLink(.connectors) {
                        CompactSettingsLabel(title: "Connectors", subtitle: "Services and sources your agent can use", systemImage: "app.connected.to.app.below.fill")
                    }
                    SettingsDivider()
                }

                if model.isMemoryAvailable {
                    SettingsSectionTitle("Memory")
                    settingsLink(.memory) {
                        CompactSettingsLabel(title: "Memory", subtitle: "What Kordi remembers across devices", systemImage: "brain")
                    }
                    SettingsDivider()
                }

                SettingsSectionTitle("Appearance")
                settingsLink(.appearance) {
                    CompactSettingsLabel(title: "Appearance", systemImage: "paintbrush")
                }
                SettingsDivider()

                SettingsSectionTitle("Account")
                settingsLink(.activeSessions) {
                    HStack {
                        CompactSettingsLabel(title: "Active sessions", subtitle: "Manage your connected devices", systemImage: "iphone.and.arrow.forward")
                        Spacer(minLength: 8)
                        if model.deviceReviewRequired {
                            Text("Review")
                                .font(SettingsFont.badge)
                                .foregroundStyle(.orange)
                                .accessibilityLabel("New device needs review")
                        }
                    }
                }
                settingsLink(.authentication) {
                    HStack {
                        CompactSettingsLabel(title: "Authentication", subtitle: "Connected AI provider accounts", systemImage: "key")
                        Spacer(minLength: 8)
                        if !model.providerAuthProfiles.isEmpty {
                            Text("\(model.providerAuthProfiles.count)")
                                .font(SettingsFont.subtitle)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityIdentifier("settings-authentication")
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(Color(uiColor: .systemBackground))
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
            case .connectors:
                if let connectorsClient {
                    ConnectorsSettingsView(
                        client: connectorsClient,
                        isPreview: connectorsClient is PreviewConnectorsClient,
                        request: connectorsRequest
                    )
                }
            case .memory:
                MemorySettingsView(appModel: model)
            case .appearance:
                AppearanceSettingsView()
            }
        }
        .task { await model.refreshMemoryCapabilities() }
        .toolbar {
            if !embeddedInNavigationStack {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                        .tint(.primary)
                }
            }
        }
    }

    private var preferredColorScheme: ColorScheme? {
        AppearanceSettingsSelection.preferredColorScheme(appearanceRawValue)
    }

    private var accountHeader: some View {
        HStack(spacing: 12) {
            IdentityAvatar(
                name: model.account?.preferredName ?? "Me",
                imageSource: model.account?.avatar.imageSource,
                kind: .person,
                size: 40,
                seed: model.account?.accountId
            )
            VStack(alignment: .leading, spacing: 3) {
                Text(model.account?.preferredName ?? "Kordi account")
                    .font(SettingsFont.headerTitle)
                if let email = model.account?.primaryEmail.nonEmpty {
                    Text(email)
                        .font(SettingsFont.subtitle)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private func settingsLink<Content: View>(_ route: AccountSettingsRoute, @ViewBuilder content: () -> Content) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: 10) {
                content()
                Spacer(minLength: 0)
                SettingsChevron()
            }
            .frame(minHeight: SettingsMetrics.rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings-\(route.rawValue)")
    }
}

private struct NotificationSettingsView: View {
    @EnvironmentObject private var coordinator: KordiNotificationCoordinator

    var body: some View {
        SettingsPage {
            SettingsRow {
                CompactSettingsLabel(title: "System permission", systemImage: "bell.badge", value: permissionLabel)
            }

            if coordinator.authorizationState == .notDetermined {
                actionRow("Enable notifications") {
                    Task { await coordinator.requestAuthorization() }
                }
            } else if coordinator.authorizationState == .denied {
                actionRow("Open iPhone Settings") {
                    coordinator.openSystemSettings()
                }
            }
            SettingsCaption("iOS controls whether Kordi can show notifications. Kordi controls which message details are included.")

            SettingsDivider()
            SettingsSectionTitle("Messages")
            preferenceToggle("Message notifications", .messages)
            preferenceToggle("Notification sound", .sound)
                .disabled(!coordinator.messagesEnabled)
            preferenceToggle("Message previews", .previews)
                .disabled(!coordinator.messagesEnabled)
            preferenceToggle("App icon badge", .badge)
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await coordinator.refreshAuthorizationState()
        }
    }

    private func actionRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(SettingsFont.action)
                .frame(maxWidth: .infinity, minHeight: SettingsMetrics.textRowMinHeight, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.tint)
    }

    private func preferenceToggle(_ title: String, _ preference: KordiMessageNotificationPreference) -> some View {
        Toggle(isOn: preferenceBinding(preference)) {
            CompactSettingsLabel(title: title, systemImage: nil)
        }
        .frame(minHeight: SettingsMetrics.rowMinHeight)
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

/// Settings opened on Connectors, for `--preview-connectors`.
struct ConnectorsSettingsPreview: View {
    var body: some View {
        AccountSheet(previewing: .connectors)
    }
}

private enum DeviceLogoutRequest: Identifiable {
    case single(CloudDeviceAuthorization)
    case allOthers

    var id: String {
        switch self {
        case .single(let device): "single:\(device.deviceId)"
        case .allOthers: "all-others"
        }
    }

    var title: String {
        switch self {
        case .single(let device): "Log out of \(device.sessionTitle)?"
        case .allOthers: "Log out of all other devices?"
        }
    }

    var message: String? {
        switch self {
        case .single: nil
        case .allOthers: "Every device except this one will be signed out."
        }
    }
}

private struct DevicesSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var renameTarget: CloudDeviceAuthorization?
    @State private var renameDraft = ""
    @State private var logoutRequest: DeviceLogoutRequest?
    @State private var isMutating = false

    /// Leading inset that aligns sub-rows with the row title (icon width + spacing).
    private static let titleInset: CGFloat = SettingsMetrics.iconWidth + SettingsMetrics.iconSpacing

    @ViewBuilder
    private var deviceSections: some View {
        let list = CloudDeviceList.make(from: model.devices)
        let locked = list.actionsLocked
        if let current = list.current {
            currentDeviceSection(current)
        } else {
            Label("This iPhone is not in the list. Refresh and try again.", systemImage: "exclamationmark.triangle")
                .font(SettingsFont.rowTitle)
                .foregroundStyle(.orange)
                .frame(minHeight: SettingsMetrics.rowMinHeight, alignment: .leading)
        }
        if !locked, !list.otherDevices.isEmpty {
            destructiveRow("Log out of all other devices") { logoutRequest = .allOthers }
        }
        if !list.sameMachine.isEmpty {
            SettingsDivider()
            SettingsSectionTitle("Also on this device")
            ForEach(list.sameMachine) { device in
                otherDeviceRow(device, locked: locked)
            }
        }
        if !list.others.isEmpty {
            SettingsDivider()
            SettingsSectionTitle("Other devices")
            ForEach(list.others) { device in
                otherDeviceRow(device, locked: locked)
            }
        }
    }

    @ViewBuilder
    private func currentDeviceSection(_ device: CloudDeviceAuthorization) -> some View {
        HStack(alignment: .firstTextBaseline) {
            SettingsSectionTitle("This device")
            Spacer(minLength: 8)
            if !device.isPendingReview {
                Button("Rename") {
                    renameDraft = device.title
                    renameTarget = device
                }
                .font(SettingsFont.inlineAction)
                .foregroundStyle(.secondary)
                .disabled(isMutating)
            }
        }
        DeviceSessionRow(
            title: device.title,
            systemImage: device.deviceSystemImage,
            tag: device.isPendingReview ? "Waiting for approval" : nil,
            lines: [
                device.currentDetailLine,
                device.isPendingReview ? pendingApprovalHint(reviewEndsAt: device.reviewEndsAt) : "Active now",
            ].compactMap { $0 }
        )
    }

    private func otherDeviceRow(_ device: CloudDeviceAuthorization, locked: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 8) {
                DeviceSessionRow(
                    title: device.sessionTitle,
                    systemImage: device.deviceSystemImage,
                    tag: device.isPendingReview ? "Needs review" : nil,
                    lines: [device.metaLine].compactMap { $0 }
                )
                if !locked {
                    revokeButton(title: device.sessionTitle) { logoutRequest = .single(device) }
                }
            }
            if !locked, device.isPendingReview {
                confirmButton(device)
                    .padding(.leading, Self.titleInset)
                    .padding(.bottom, 6)
            }
        }
    }

    private func destructiveRow(_ title: String, action: @escaping () -> Void) -> some View {
        SettingsDestructiveRow(title, action: action)
            .disabled(isMutating)
    }

    private func revokeButton(title: String, action: @escaping () -> Void) -> some View {
        Button(role: .destructive, action: action) {
            Image(systemName: "xmark.circle")
                .font(.body)
                .foregroundStyle(.tertiary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isMutating)
        .accessibilityLabel("Log out \(title)")
    }

    private func confirmButton(_ device: CloudDeviceAuthorization) -> some View {
        Button("This was me") {
            isMutating = true
            Task {
                _ = await model.confirmDevice(device)
                isMutating = false
            }
        }
        .font(SettingsFont.inlineAction)
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .tint(.primary)
        .disabled(isMutating)
    }

    private func perform(_ request: DeviceLogoutRequest) {
        isMutating = true
        Task {
            switch request {
            case .single(let device):
                _ = await model.revokeDevice(device)
            case .allOthers:
                _ = await model.revokeOtherDevices()
            }
            isMutating = false
            logoutRequest = nil
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if model.isRefreshingDevices && model.devices.isEmpty {
                    SettingsLoadingRow("Loading…")
                } else if model.devices.isEmpty {
                    ContentUnavailableView("No active sessions", systemImage: "laptopcomputer.and.iphone")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                } else {
                    deviceSections
                }

                if let error = model.deviceErrorMessage.nonEmpty {
                    SettingsDivider()
                    SettingsErrorLabel(error)
                    Button("Try again") { Task { await model.refreshDevices() } }
                        .font(SettingsFont.action)
                        .frame(minHeight: SettingsMetrics.textRowMinHeight)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(Color(uiColor: .systemBackground))
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
        }
        .confirmationDialog(
            logoutRequest?.title ?? "",
            isPresented: Binding(
                get: { logoutRequest != nil },
                set: { if !$0 { logoutRequest = nil } }
            ),
            titleVisibility: .visible,
            presenting: logoutRequest
        ) { request in
            Button("Log out", role: .destructive) { perform(request) }
            Button("Cancel", role: .cancel) { logoutRequest = nil }
        } message: { request in
            if let message = request.message {
                Text(message)
            }
        }
    }
}

private struct DeviceStatusTag: View {
    let text: String

    var body: some View {
        Text(text)
            .font(SettingsFont.badge)
            .foregroundStyle(.orange)
    }
}

/// A device row in the same flat style as `CompactSettingsLabel`.
private struct DeviceSessionRow: View {
    let title: String
    let systemImage: String
    var tag: String? = nil
    /// Grey lines under the title.
    let lines: [String]

    var body: some View {
        HStack(alignment: .center, spacing: SettingsMetrics.iconSpacing) {
            Image(systemName: systemImage)
                .font(.body)
                .frame(width: SettingsMetrics.iconWidth)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title).font(SettingsFont.rowTitle)
                    if let tag {
                        DeviceStatusTag(text: tag)
                    }
                }
                ForEach(lines, id: \.self) { line in
                    Text(line)
                        .font(SettingsFont.subtitle)
                        .foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.primary)
        .padding(.vertical, 5)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .accessibilityElement(children: .combine)
    }
}

private extension CloudDeviceAuthorization {
    var deviceSystemImage: String {
        switch platform?.lowercased() {
        case "ios": "iphone"
        case "macos": "laptopcomputer"
        case "windows", "linux": "desktopcomputer"
        default: "key"
        }
    }

    var currentDetailLine: String? {
        [platformVersionLabel, appVersionLabel]
            .compactMap { $0 }
            .joined(separator: " · ")
            .nonEmpty
    }

    /// App version, location, and activity on one line.
    var metaLine: String? {
        let hasVersion = appVersion?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty != nil
        let version = hasVersion ? appVersionLabel : nil
        let activity = online ? "Active now" : lastActiveDescription(lastActiveAt)
        return [version, approximateLocation?.nonEmpty, activity]
            .compactMap { $0 }
            .joined(separator: " · ")
            .nonEmpty
    }

    /// Row title that also names older sign-ins by their method.
    var sessionTitle: String {
        guard isLegacySignIn else { return title }
        if let method = signInMethodLabel { return "\(method) sign-in" }
        return "Older sign-in"
    }
}

#Preview("Account settings") {
    AccountSheet()
        .environmentObject(AppModel(previewMode: true))
        .environmentObject(KordiCallCoordinator())
        .tint(KordiChatTheme.classic.accent)
}

struct MemorySettingsPreview: View {
    var body: some View {
        AccountSheet(previewing: .memory)
    }
}

struct AccountAuthenticationPreview: View {
    var body: some View {
        NavigationStack {
            ProviderAuthenticationView()
        }
    }
}

struct AccountAuthenticationDetailPreview: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: AppModel
    let providerID: String

    var body: some View {
        NavigationStack {
            if let provider = PreviewLoginSteps.definition(for: providerID, in: model.authenticationProviderDefinitions) {
                ProviderAuthenticationDetailView(provider: provider)
                    .stableNavigationDestination(item: $model.startedAgentChat) { chat in
                        ConversationView(conversation: chat)
                    }
            }
        }
        .tint(chatTheme.accent)
    }
}

struct AppearanceSettingsPreview: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue

    var body: some View {
        NavigationStack {
            AppearanceSettingsView()
        }
        .preferredColorScheme(AppearanceSettingsSelection.preferredColorScheme(appearanceRawValue))
        .tint(chatTheme.accent)
    }
}

struct ProfileSettingsPreview: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    var body: some View {
        NavigationStack {
            ProfileSettingsView(
                openingEmailVerification: ProcessInfo.processInfo.arguments.contains("--preview-email-verification")
            )
        }
        .tint(chatTheme.accent)
    }
}
