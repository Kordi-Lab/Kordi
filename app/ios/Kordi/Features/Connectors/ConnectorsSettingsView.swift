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
            try await client.connect(definition.providerId, scopeIds: definition.readScopes.map(\.id))
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
        List {
            Section {
                EmptyView()
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Connect the services you use so your agent can read updates from them and, with your approval, act in them. Kordi keeps each sign-in on its servers and only shares results with your agent.")
                    if store.isPreview {
                        Text("Showing sample connectors. Nothing here is connected to a real account.")
                    }
                }
            }

            if let error = store.errorMessage?.nonEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(error, systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(.red)
                        if !store.hasLoaded {
                            Button("Try again") { Task { await store.refresh() } }
                                .font(.subheadline.weight(.semibold))
                                .frame(minHeight: 32)
                                .disabled(store.isLoading)
                        }
                    }
                }
            }

            if !store.hasLoaded {
                if store.isLoading {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Loading connectors…")
                                .foregroundStyle(.secondary)
                        }
                        .frame(minHeight: 44)
                        .accessibilityElement(children: .combine)
                    }
                }
            } else {
                Section("Services") {
                    ForEach(catalog.filter { $0.kind == .service }) { row($0) }
                }
                Section {
                    ForEach(catalog.filter { $0.kind == .macLocal }) { row($0) }
                } header: {
                    Text("On this iPhone")
                } footer: {
                    Text("These use iPhone permissions. Kordi asks iOS before your agent can read them.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .environment(\.defaultMinListRowHeight, 44)
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
        let value = ConnectorsModel.listValue(definition: definition, state: store.states[definition.providerId])
        if definition.availability == .available {
            NavigationLink {
                ConnectorDetailView(definition: definition, store: store)
            } label: {
                ConnectorRowLabel(definition: definition, value: value)
            }
            .accessibilityIdentifier("connector-\(definition.providerId.rawValue)")
        } else {
            ConnectorRowLabel(definition: definition, value: value)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("connector-\(definition.providerId.rawValue)")
        }
    }
}

private struct ConnectorRowLabel: View {
    let definition: ConnectorDefinition
    let value: String

    var body: some View {
        HStack(spacing: 8) {
            CompactSettingsLabel(title: definition.name, systemImage: ConnectorsModel.systemImage(definition.providerId), value: value, titleLineLimit: 1)
            if definition.experimental {
                ConnectorCapsule(text: "Experimental", tint: .orange)
            }
        }
    }
}

/// Small rounded label used for "Experimental", "Read", and "Act".
struct ConnectorCapsule: View {
    let text: String
    let tint: Color?

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(tint ?? .secondary)
            .background((tint ?? .secondary).opacity(0.14), in: Capsule())
    }
}
