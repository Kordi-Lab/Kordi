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
                ForEach(catalog.filter { $0.kind == .service }) { row($0) }
                SettingsDivider()
                SettingsSectionTitle("On this iPhone")
                ForEach(catalog.filter { $0.kind == .macLocal }) { row($0) }
            }
        }
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
        let label = CompactSettingsLabel(
            title: definition.name,
            subtitle: definition.experimental ? "Experimental" : nil,
            systemImage: ConnectorsModel.systemImage(definition.providerId),
            value: ConnectorsModel.listValue(definition: definition, state: store.states[definition.providerId]),
            titleLineLimit: 1
        )
        if definition.availability == .available {
            NavigationLink {
                ConnectorDetailView(definition: definition, store: store)
            } label: {
                SettingsRow {
                    label
                } trailing: {
                    SettingsChevron()
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("connector-\(definition.providerId.rawValue)")
        } else {
            SettingsRow { label }
                .accessibilityIdentifier("connector-\(definition.providerId.rawValue)")
        }
    }
}
