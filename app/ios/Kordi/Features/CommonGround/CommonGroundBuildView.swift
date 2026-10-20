import SwiftUI

/// Sources for the card. Every source is off until the person turns it on.
/// While a build runs the screen shows the wait state and polls the card.
struct CommonGroundBuildView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    /// Set on first run, where this screen is the root; nil when pushed.
    var onClose: (() -> Void)? = nil
    @State private var connectors = false
    @State private var memory = false
    @State private var links = ""
    @State private var notes = ""
    @StateObject private var device = CommonGroundDeviceAccess()
    @State private var deviceIncluded: Set<CommonGroundDeviceSource> = []

    private var deviceItems: [CommonGroundDeviceItems] {
        CommonGroundDeviceSource.allCases.compactMap { source in
            guard deviceIncluded.contains(source), let items = device.items[source], !items.isEmpty else { return nil }
            return CommonGroundDeviceItems(source: "iPhone \(source.title)", items: items)
        }
    }

    private var request: CommonGroundBuildRequest {
        CommonGroundBuildRequest(
            memory: memory && showsMemory,
            connectors: connectors && showsConnectors,
            device: deviceItems,
            links: links.trimmingCharacters(in: .whitespacesAndNewlines),
            notes: notes.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    private var canBuild: Bool {
        let request = request
        return request.memory || request.connectors || !request.device.isEmpty || !request.links.isEmpty || !request.notes.isEmpty
    }

    private var showsConnectors: Bool { appModel.connectorsVersion != nil }
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
            CommonGroundHero(title: "Build your card", status: "Only people you meet see it") {
                CommonGroundAvatar(person: model.me, size: 92)
            }
            VStack(spacing: 16) {
                if showsConnectors || showsMemory {
                    CommonGroundSection(title: "Kordi") {
                        if showsConnectors {
                            toggleRow("Connectors", "Mail, calendar and code you connected", symbol: "link", color: KordiTheme.signalBlue, isOn: $connectors)
                        }
                        if showsConnectors && showsMemory {
                            SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 42)
                        }
                        if showsMemory {
                            toggleRow("Memory", "Your saved memories", symbol: "brain", color: KordiTheme.brandPink, isOn: $memory)
                        }
                    }
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
                    Task { await model.build(request) }
                }
                .buttonStyle(CommonGroundPrimaryButtonStyle())
                .disabled(!canBuild || model.busy == "build")
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
    }

    private func toggleRow(_ title: String, _ subtitle: String, symbol: String, color: Color, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            label(title, subtitle, symbol: symbol, color: color)
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 6)
        .frame(minHeight: SessionDetailMetrics.rowMinHeight)
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
