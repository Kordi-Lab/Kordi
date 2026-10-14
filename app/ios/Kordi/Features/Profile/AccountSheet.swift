import PhotosUI
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
                                .font(.caption2.weight(.semibold))
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
                                .font(.caption)
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
                MemorySettingsView(
                    service: model.makeMemoryService(),
                    accountLabel: MemoryPresentation.accountLabel(
                        email: model.account?.primaryEmail,
                        kordiId: model.account?.kordiId
                    ),
                    viewerAccountId: model.account?.accountId
                )
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
                    .font(.headline)
                if let email = model.account?.primaryEmail.nonEmpty {
                    Text(email)
                        .font(.caption)
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
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings-\(route.rawValue)")
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

/// Settings opened on Connectors, for `--preview-connectors`.
struct ConnectorsSettingsPreview: View {
    var body: some View {
        AccountSheet(previewing: .connectors)
    }
}

private enum DeviceLogoutRequest: Identifiable {
    case single(CloudDeviceAuthorization)
    case group(CloudDeviceGroup)
    case allOthers
    case allLegacy([CloudDeviceAuthorization])

    var id: String {
        switch self {
        case .single(let device): "single:\(device.deviceId)"
        case .group(let group): "group:\(group.id)"
        case .allOthers: "all-others"
        case .allLegacy: "all-legacy"
        }
    }

    var title: String {
        switch self {
        case .single(let device): "Log out of \(device.sessionTitle)?"
        case .group(let group): "Log out of \(group.title)?"
        case .allOthers: "Log out of all other devices?"
        case .allLegacy: "Log out of all older sign-ins?"
        }
    }

    var message: String? {
        switch self {
        case .single: nil
        case .group(let group): group.sessionCount > 1 ? "\(group.sessionCount) sessions will be signed out." : nil
        case .allOthers: "Every device except this one will be signed out."
        case .allLegacy(let rows): rows.count == 1 ? nil : "\(rows.count) older sign-ins will be signed out."
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
    private static let titleInset: CGFloat = 22 + 12

    private var grouping: CloudDeviceGrouping {
        CloudDeviceGrouping.make(from: model.devices)
    }

    @ViewBuilder
    private var deviceSections: some View {
        let grouping = grouping
        if let current = grouping.current {
            currentDeviceSection(current)
        } else {
            Label("This iPhone is not in the list. Refresh and try again.", systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(.orange)
                .frame(minHeight: 48, alignment: .leading)
        }
        if !grouping.otherDevices.isEmpty {
            destructiveRow("Log out of all other devices") { logoutRequest = .allOthers }
        }
        if !grouping.groups.isEmpty {
            SettingsDivider()
            SettingsSectionTitle("Other devices")
            ForEach(grouping.groups) { group in
                groupRows(group)
            }
        }
        if !grouping.legacy.isEmpty {
            SettingsDivider()
            legacySection(grouping.legacy)
        }
    }

    @ViewBuilder
    private func currentDeviceSection(_ device: CloudDeviceAuthorization) -> some View {
        HStack(alignment: .firstTextBaseline) {
            SettingsSectionTitle("This device")
            Spacer(minLength: 8)
            Button("Rename") {
                renameDraft = device.title
                renameTarget = device
            }
            .font(.caption.weight(.semibold))
            .textCase(nil)
            .disabled(isMutating)
        }
        DeviceSessionRow(
            title: device.title,
            systemImage: device.deviceSystemImage,
            detail: device.currentDetailLine,
            online: true,
            lastActiveAt: device.lastActiveAt,
            location: device.approximateLocation
        )
    }

    @ViewBuilder
    private func groupRows(_ group: CloudDeviceGroup) -> some View {
        if group.devices.count == 1 {
            let device = group.primary
            HStack(alignment: .center, spacing: 8) {
                DeviceSessionRow(
                    title: group.title,
                    systemImage: device.deviceSystemImage,
                    detail: [group.platformVersionLabel, device.appVersionLabel]
                        .compactMap { $0 }
                        .joined(separator: " · "),
                    online: group.online,
                    lastActiveAt: group.lastActiveAt,
                    location: group.location,
                    pending: group.pending
                )
                revokeButton(title: group.title) { logoutRequest = .single(device) }
            }
            if device.isPendingReview {
                confirmButton(device)
                    .padding(.leading, Self.titleInset)
                    .padding(.bottom, 6)
            }
        } else {
            DeviceSessionRow(
                title: group.title,
                systemImage: group.primary.deviceSystemImage,
                detail: [group.platformVersionLabel, "\(group.sessionCount) sessions"]
                    .compactMap { $0 }
                    .joined(separator: " · "),
                online: group.online,
                lastActiveAt: group.lastActiveAt,
                location: group.location,
                pending: group.pending
            )
            ForEach(group.devices) { device in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(device.appVersionLabel)
                                    .font(.subheadline)
                                if device.isPendingReview {
                                    NeedsReviewBadge()
                                }
                            }
                            DeviceStatusLine(online: device.online, lastActiveAt: device.lastActiveAt, location: nil)
                        }
                        .accessibilityElement(children: .combine)
                        Spacer(minLength: 8)
                        revokeButton(title: device.sessionTitle) { logoutRequest = .single(device) }
                    }
                    if device.isPendingReview {
                        confirmButton(device)
                            .padding(.bottom, 6)
                    }
                }
                .padding(.leading, Self.titleInset)
            }
            destructiveRow("Log out of this device") { logoutRequest = .group(group) }
                .padding(.leading, Self.titleInset)
        }
    }

    @ViewBuilder
    private func legacySection(_ rows: [CloudDeviceAuthorization]) -> some View {
        SettingsSectionTitle("Older sign-ins")
        ForEach(rows) { device in
            HStack(alignment: .center, spacing: 8) {
                DeviceSessionRow(
                    title: device.sessionTitle,
                    systemImage: "key",
                    detail: nil,
                    online: false,
                    lastActiveAt: device.lastActiveAt,
                    location: device.approximateLocation
                )
                revokeButton(title: device.sessionTitle) { logoutRequest = .single(device) }
            }
        }
        destructiveRow("Log out of all older sign-ins") { logoutRequest = .allLegacy(rows) }
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
        .font(.caption.weight(.semibold))
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
            case .group(let group):
                _ = await model.revokeDevices(group.devices)
            case .allOthers:
                _ = await model.revokeOtherDevices()
            case .allLegacy(let rows):
                _ = await model.revokeDevices(rows)
            }
            isMutating = false
            logoutRequest = nil
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if model.isRefreshingDevices && model.devices.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 48)
                    .accessibilityElement(children: .combine)
                } else if model.devices.isEmpty {
                    ContentUnavailableView("No active sessions", systemImage: "laptopcomputer.and.iphone")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                } else {
                    deviceSections
                }

                if let error = model.deviceErrorMessage.nonEmpty {
                    SettingsDivider()
                    VStack(alignment: .leading, spacing: 8) {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(.subheadline)
                            .foregroundStyle(.red)
                        Button("Try again") { Task { await model.refreshDevices() } }
                            .font(.subheadline.weight(.semibold))
                            .frame(minHeight: 44)
                    }
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

private struct NeedsReviewBadge: View {
    var body: some View {
        Text("Needs review")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.orange)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.orange.opacity(0.12), in: Capsule())
    }
}

