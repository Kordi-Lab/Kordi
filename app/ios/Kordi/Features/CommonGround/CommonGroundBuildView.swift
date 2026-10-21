import SwiftUI

/// Sources for the card. Every source is off until the person turns it on.
/// While a build runs the screen shows the wait state and polls the card.
struct CommonGroundBuildView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    /// Set on first run, where this screen is the root; nil when pushed.
    var onClose: (() -> Void)? = nil
    @State private var memory = false
    @State private var links = ""
    @State private var notes = ""
    @StateObject private var device = CommonGroundDeviceAccess()
    @StateObject private var kordiSources = CommonGroundBuildSources()
    @State private var deviceIncluded: Set<CommonGroundDeviceSource> = []
    @State private var setupProvider: ConnectorProviderId?

    private var deviceItems: [CommonGroundDeviceItems] {
        CommonGroundDeviceSource.allCases.compactMap { source in
            guard deviceIncluded.contains(source), let items = device.items[source], !items.isEmpty else { return nil }
            return CommonGroundDeviceItems(source: "iPhone \(source.title)", items: items)
        }
    }

    private var choices: CommonGroundBuildChoices {
        CommonGroundBuildChoices(
            memoryOn: memory && showsMemory,
            memoryCount: showsMemory ? kordiSources.memoryCount : nil,
            connectedCount: showsConnectors ? kordiSources.connectedCount : 0,
            device: deviceItems,
            links: links,
            notes: notes
        )
    }

    private var showsConnectors: Bool { kordiSources.connectors != nil }
    private var showsMemory: Bool { appModel.isMemoryCapabilityPresent }

    var body: some View {
        Group {
            if model.isBuilding {
                CommonGroundWaitPage(steps: ["Reading sources", "Writing your card"], onBack: back) {
                    await model.waitForBuild()
                }
            } else {
                sources
            }
        }
        .onChange(of: model.isBuilding) { wasBuilding, building in
            if wasBuilding, !building, model.hasCard, !model.buildFailed, onClose == nil { dismiss() }
        }
    }

    private func back() {
        if let onClose { onClose() } else { dismiss() }
    }

    private var sources: some View {
        CommonGroundPage(onBack: back) {
            CommonGroundHero(title: "Build your profile", status: "Your agent writes it") {
                CommonGroundAvatar(person: model.me, size: 92)
            }
            VStack(spacing: 16) {
                if showsConnectors || showsMemory {
                    CommonGroundKordiSources(
                        sources: kordiSources,
                        showsConnectors: showsConnectors,
                        showsMemory: showsMemory,
                        memoryOn: $memory,
                        onSetUp: { setupProvider = $0 }
                    )
                }
                CommonGroundSection(title: "On this iPhone") {
                    ForEach(Array(CommonGroundDeviceSource.allCases.enumerated()), id: \.element) { index, source in
                        if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 42) }
                        deviceRow(source)
                    }
                }
                CommonGroundSection(title: "Links") {
                    field("Homepage; ORCID; papers", text: $links)
                }
                CommonGroundSection(title: "Notes") {
                    field("What are you working on?", text: $notes)
                }
                if let failure = model.buildFailureMessage {
                    Text(failure)
                        .font(.subheadline)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                }
                Button(model.buildFailed ? "Try again" : "Build profile") {
                    Task { await model.build(choices.request) }
                }
                .buttonStyle(CommonGroundPrimaryButtonStyle())
                .disabled(!choices.canBuild || model.busy == "build")
                .padding(.horizontal, 4)
                .padding(.top, 4)
            }
            .padding(.horizontal, 16)
        }
        .task {
            for source in CommonGroundDeviceSource.allCases where device.status[source] == .authorized {
                await device.read(source)
            }
        }
        .task(id: "\(appModel.connectorsVersion ?? -1) \(showsMemory)") {
            kordiSources.attach(
                connectors: ConnectorsAvailability.makeClient(connectorsVersion: appModel.connectorsVersion, cloudClient: appModel.cloudConnectorsClient),
                memory: showsMemory ? appModel.makeMemoryService() : nil
            )
            await kordiSources.load()
        }
        .sheet(isPresented: Binding(get: { setupProvider != nil }, set: { if !$0 { setupProvider = nil } }), onDismiss: {
            Task { await kordiSources.loadConnectors() }
        }) {
            if let setupProvider, let client = kordiSources.connectors {
                CommonGroundConnectorSetup(providerId: setupProvider, client: client)
                    .environmentObject(appModel)
            }
        }
    }

    /// Explains what is read before iOS asks; after a choice, shows the count
    /// or a way to Settings.
    @ViewBuilder
    private func deviceRow(_ source: CommonGroundDeviceSource) -> some View {
        let status = device.status[source] ?? .notDetermined
        let count = device.items[source]?.count
        HStack(spacing: 12) {
            label(source.title, subtitle(source, status: status, count: count), symbol: source.symbol, color: source.color)
            Spacer(minLength: 8)
            switch status {
            case .notDetermined:
                Button("Allow") {
                    Task {
                        await device.request(source)
                        if device.status[source] == .authorized { deviceIncluded.insert(source) }
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            case .authorized:
                Toggle("", isOn: Binding(
                    get: { deviceIncluded.contains(source) && (count ?? 0) > 0 },
                    set: { on in if on { deviceIncluded.insert(source) } else { deviceIncluded.remove(source) } }
                ))
                .labelsHidden()
                .disabled((count ?? 0) == 0)
            case .denied:
                Button("Settings") { device.openSettings() }
                    .buttonStyle(.bordered)
                    .tint(.secondary)
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 6)
        .frame(minHeight: SessionDetailMetrics.rowMinHeight)
    }

    private func subtitle(_ source: CommonGroundDeviceSource, status: CommonGroundAccessStatus, count: Int?) -> String {
        switch status {
        case .notDetermined: source.reads
        case .denied: "Access is off"
        case .authorized: count.map { $0 == 0 ? "Nothing found" : "\($0) titles" } ?? "Reading"
        }
    }

    private func label(_ title: String, _ subtitle: String, symbol: String, color: Color) -> some View {
        HStack(spacing: 12) {
            SessionSettingsIconTile(systemImage: symbol, color: color)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text, axis: .vertical)
            .font(.body)
            .lineLimit(3...8)
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .padding(.vertical, 12)
    }
}
