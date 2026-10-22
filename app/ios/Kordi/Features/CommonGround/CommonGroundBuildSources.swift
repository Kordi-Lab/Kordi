import SwiftUI

/// Kordi sources for the Build screen: connector states and the saved
/// memory count, read through the Connectors and Memory services.
@MainActor
final class CommonGroundBuildSources: ObservableObject {
    /// Nil while loading.
    @Published private(set) var states: [ConnectorProviderId: ConnectorState]?
    @Published private(set) var memoryCount: Int?
    @Published private(set) var memoryFailed = false
    @Published var error: String?

    @Published private(set) var connectors: (any ConnectorsClient)?
    private var memory: (any MemoryService)?

    /// Sets the services once; later calls only reload.
    func attach(connectors: (any ConnectorsClient)?, memory: (any MemoryService)?) {
        if self.connectors == nil { self.connectors = connectors }
        if self.memory == nil { self.memory = memory }
    }

    func isConnected(_ providerId: ConnectorProviderId) -> Bool {
        states?[providerId]?.status == .connected
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
}

private let sourceSeparatorInset = SessionDetailMetrics.rowHorizontalInset + 42

/// Kordi: the Memory switch and the Documents row.
struct CommonGroundKordiSection: View {
    @ObservedObject var sources: CommonGroundBuildSources
    let showsMemory: Bool
    let showsDocuments: Bool
    @Binding var memoryOn: Bool
    let documentsLine: String
    let onDocuments: () -> Void

    var body: some View {
        CommonGroundSection(title: "Kordi") {
            if showsMemory { memoryRow }
            if showsMemory && showsDocuments { SessionDetailSeparator(leading: sourceSeparatorInset) }
            if showsDocuments { documentsRow }
        }
    }

    private var memoryRow: some View {
        let usable = (sources.memoryCount ?? 0) > 0
        return CommonGroundSourceRow(title: "Memory", subtitle: usable ? nil : sources.memoryLine) {
            SessionSettingsIconTile(systemImage: "brain", color: KordiTheme.brandPink)
        } trailing: {
            Toggle("Memory", isOn: Binding(get: { memoryOn && usable }, set: { memoryOn = $0 }))
                .labelsHidden()
                .disabled(!usable)
        }
    }

    private var documentsRow: some View {
        Button(action: onDocuments) {
            CommonGroundSourceRow(title: "Documents", subtitle: nil) {
                SessionSettingsIconTile(systemImage: "doc.text", color: .blue)
            } trailing: {
                HStack(spacing: 6) {
                    Text(documentsLine).foregroundStyle(.secondary)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Connected accounts: an include switch per connected account, Set up for the rest.
struct CommonGroundConnectorSection: View {
    @ObservedObject var sources: CommonGroundBuildSources
    @Binding var included: Set<ConnectorProviderId>
    let onSetUp: (ConnectorProviderId) -> Void

    var body: some View {
        CommonGroundSection(title: "Connected accounts") {
            ForEach(Array(CommonGroundBuildCopy.connectorIds.enumerated()), id: \.element) { index, id in
                if index > 0 { SessionDetailSeparator(leading: sourceSeparatorInset) }
                row(id)
            }
        }
        if let error = sources.error {
            Text(error)
                .font(.subheadline)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        }
    }

    private func row(_ id: ConnectorProviderId) -> some View {
        let name = ConnectorsModel.definition(id).name
        let status = sources.states?[id]?.status
        return CommonGroundSourceRow(title: name, subtitle: status == .needsReauth ? "Sign in again" : nil) {
            ConnectorLogo(providerId: id, size: 22)
                .frame(width: 30, height: 30)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        } trailing: {
            if sources.states == nil {
                EmptyView()
            } else if status == .connected {
                Toggle(name, isOn: Binding(
                    get: { included.contains(id) },
                    set: { on in if on { included.insert(id) } else { included.remove(id) } }
                ))
                .labelsHidden()
            } else {
                Button("Set up") { onSetUp(id) }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Set up \(name)")
            }
        }
    }
}

/// Icon, title, an optional secondary line and a trailing control.
struct CommonGroundSourceRow<Icon: View, Trailing: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder let icon: Icon
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            icon
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                if let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
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
