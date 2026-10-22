import SwiftUI

/// Sources for the card. Every source is off until the person turns it on.
/// From version 3 the screen opens with the card's saved picks and saves
/// each change, so other devices see it without a build.
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
    @State private var connectorPicks: Set<ConnectorProviderId> = []
    @State private var documentPicks: [String] = []
    /// Nil while loading.
    @State private var documentList: [CommonGroundDocument]?
    @State private var documentsFailed = false
    @State private var showsDocuments = false
    /// The profile whose saved picks the screen opened with.
    @State private var seededProfile: String?
    @State private var setupProvider: ConnectorProviderId?

    private var deviceItems: [CommonGroundDeviceItems] {
        CommonGroundDeviceSource.allCases.compactMap { source in
            guard deviceIncluded.contains(source), let items = device.items[source], !items.isEmpty else { return nil }
            return CommonGroundDeviceItems(source: "iPhone \(source.title)", items: items)
        }
    }

    private var picks: CommonGroundSourcePicks {
        CommonGroundSourcePicks(
            memory: memory, connectors: connectorPicks, device: deviceIncluded,
            documents: documentPicks, links: links, notes: notes, keeping: model.currentSources
        )
    }

    /// Picked documents still in the list; every pick while it loads.
    private var usableDocuments: [String] {
        guard let documentList else { return documentPicks }
        let ids = Set(documentList.map(\.attachmentId))
        return documentPicks.filter(ids.contains)
    }

    private var choices: CommonGroundBuildChoices {
        CommonGroundBuildChoices(
            memoryOn: memory && showsMemory,
            memoryCount: showsMemory ? kordiSources.memoryCount : nil,
            connectors: showsConnectors
                ? CommonGroundBuildCopy.connectorIds.filter { connectorPicks.contains($0) && kordiSources.isConnected($0) } : [],
            device: deviceItems,
            documents: showsDocumentsRow ? usableDocuments : [],
            links: links,
            notes: notes,
            sendsSources: showsDocumentsRow,
            picks: showsDocumentsRow ? picks : nil
        )
    }

    private var showsConnectors: Bool { kordiSources.connectors != nil }
    private var showsMemory: Bool { appModel.isMemoryCapabilityPresent }
    private var showsDocumentsRow: Bool { model.sourcesEnabled }

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
            CommonGroundHero(title: model.buildTitle, status: model.currentProfile?.focusLine ?? "Your agent writes it") {
                CommonGroundAvatar(person: model.me, size: 92)
            }
            VStack(spacing: 16) {
                if showsMemory || showsDocumentsRow {
                    CommonGroundKordiSection(
                        sources: kordiSources,
                        showsMemory: showsMemory,
                        showsDocuments: showsDocumentsRow,
                        memoryOn: $memory,
                        documentsLine: CommonGroundBuildCopy.documentsLine(usableDocuments.count),
                        onDocuments: { showsDocuments = true }
                    )
                }
                if showsConnectors {
                    CommonGroundConnectorSection(sources: kordiSources, included: $connectorPicks, onSetUp: { setupProvider = $0 })
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
                buildButton
            }
            .padding(.horizontal, 16)
            .sheet(isPresented: $showsDocuments) {
                CommonGroundDocumentsSheet(documents: documentList, failed: documentsFailed, selection: $documentPicks)
                    .task { if documentsFailed { await loadDocuments() } }
            }
        }
        .task(id: model.currentProfile?.profileId) { seed() }
        .task(id: showsDocumentsRow) { if showsDocumentsRow { await loadDocuments() } }
        .task(id: picks) {
            let next = picks
            guard showsDocumentsRow, let profileId = seededProfile, profileId == model.activeProfileID else { return }
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            await model.saveSources(next, for: profileId)
        }
        .onDisappear(perform: flush)
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

    private var buildButton: some View {
        let disabled = !choices.canBuild || model.busy == "build"
        return Button {
            Task { await model.build(choices.request) }
        } label: {
            Text(model.buildFailed ? "Try again" : "Build")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color(uiColor: .systemBackground))
                .padding(.horizontal, 22)
                .frame(height: 38)
                .background(Color.primary, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .opacity(disabled ? 0.35 : 1)
        .disabled(disabled)
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }

    /// Opens with the current profile's saved picks, once per profile.
    private func seed() {
        guard showsDocumentsRow, let profile = model.currentProfile, seededProfile != profile.profileId else { return }
        let saved = profile.sources ?? CommonGroundSourcePicks()
        memory = saved.memory
        connectorPicks = saved.connectorIds
        deviceIncluded = saved.deviceSources
        documentPicks = Array(saved.documents.prefix(CommonGroundSourcePicks.maxDocuments))
        links = saved.links
        notes = saved.notes
        seededProfile = profile.profileId
    }

    /// Saves a change the debounce has not sent yet; a build saves its own.
    private func flush() {
        guard showsDocumentsRow, let profileId = seededProfile, profileId == model.activeProfileID,
              model.busy != "build", !model.isBuilding else { return }
        let next = picks
        Task { await model.saveSources(next, for: profileId) }
    }

    private func loadDocuments() async {
        if let documents = await model.loadDocuments() {
            documentList = documents
            documentsFailed = false
        } else {
            documentsFailed = documentList == nil
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
