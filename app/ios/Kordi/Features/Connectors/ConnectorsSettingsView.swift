import SwiftUI

/// Shared state for the Connectors list, detail, and activity screens.
@MainActor
final class ConnectorsStore: ObservableObject {
    @Published private(set) var states: [ConnectorProviderId: ConnectorState] = [:]
    @Published private(set) var agents: [ConnectorAgent] = []
    @Published private(set) var hasLoaded = false
    @Published private(set) var isLoading = false
    @Published private(set) var busyProviderId: ConnectorProviderId?
    @Published var errorMessage: String?

    let client: any ConnectorsClient
    let isPreview: Bool

    init(client: any ConnectorsClient, isPreview: Bool) {
        self.client = client
        self.isPreview = isPreview
    }

    func refresh(quiet: Bool = false) async {
        if !quiet { isLoading = true }
        defer { isLoading = false }
        do {
            let result = try await client.list()
            states = Dictionary(uniqueKeysWithValues: result.states.map { ($0.providerId, $0) })
            agents = result.agents
            hasLoaded = true
            errorMessage = nil
        } catch {
            errorMessage = Self.message(error, fallback: "Could not load connectors.")
        }
    }

    /// Runs a state-changing call. Returns true on success.
    @discardableResult
    func perform(
        _ providerId: ConnectorProviderId,
        fallback: String,
        _ action: () async throws -> ConnectorState
    ) async -> Bool {
        busyProviderId = providerId
        errorMessage = nil
        defer { busyProviderId = nil }
        do {
            let state = try await action()
            states[state.providerId] = state
            return true
        } catch {
            errorMessage = Self.message(error, fallback: fallback)
            return false
        }
    }

    func connect(_ definition: ConnectorDefinition) async -> Bool {
        let connected = await perform(definition.providerId, fallback: "Could not connect \(definition.name).") {
            try await client.connect(definition.providerId, scopeIds: ConnectorsModel.connectScopes(definition).map(\.id))
        }
        if connected { await refresh(quiet: true) }
        return connected
    }

    func grantAct(_ definition: ConnectorDefinition) async -> Bool {
        await perform(definition.providerId, fallback: "Could not grant act access to \(definition.name).") {
            try await client.grantAct(definition.providerId)
        }
    }

    func setActEnabled(_ definition: ConnectorDefinition, enabled: Bool) async {
        await perform(definition.providerId, fallback: "Could not update this connector. Try again.") {
            try await client.setActEnabled(definition.providerId, enabled: enabled)
        }
    }

    func setAgentGrant(_ definition: ConnectorDefinition, agent: ConnectorAgent, granted: Bool) async {
        await perform(definition.providerId, fallback: "Could not update this connector. Try again.") {
            try await client.setAgentGrant(definition.providerId, agentId: agent.agentId, granted: granted)
        }
    }

    func disconnect(_ definition: ConnectorDefinition) async -> Bool {
        busyProviderId = definition.providerId
        errorMessage = nil
        defer { busyProviderId = nil }
        do {
            try await client.disconnect(definition.providerId)
            states[definition.providerId] = .empty(definition.providerId)
            await refresh(quiet: true)
            return true
        } catch {
            errorMessage = Self.message(error, fallback: "Could not disconnect \(definition.name).")
            return false
        }
    }

    static func message(_ error: Error, fallback: String) -> String {
        (error as? LocalizedError)?.errorDescription?.nonEmpty ?? fallback
    }
}

struct ConnectorsSettingsView: View {
    @StateObject private var store: ConnectorsStore
    // A settings link, or a debug preview, can open one connector's detail directly.
    @State private var openedProviderId: ConnectorProviderId?
    @State private var consent: ConnectorConsent?
    private let request: ConnectorsSettingsRequest?

    init(client: any ConnectorsClient, isPreview: Bool, request: ConnectorsSettingsRequest? = nil) {
        _store = StateObject(wrappedValue: ConnectorsStore(client: client, isPreview: isPreview))
        self.request = request
        _openedProviderId = State(initialValue: Self.openableProviderId(request?.providerId)
            ?? ConnectorsAvailability.previewDetailProviderId())
    }

    /// Only a connector this screen lists with a detail can be opened by a link.
    private static func openableProviderId(_ providerId: ConnectorProviderId?) -> ConnectorProviderId? {
        ConnectorsModel.iPhoneCatalog.first { $0.providerId == providerId && $0.availability == .available }?.providerId
    }

    private var catalog: [ConnectorDefinition] { ConnectorsModel.iPhoneCatalog }