private struct DeviceStatusLine: View {
    let online: Bool
    let lastActiveAt: String
    let location: String?

    var body: some View {
        let status = online ? "Active now" : lastActiveDescription(lastActiveAt)
        let text = [status, location.nonEmpty].compactMap { $0 }.joined(separator: " · ")
        if !text.isEmpty {
            HStack(spacing: 5) {
                if online {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                }
                Text(text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// A device row in the same flat style as `CompactSettingsLabel`.
private struct DeviceSessionRow: View {
    let title: String
    let systemImage: String
    let detail: String?
    let online: Bool
    let lastActiveAt: String
    let location: String?
    var pending = false

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: systemImage)
                .font(.body)
                .frame(width: 22)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title).font(.subheadline)
                    if pending {
                        NeedsReviewBadge()
                    }
                }
                if let detail = detail?.nonEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                DeviceStatusLine(online: online, lastActiveAt: lastActiveAt, location: location)
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.primary)
        .padding(.vertical, 5)
        .frame(minHeight: 48)
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

    /// Row title that also names older sign-ins by their method.
    var sessionTitle: String {
        guard isLegacySignIn else { return title }
        if let method = signInMethodLabel { return "\(method) sign-in" }
        return "Older sign-in"
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
    @State private var isVerifyingEmail: Bool

    init(openingEmailVerification: Bool = false) {
        _isVerifyingEmail = State(initialValue: openingEmailVerification)
    }

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
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(email)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            if let verified = model.account?.primaryEmailVerified {
                                AccountEmailVerificationStatus(verified: verified)
                            }
                        }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "envelope")
                                .foregroundStyle(.secondary)
                                .frame(width: 22)
                            Text("Email")
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("profile-email")
                    if model.account?.primaryEmailVerified == false {
                        Button {
                            model.errorMessage = nil
                            isVerifyingEmail = true
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "checkmark.shield")
                                    .frame(width: 22)
                                Text("Verify email")
                            }
                            .frame(minHeight: 30)
                        }
                        .accessibilityIdentifier("profile-verify-email")
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
        .sheet(isPresented: $isVerifyingEmail) {
            AccountEmailVerificationSheet(email: model.account?.primaryEmail.nonEmpty ?? "")
                .environmentObject(model)
        }
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

#Preview("Account settings") {
    AccountSheet()
        .environmentObject(AppModel(previewMode: true))
        .environmentObject(KordiCallCoordinator())
        .tint(KordiTheme.signalBlue)
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
    @AppStorage(AppAppearance.storageKey) private var appearanceRawValue = AppAppearance.system.rawValue

    var body: some View {
        NavigationStack {
            AppearanceSettingsView()
        }
        .preferredColorScheme(AppearanceSettingsSelection.preferredColorScheme(appearanceRawValue))
        .tint(KordiTheme.signalBlue)
    }
}

struct ProfileSettingsPreview: View {
    var body: some View {
        NavigationStack {
            ProfileSettingsView(
                openingEmailVerification: ProcessInfo.processInfo.arguments.contains("--preview-email-verification")
            )
        }
        .tint(KordiTheme.signalBlue)
    }
}
