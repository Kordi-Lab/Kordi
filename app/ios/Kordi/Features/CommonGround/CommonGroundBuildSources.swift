import SwiftUI

/// Kordi sources for the Build screen: connector states and the saved
/// memory count, read through the Connectors and Memory services.
@MainActor
final class CommonGroundBuildSources: ObservableObject {
    /// Nil while loading.
    @Published private(set) var states: [ConnectorProviderId: ConnectorState]?
    @Published private(set) var memoryCount: Int?
    @Published private(set) var memoryFailed = false
    @Published private(set) var removing: ConnectorProviderId?
    @Published var error: String?

    @Published private(set) var connectors: (any ConnectorsClient)?
    private var memory: (any MemoryService)?

    /// Sets the services once; later calls only reload.
    func attach(connectors: (any ConnectorsClient)?, memory: (any MemoryService)?) {
        if self.connectors == nil { self.connectors = connectors }
        if self.memory == nil { self.memory = memory }
    }

    var connectedCount: Int {
        states?.values.filter { $0.status == .connected && CommonGroundBuildCopy.connectorIds.contains($0.providerId) }.count ?? 0
    }

    var memoryLine: String {
        memoryFailed ? "Could not load memories" : CommonGroundBuildCopy.memoryLine(memoryCount)
    }

    func load() async {
        async let connectorsDone: Void = loadConnectors()
        async let memoryDone: Void = loadMemory()
        _ = await (connectorsDone, memoryDone)
    }

    func loadConnectors() async {
        guard let connectors else { return }
        do {
            let result = try await connectors.list()
            states = Dictionary(result.states.map { ($0.providerId, $0) }, uniquingKeysWith: { _, last in last })
        } catch {
            if states == nil { states = [:] }
            self.error = ConnectorsStore.message(error, fallback: "Could not load connectors.")
        }
    }

    private func loadMemory() async {
        guard let memory else { return }
        do {
            memoryCount = try await memory.list().memories.count
            memoryFailed = false
        } catch {
            memoryFailed = memoryCount == nil
        }
    }

    func remove(_ providerId: ConnectorProviderId) async -> Bool {
        guard let connectors else { return false }
        removing = providerId
        error = nil
        defer { removing = nil }
        do {
            try await connectors.disconnect(providerId)
            states?[providerId] = .empty(providerId)
            await loadConnectors()
            return true
        } catch {
            self.error = ConnectorsStore.message(error, fallback: "Could not remove \(ConnectorsModel.definition(providerId).name).")
            return false
        }
    }
}

/// One row per connector with Set up or Remove, then the Memory row.
struct CommonGroundKordiSources: View {
    @ObservedObject var sources: CommonGroundBuildSources
    let showsConnectors: Bool
    let showsMemory: Bool
    @Binding var memoryOn: Bool
    let onSetUp: (ConnectorProviderId) -> Void
    @State private var confirming: ConnectorProviderId?

    private static let separatorInset = SessionDetailMetrics.rowHorizontalInset + 42

    var body: some View {
        CommonGroundSection(title: "Connectors") {
            if showsConnectors {
                ForEach(Array(CommonGroundBuildCopy.connectorIds.enumerated()), id: \.element) { index, id in
                    if index > 0 { SessionDetailSeparator(leading: Self.separatorInset) }
                    connectorRow(id)
                }
            }
            if showsConnectors && showsMemory {
                SessionDetailSeparator(leading: Self.separatorInset)
            }
            if showsMemory { memoryRow }
        }
        if let error = sources.error {
            Text(error)
                .font(.subheadline)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        }
    }

    private func connectorRow(_ id: ConnectorProviderId) -> some View {
        let name = ConnectorsModel.definition(id).name
        let status = sources.states?[id]?.status
        let asking = confirming == id && status == .connected
        let line = sources.states == nil ? "Loading…"
            : asking ? "Remove \(name)?"
            : CommonGroundBuildCopy.connectorLine(id, status: status)
        return CommonGroundSourceRow(title: name, subtitle: line) {
            ConnectorLogo(providerId: id, size: 22)
                .frame(width: 30, height: 30)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        } trailing: {
            if sources.states == nil {
                EmptyView()
            } else if asking {
                HStack(spacing: 8) {
                    Button("Cancel") { confirming = nil }
                        .buttonStyle(.bordered).tint(.secondary)
                    Button("Remove", role: .destructive) {
                        Task { if await sources.remove(id) { confirming = nil } }
                    }
                    .buttonStyle(.borderedProminent).tint(.red)
                }
                .controlSize(.small)
                .disabled(sources.removing != nil)
            } else if status == .connected {
                Button("Remove") { confirming = id }
                    .buttonStyle(.bordered).tint(.secondary).controlSize(.small)
                    .accessibilityLabel("Remove \(name)")
            } else {
                Button("Set up") { onSetUp(id) }
                    .buttonStyle(.bordered).controlSize(.small)
                    .accessibilityLabel("Set up \(name)")
            }
        }
    }

    private var memoryRow: some View {
        let usable = (sources.memoryCount ?? 0) > 0
        return CommonGroundSourceRow(title: "Memory", subtitle: sources.memoryLine) {
            SessionSettingsIconTile(systemImage: "brain", color: KordiTheme.brandPink)
        } trailing: {
            Toggle("Memory", isOn: Binding(get: { memoryOn && usable }, set: { memoryOn = $0 }))
                .labelsHidden()
                .disabled(!usable)
        }
    }
}

/// Icon, title, one secondary line and a trailing control.
struct CommonGroundSourceRow<Icon: View, Trailing: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let icon: Icon
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            icon
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 6)
        .frame(minHeight: SessionDetailMetrics.rowMinHeight)
    }
}

/// Connectors settings opened on one connector, over the Build screen.
struct CommonGroundConnectorSetup: View {
    @Environment(\.dismiss) private var dismiss
    let providerId: ConnectorProviderId
    let client: any ConnectorsClient

    var body: some View {
        NavigationStack {
            ConnectorsSettingsView(
                client: client,
                isPreview: client is PreviewConnectorsClient,
                request: ConnectorsSettingsRequest(link: ConnectorsSettingsLink(providerID: providerId.rawValue))
            )
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