    var body: some View {
        SettingsPage {
            if store.isPreview {
                SettingsCaption("Showing sample connectors. Nothing here is connected to a real account.")
            }

            if let error = store.errorMessage?.nonEmpty {
                SettingsErrorLabel(error)
                if !store.hasLoaded {
                    Button("Try again") { Task { await store.refresh() } }
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: SettingsMetrics.textRowMinHeight)
                        .disabled(store.isLoading)
                }
            }

            if !store.hasLoaded {
                if store.isLoading {
                    SettingsLoadingRow("Loading connectors…")
                }
            } else {
                SettingsSectionTitle("Services")
                SettingsGroup(items: catalog.filter { $0.kind == .service }) { row($0) }
                SettingsSectionTitle("On this iPhone")
                    .padding(.top, 14)
                SettingsGroup(items: catalog.filter { $0.kind == .macLocal }) { row($0) }
            }
        }
        .connectorConsent($consent, store: store)
        .navigationTitle("Connectors")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await store.refresh() }
                } label: {
                    if store.isLoading {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(store.isLoading)
                .accessibilityLabel("Refresh connectors")
            }
        }
        .navigationDestination(item: $openedProviderId) { providerId in
            if let definition = catalog.first(where: { $0.providerId == providerId }) {
                ConnectorDetailView(definition: definition, store: store)
            }
        }
        .onChange(of: request) { _, request in
            if let request { openedProviderId = Self.openableProviderId(request.providerId) }
        }
        .refreshable { await store.refresh(quiet: true) }
        .task {
            if !store.hasLoaded { await store.refresh() }
        }
    }

    @ViewBuilder
    private func row(_ definition: ConnectorDefinition) -> some View {
        let identifier = "connector-\(definition.providerId.rawValue)"
        switch ConnectorsModel.listTrailing(
            definition: definition,
            state: store.states[definition.providerId],
            busy: store.busyProviderId == definition.providerId
        ) {
        case .connect:
            // Connecting starts here; the consent step still explains read and act first.
            Button {
                consent = .connect(definition, reauth: false)
            } label: {
                SettingsRow {
                    ConnectorRowLabel(definition: definition)
                } trailing: {
                    ConnectorRowValue(text: "Connect", systemImage: "arrow.up.right.square")
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Connect \(definition.name)")
            .accessibilityIdentifier(identifier)
        case .busy:
            SettingsRow {
                ConnectorRowLabel(definition: definition)
            } trailing: {
                ProgressView().controlSize(.small)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(identifier)
        case .open(let value):
            NavigationLink {
                ConnectorDetailView(definition: definition, store: store)
            } label: {
                SettingsRow {
                    ConnectorRowLabel(definition: definition)
                } trailing: {
                    ConnectorRowValue(text: value, systemImage: nil)
                    SettingsChevron()
                }
                .accessibilityElement(children: .combine)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(identifier)
        case .comingLater:
            SettingsRow {
                ConnectorRowLabel(definition: definition)
            } trailing: {
                ConnectorRowValue(text: "Coming later", systemImage: nil)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(identifier)
        }
    }
}

/// Logo and name of a connector in the list.
private struct ConnectorRowLabel: View {
    let definition: ConnectorDefinition

    var body: some View {
        HStack(spacing: 12) {
            ConnectorLogo(providerId: definition.providerId, size: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(definition.name)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if definition.experimental {
                    Text("Experimental").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// Grey trailing text of a connector row, with an optional icon after it.
private struct ConnectorRowValue: View {
    let text: String
    let systemImage: String?

    var body: some View {
        HStack(spacing: 6) {
            Text(text)
                .lineLimit(1)
                .fixedSize()
            if let systemImage {
                Image(systemName: systemImage).accessibilityHidden(true)
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
}

/// The service's own logo, or for an iPhone source its SF Symbol in the
/// system colour of the matching app.
struct ConnectorLogo: View {
    let providerId: ConnectorProviderId
    var size: CGFloat = 24

    var body: some View {
        Group {
            switch providerId {
            // Gmail, Google Calendar, and Slack marks: simple-icons 16.35.0, CC0-1.0.
            case .gmail: Image("GmailLogo").resizable().renderingMode(.original)
            case .googleCalendar: Image("GoogleCalendarLogo").resizable().renderingMode(.original)
            case .slack: Image("SlackLogo").resizable().renderingMode(.original)
            case .github: Image("GitHubMark").resizable().renderingMode(.template).foregroundStyle(.primary)
            case .outlook: symbol("envelope.fill", .blue)
            case .macCalendar: symbol("calendar", .red)
            case .macContacts: symbol("person.crop.circle.fill", .gray)
            case .macNotificationCenter: symbol("bell.badge.fill", .red)
            }
        }
        .scaledToFit()
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func symbol(_ name: String, _ color: Color) -> some View {
        Image(systemName: name)
            .resizable()
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(color)
    }
}

/// What the right side of a connector row shows and does.
enum ConnectorListTrailing: Equatable {
    /// Grey "Connect" with an external-link icon; the row starts connecting.
    case connect
    /// A call for this connector is running.
    case busy
    /// A short grey state and a chevron; the row opens the detail screen.
    case open(String)
    /// Not tappable yet.
    case comingLater
}

extension ConnectorsModel {
    static func listTrailing(definition: ConnectorDefinition, state: ConnectorState?, busy: Bool) -> ConnectorListTrailing {
        if definition.availability == .comingLater { return .comingLater }
        if busy { return .busy }
        switch state?.status ?? .notConnected {
        case .notConnected: return .connect
        case .connected: return .open("Connected")
        case .needsReauth: return .open("Sign in again")
        case .permissionMissing: return .open("Allow access")
        }
    }

    /// One short word or two for the detail header.
    static func detailState(definition: ConnectorDefinition, state: ConnectorState?) -> String {
        if definition.availability == .comingLater { return "Not yet available" }
        switch state?.status ?? .notConnected {
        case .notConnected: return "Not connected"
        case .connected: return "Connected"
        case .needsReauth: return "Sign in again"
        case .permissionMissing: return definition.requiresFullDiskAccess ? "Needs Full Disk Access" : "Needs permission"
        }
    }
}
