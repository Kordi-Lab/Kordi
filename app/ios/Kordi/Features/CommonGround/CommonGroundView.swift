import SwiftUI

#if DEBUG
/// Concept preview for Common ground: the agent turns memory into a shareable
/// card, and people pair by tapping phones (one to one) or by entering the
/// same four-digit code (a room). Data comes from the local demo server; see
/// CommonGroundModel.swift.

// MARK: - Routes

enum CommonGroundRoute: Hashable {
    case build
    case card
    case tap
    case code
    case lobby
    case room
    case match(String)
}

// MARK: - Root

/// Built from the conversation info page's parts (hero, glass action tiles,
/// grouped sections, segmented picker) so it reads as the same product.
struct CommonGroundView: View {
    /// Leaves Common ground from its home page; nil hides the back button.
    var onClose: (() -> Void)? = nil
    @StateObject private var model = CommonGroundModel()
    @State private var path: [CommonGroundRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            CommonGroundHome(path: $path, onClose: onClose)
                .navigationDestination(for: CommonGroundRoute.self) { route in
                    switch route {
                    case .build: CommonGroundBuildView(path: $path)
                    case .card: CommonGroundCardView(path: $path)
                    case .tap: CommonGroundTapView(path: $path)
                    case .code: CommonGroundCodeView(path: $path)
                    case .lobby: CommonGroundLobbyView(path: $path)
                    case .room: CommonGroundRoomView(path: $path)
                    case .match(let id): CommonGroundMatchView(personID: id)
                    }
                }
        }
        .overlay(alignment: .bottom) { CommonGroundToast(text: $model.notice) }
        .environmentObject(model)
        .tint(KordiTheme.signalBlue)
    }
}

private let commonGroundTint = KordiTheme.signalBlue

/// Info-page frame: tinted grouped background, hidden bar, round glass back.
private struct CommonGroundPage<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    var showsBack = true
    var onBack: (() -> Void)? = nil
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                content
            }
            .padding(.top, 56)
            .padding(.bottom, 28)
        }
        .background {
            SessionDetailBackground(tint: commonGroundTint).ignoresSafeArea()
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .topLeading) {
            if showsBack { SessionDetailBackButton { if let onBack { onBack() } else { dismiss() } } }
        }
    }
}

/// Full-screen wait state on the page background, with the animated mark.
private struct CommonGroundWaitPage: View {
    @Environment(\.dismiss) private var dismiss
    let steps: [String]
    let work: @MainActor () async -> Void

    var body: some View {
        VStack {
            Spacer()
            CommonGroundThinking(steps: steps, work: work)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background { SessionDetailBackground(tint: commonGroundTint).ignoresSafeArea() }
        .toolbar(.hidden, for: .navigationBar)
    }
}

/// Avatar, name and one status line, as on the conversation info page.
private struct CommonGroundHero<Avatar: View, Actions: View>: View {
    let title: String
    let status: String
    @ViewBuilder let avatar: Avatar
    @ViewBuilder let actions: Actions
    @ScaledMetric(relativeTo: .title2) private var nameSize = 24.0

    var body: some View {
        VStack(spacing: 0) {
            avatar.shadow(color: .black.opacity(0.08), radius: 10, y: 4)
            VStack(spacing: 2) {
                Text(title)
                    .font(.system(size: nameSize, weight: .bold))
                    .multilineTextAlignment(.center)
                Text(status)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 10)
            .accessibilityElement(children: .combine)
            actions.padding(.top, 16)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
    }
}

private struct CommonGroundActions<Content: View>: View {
    var columns = 4
    @ViewBuilder let content: Content

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: columns), spacing: 10) {
            content
        }
    }
}

// MARK: - Home

private struct CommonGroundHome: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var path: [CommonGroundRoute]
    var onClose: (() -> Void)? = nil

    var body: some View {
        CommonGroundPage(showsBack: onClose != nil, onBack: onClose) {
            CommonGroundHero(title: "Common ground", status: "Find what you share") {
                CommonGroundAvatar(person: model.me, size: 92)
            } actions: {
                CommonGroundActions(columns: 2) {
                    SessionProfileActionButton(title: "Tap phones", symbol: "iphone.radiowaves.left.and.right", tint: commonGroundTint) {
                        path.append(model.hasCard ? .tap : .build)
                    }
                    SessionProfileActionButton(title: "Pair code", symbol: "circle.grid.3x3", tint: commonGroundTint) {
                        path.append(model.hasCard ? .code : .build)
                    }
                }
            }

            CommonGroundSection(title: "Your card") {
                if model.hasCard {
                    Button { path.append(.card) } label: {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(spacing: 12) {
                                Text("\(model.myTopics.count) topics shared")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                Spacer(minLength: 8)
                                chevron
                            }
                            FlowLayout(spacing: 6) {
                                ForEach(model.myTopics, id: \.self) { CommonGroundTopicPill(topic: $0) }
                            }
                        }
                        .padding(SessionDetailMetrics.rowHorizontalInset)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(SessionRowButtonStyle())
                } else {
                    Button { path.append(.build) } label: {
                        HStack(spacing: 12) {
                            Text(model.loadedMe ? "Build your profile" : "Loading")
                                .font(.body)
                                .foregroundStyle(.primary)
                            Spacer(minLength: 8)
                            chevron
                        }
                        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(SessionRowButtonStyle())
                }
            }
            .padding(.horizontal, 16)

            CommonGroundSection(title: "Recent") {
                if model.recent.isEmpty {
                    Text("No matches yet")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
                } else {
                    CommonGroundPeopleRows(entries: model.recent.map(CommonGroundPeopleRows.Entry.init)) {
                        path.append(.match($0.id))
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .onAppear {
            Task { await model.loadHome() }
        }
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.tertiary)
    }
}

// MARK: - Build

/// A connector from Kordi's catalog. GitHub reads the public profile; the
/// others need a Kordi account with the connector set up on the server.
private struct CommonGroundConnector: Identifiable {
    let id: String
    let name: String
    let reads: String
    let symbol: String
    let color: Color
    let setup: String?

    static let catalog: [CommonGroundConnector] = [
        .init(id: "gmail", name: "Gmail", reads: "Paper, review and conference threads", symbol: "envelope", color: KordiTheme.brandPink, setup: "Gmail needs a Google sign-in app on this server"),
        .init(id: "gcal", name: "Google Calendar", reads: "Talks and meetings", symbol: "calendar", color: KordiTheme.signalBlue, setup: "Google Calendar needs a Google sign-in app on this server"),
        .init(id: "github", name: "GitHub", reads: "Repositories and bio", symbol: "chevron.left.forwardslash.chevron.right", color: Color(uiColor: .systemGray), setup: nil),
        .init(id: "slack", name: "Slack", reads: "Channels you choose", symbol: "number", color: KordiTheme.agentViolet, setup: "Slack needs a Slack app on this server"),
        .init(id: "maccal", name: "Calendar on this Mac", reads: "Event titles", symbol: "calendar.badge.clock", color: KordiTheme.brandAmber, setup: "Mac Calendar reading comes with the Kordi app"),
    ]
}

private struct CommonGroundBuildView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var path: [CommonGroundRoute]
    @State private var useAgents = false
    @State private var links = ""
    @State private var notes = ""
    @Environment(\.openURL) private var openURL
    /// Pending GitHub sign-in; its code shows under the GitHub row.
    @State private var githubCode: CommonGroundGitHubConnection?
    @State private var building = false
    @StateObject private var device = CommonGroundDeviceAccess()
    @State private var deviceIncluded: Set<CommonGroundDeviceSource> = []

    private var deviceItems: [CommonGroundDeviceItems] {
        CommonGroundDeviceSource.allCases.compactMap { source in
            guard deviceIncluded.contains(source), let items = device.items[source], !items.isEmpty else { return nil }
            return CommonGroundDeviceItems(source: "iPhone \(source.title)", items: items)
        }
    }

    private var agentsSelected: Bool { useAgents && !model.sources.isEmpty }

    private var canBuild: Bool {
        agentsSelected || !model.githubLogin.isEmpty || !deviceItems.isEmpty
            || !links.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var allLinks: String {
        let github = model.githubLogin
        return ([github.isEmpty ? nil : "github.com/\(github)", links] as [String?]).compactMap { $0 }.joined(separator: "; ")
    }

    private var sourceSummary: String {
        let labels = model.sources.map(\.label)
        guard !labels.isEmpty else { return "No agent files found" }
        let head = labels.prefix(2).joined(separator: ", ")
        return labels.count > 2 ? "\(head) +\(labels.count - 2)" : head
    }

    var body: some View {
        if building {
            CommonGroundWaitPage(steps: ["Reading sources", "Building your card"]) {
                do {
                    try await model.buildCard(useAgents: agentsSelected, links: allLinks, notes: notes, device: deviceItems)
                    path = [.card]
                } catch {
                    model.report(error)
                    building = false
                }
            }
        } else {
            CommonGroundPage {
                CommonGroundHero(title: "Build your profile", status: "Your agent writes it") {
                    CommonGroundAvatar(person: model.me, size: 92)
                } actions: {
                    EmptyView()
                }
                VStack(spacing: 16) {
                    CommonGroundSection(title: "Connectors") {
                        ForEach(CommonGroundConnector.catalog) { connector in
                            connectorRow(connector)
                            SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 42)
                        }
                        Toggle(isOn: $useAgents) {
                            label("Agents on this Mac", sourceSummary, symbol: "desktopcomputer", color: commonGroundTint)
                        }
                        .disabled(model.sources.isEmpty)
                        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                        .padding(.vertical, 6)
                        .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                    }
                    CommonGroundSection(title: "On this iPhone") {
                        ForEach(Array(CommonGroundDeviceSource.allCases.enumerated()), id: \.element) { index, source in
                            if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 42) }
                            deviceRow(source)
                        }
                    }
                    CommonGroundSection(title: "Links") {
                        field("Homepage; Google Scholar; ORCID; papers; anything about you", text: $links)
                    }
                    CommonGroundSection(title: "Notes") {
                        field("What are you working on?", text: $notes)
                    }
                    Button("Build profile") { building = true }
                        .buttonStyle(CommonGroundPrimaryButtonStyle())
                        .disabled(!canBuild)
                        .padding(.horizontal, 4)
                        .padding(.top, 4)
                }
                .padding(.horizontal, 16)
            }
            .task(id: githubCode?.userCode) { await pollGitHub() }
            .task {
                await model.loadSources()
                for source in CommonGroundDeviceSource.allCases where device.status[source] == .authorized {
                    await device.read(source)
                }
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
        case .authorized: count.map { $0 == 0 ? "Nothing found" : "\($0) titles" } ?? "Reading…"
        }
    }

    @ViewBuilder
    private func connectorRow(_ connector: CommonGroundConnector) -> some View {
        let isGitHub = connector.id == "github"
        let login = model.githubLogin
        HStack(spacing: 12) {
            label(connector.name, isGitHub && !login.isEmpty ? "@\(login)" : connector.reads, symbol: connector.symbol, color: connector.color)
            Spacer(minLength: 8)
            if isGitHub {
                Button(login.isEmpty ? "Connect" : "Remove") {
                    Task { login.isEmpty ? await startGitHub() : await stopGitHub() }
                }
                .buttonStyle(.borderedProminent)
                .tint(login.isEmpty ? commonGroundTint : Color(uiColor: .systemGray3))
                .controlSize(.small)
                .disabled(login.isEmpty && githubCode != nil)
            } else {
                Button("Set up") { model.notice = connector.setup }
                    .buttonStyle(.bordered)
                    .tint(.secondary)
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 6)
        .frame(minHeight: SessionDetailMetrics.rowMinHeight)
        if isGitHub, let code = githubCode?.userCode {
            VStack(alignment: .leading, spacing: 4) {
                Text(code)
                    .font(.system(.title2, design: .monospaced).weight(.semibold))
                    .tracking(3)
                    .textSelection(.enabled)
                Text("Code copied. Paste it on GitHub.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Button("Open GitHub") { openGitHub() }
                        .buttonStyle(.borderedProminent)
                    Button("Cancel") { Task { await stopGitHub() } }
                        .buttonStyle(.bordered)
                        .tint(.secondary)
                }
                .controlSize(.small)
                .padding(.top, 6)
            }
            .padding(.leading, SessionDetailMetrics.rowHorizontalInset + 42)
            .padding(.trailing, SessionDetailMetrics.rowHorizontalInset)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func startGitHub() async {
        do {
            let response = try await model.connectGitHub()
            guard response.status == "pending", response.userCode != nil else {
                githubCode = nil
                return
            }
            UIPasteboard.general.string = response.userCode
            githubCode = response
            openGitHub()
        } catch {
            model.report(error)
        }
    }

    private func stopGitHub() async {
        githubCode = nil
        do {
            try await model.disconnectGitHub()
        } catch {
            model.report(error)
        }
    }

    private func openGitHub() {
        guard let raw = githubCode?.verificationUri, let url = URL(string: raw) else { return }
        openURL(url)
    }

    /// Polls every 2 s while a sign-in is pending. Cancelled when the view
    /// goes away or the code changes.
    private func pollGitHub() async {
        guard githubCode != nil else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, githubCode != nil else { return }
            guard let response = try? await model.githubStatus() else { continue }
            switch response.status {
            case "pending": continue
            case "denied": model.notice = "GitHub sign-in was cancelled"
            case "expired": model.notice = "The code expired. Try again."
            default: break
            }
            githubCode = nil
            return
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

// MARK: - Card

private struct CommonGroundCardView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var path: [CommonGroundRoute]
    @State private var references: CommonGroundReferenceTopic?

    private var profile: CommonGroundProfile? { model.card?.profile }

    var body: some View {
        CommonGroundPage {
            CommonGroundHero(title: "Your card", status: "Built by your agent") {
                CommonGroundAvatar(person: model.me, size: 92)
            } actions: {
                EmptyView()
            }
            VStack(spacing: 16) {
                if model.card != nil {
                    if let latest = profile?.latest, !latest.isEmpty {
                        CommonGroundSection(title: "Now") {
                            FlowLayout(spacing: 8) {
                                ForEach(latest, id: \.self) { topic in
                                    CommonGroundTag(topic: topic, onOpen: { open(topic) })
                                }
                            }
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    section("Working on", \.workingOn)
                    section("Interests", \.interests)
                    section("Can help with", \.canHelp)
                    section("Looking for", \.lookingFor)
                    if let profile, !profile.timeline.isEmpty || !profile.earlier.isEmpty {
                        CommonGroundTimeline(profile: profile, onOpen: open)
                    }
                    Button("Rebuild card") { path.append(.build) }
                        .font(.body.weight(.semibold))
                        .frame(minHeight: 44)
                } else {
                    CommonGroundSection {
                        Button { path.append(.build) } label: {
                            Text("Build your profile")
                                .font(.body)
                                .foregroundStyle(.primary)
                                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                                .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(SessionRowButtonStyle())
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .sheet(item: $references) { topic in
            CommonGroundReferences(topic: topic.label, profile: profile)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    @State private var adding: WritableKeyPath<CommonGroundCard, [String]>?
    @State private var draft = ""
    /// Typed tags stay short enough to read at a glance.
    private static let tagMax = 40
    @FocusState private var draftFocused: Bool

    /// Inline tag-sized field that grows with its text.
    private func draftChip(for key: WritableKeyPath<CommonGroundCard, [String]>) -> some View {
        HStack(spacing: 7) {
            Circle().fill(commonGroundTint.opacity(0.35)).frame(width: 8, height: 8)
            ZStack(alignment: .leading) {
                // Invisible copy of the text sets the field's width.
                Text(draft.isEmpty ? "New topic" : draft)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .fixedSize()
                    .hidden()
                TextField("New topic", text: $draft)
                    .font(.subheadline.weight(.medium))
                    .focused($draftFocused)
                    .submitLabel(.done)
                    .onSubmit { commit(to: key) }
            }
            .frame(minWidth: 90, maxWidth: 240, alignment: .leading)
            .fixedSize(horizontal: true, vertical: false)
            if draft.count >= Self.tagMax - 10 {
                Text("\(draft.count)/\(Self.tagMax)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(draft.count >= Self.tagMax ? Color.red : Color.secondary)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: commonGroundTagHeight)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: commonGroundTagShape)
        .overlay(commonGroundTagShape.strokeBorder(commonGroundTint.opacity(0.55), lineWidth: 1.5))
        .onChange(of: draft) { _, text in
            if text.count > Self.tagMax { draft = String(text.prefix(Self.tagMax)) }
        }
        .onChange(of: draftFocused) { _, focused in
            if !focused, adding == key { commit(to: key) }
        }
    }

    private func open(_ topic: String) {
        references = CommonGroundReferenceTopic(label: topic)
    }

    private func section(_ title: String, _ key: WritableKeyPath<CommonGroundCard, [String]>) -> some View {
        let topics = model.card?[keyPath: key] ?? []
        return CommonGroundSection(title: title) {
            FlowLayout(spacing: 8) {
                ForEach(topics, id: \.self) { topic in
                    CommonGroundTag(topic: topic, onOpen: { open(topic) }, onRemove: { remove(topic, from: key) })
                }
                if adding == key {
                    draftChip(for: key)
                } else {
                    Button {
                        if let open = adding { commit(to: open) }
                        adding = key
                        draftFocused = true
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "plus")
                                .font(.system(size: 11, weight: .semibold))
                            Text("Add")
                                .font(.subheadline.weight(.medium))
                        }
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .frame(height: commonGroundTagHeight)
                        .background(Color(uiColor: .tertiarySystemFill), in: commonGroundTagShape)
                        .contentShape(commonGroundTagShape)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func remove(_ topic: String, from key: WritableKeyPath<CommonGroundCard, [String]>) {
        guard var next = model.card else { return }
        next[keyPath: key].removeAll { $0 == topic }
        model.updateCard(next)
    }

    private func commit(to key: WritableKeyPath<CommonGroundCard, [String]>) {
        let text = draft.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        draft = ""
        adding = nil
        guard !text.isEmpty, var next = model.card,
              !next[keyPath: key].contains(where: { $0.caseInsensitiveCompare(text) == .orderedSame }) else { return }
        next[keyPath: key].append(String(text.prefix(Self.tagMax)))
        model.updateCard(next)
    }
}

private struct CommonGroundReferenceTopic: Identifiable {
    let label: String
    var id: String { label }
}

/// A topic tag with its color dot. Tapping the text opens its references;
/// the remove button shows only when the tag is editable.
private struct CommonGroundTag: View {
    let topic: String
    var onOpen: (() -> Void)? = nil
    var onRemove: (() -> Void)? = nil

    var body: some View {
        let style = commonGroundStyle(for: topic)
        HStack(spacing: 7) {
            Button { onOpen?() } label: {
                HStack(spacing: 7) {
                    Circle().fill(style.color).frame(width: 8, height: 8)
                    Text(topic)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(onOpen == nil)
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(CommonGroundRemoveButtonStyle())
                .accessibilityLabel("Remove \(topic)")
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, onRemove == nil ? 12 : 6)
        .frame(height: commonGroundTagHeight)
        .background(style.color.opacity(0.13), in: commonGroundTagShape)
    }
}

private let commonGroundTagHeight: CGFloat = 32
private let commonGroundTagShape = RoundedRectangle(cornerRadius: 8, style: .continuous)

/// Plain remove glyph with a small rounded fill while pressed.
private struct CommonGroundRemoveButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                Color(uiColor: .tertiarySystemFill).opacity(configuration.isPressed ? 1 : 0),
                in: RoundedRectangle(cornerRadius: 5, style: .continuous)
            )
    }
}

/// Quarters, newest first, on a dotted rail; past topics close the list muted.
private struct CommonGroundTimeline: View {
    let profile: CommonGroundProfile
    let onOpen: (String) -> Void

    private struct Entry: Identifiable {
        let period: String
        let topics: [String]
        var id: String { period }
    }

    private static let periodWidth: CGFloat = 72
    private static let rowPadding: CGFloat = 10
    /// Vertical centre of the dot within a row.
    private static let dotCenter: CGFloat = rowPadding + 10

    private var earlier: Set<String> { Set(profile.earlier) }

    /// Each topic sits in the period it first appeared; earlier topics that
    /// appear in no period close the list.
    private var entries: [Entry] {
        var out = profile.timeline.map { Entry(period: $0.period, topics: $0.topics) }
        let placed = Set(profile.timeline.flatMap(\.topics))
        let rest = profile.earlier.filter { !placed.contains($0) }
        if !rest.isEmpty {
            out.append(Entry(period: "Earlier", topics: rest))
        }
        return out
    }

    var body: some View {
        let entries = entries
        CommonGroundSection(title: "Timeline") {
            VStack(spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                    row(entry, isFirst: index == 0, isLast: index == entries.count - 1)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func row(_ entry: Entry, isFirst: Bool, isLast: Bool) -> some View {
        let earlier = earlier
        let muted = !entry.topics.isEmpty && entry.topics.allSatisfy(earlier.contains)
        return HStack(alignment: .top, spacing: 12) {
            Text(entry.period)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(muted ? .secondary : .primary)
                .frame(width: Self.periodWidth, alignment: .leading)
            Circle()
                .fill(muted ? Color(uiColor: .tertiaryLabel) : commonGroundTint)
                .frame(width: 8, height: 8)
                .padding(.top, Self.dotCenter - Self.rowPadding - 4)
            FlowLayout(spacing: 6) {
                ForEach(entry.topics, id: \.self) { topic in
                    Button { onOpen(topic) } label: {
                        CommonGroundTopicPill(topic: topic, muted: earlier.contains(topic))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, Self.rowPadding)
        .background(alignment: .topLeading) {
            if !(isFirst && isLast) {
                Rectangle()
                    .fill(Color(uiColor: .separator))
                    .frame(width: 1.5, height: isLast ? Self.dotCenter : nil)
                    .padding(.top, isFirst ? Self.dotCenter : 0)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .padding(.leading, 14 + Self.periodWidth + 12 + 4 - 0.75)
            }
        }
    }
}

/// The evidence behind one topic, newest first; rows with a URL open it.
private struct CommonGroundReferences: View {
    let topic: String
    let profile: CommonGroundProfile?

    var body: some View {
        let info = profile?.info(for: topic)
        let items = profile?.evidence(for: topic) ?? []
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(topic)
                        .font(.title3.weight(.bold))
                    if let seen = seenLine(info) {
                        Text(seen)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 4)
                CommonGroundSection {
                    if items.isEmpty {
                        Text("No references")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                            .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
                    }
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, entry in
                        if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                        if let raw = entry.item.url, let url = URL(string: raw) {
                            Link(destination: url) { row(entry.item, linked: true) }
                                .buttonStyle(SessionRowButtonStyle())
                        } else {
                            row(entry.item, linked: false)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 24)
            .padding(.bottom, 16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private func row(_ item: CommonGroundProfile.Evidence, linked: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                Text([item.source, commonGroundDisplayDate(item.date)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !item.snippet.isEmpty {
                    Text(item.snippet)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            if linked {
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 4)
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func seenLine(_ info: CommonGroundProfile.TopicInfo?) -> String? {
        let parts = [
            commonGroundDisplayDate(info?.firstSeen).map { "First seen \($0)" },
            commonGroundDisplayDate(info?.lastSeen).map { "Last seen \($0)" },
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// "2026-09-30" to "Sep 30, 2026"; nil when missing or unparseable.
private func commonGroundDisplayDate(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let parser = DateFormatter()
    parser.calendar = Calendar(identifier: .gregorian)
    parser.locale = Locale(identifier: "en_US_POSIX")
    parser.timeZone = .current
    parser.dateFormat = "yyyy-MM-dd"
    guard let date = parser.date(from: String(raw.prefix(10))) else { return nil }
    return date.formatted(.dateTime.month(.abbreviated).day().year())
}

// MARK: - Tap (one to one)

private struct CommonGroundTapView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    @Binding var path: [CommonGroundRoute]
    @State private var partner: CommonGroundPerson?
    @State private var showsConsent = false
    @State private var thinking = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            if thinking, let partner {
                CommonGroundThinking(steps: ["Reading cards", "Finding overlap"]) {
                    do {
                        try await model.loadMatch(partner.id)
                        path = [.match(partner.id)]
                    } catch {
                        model.report(error)
                        thinking = false
                    }
                }
            } else {
                CommonGroundPulse(me: model.me, partner: partner)
                VStack(spacing: 2) {
                    Text(partner?.name ?? "Hold near another iPhone")
                        .font(.title3.weight(.bold))
                    Text(partner?.lab ?? "Both phones unlocked")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 28)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background {
            SessionDetailBackground(tint: commonGroundTint).ignoresSafeArea()
        }
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .topLeading) { SessionDetailBackButton { dismiss() } }
        .task {
            guard partner == nil else { return }
            try? await Task.sleep(for: .seconds(2.4))
            guard !Task.isCancelled else { return }
            do {
                let person = try await model.tap()
                withAnimation(.snappy) { partner = person }
            } catch {
                model.report(error)
                return
            }
            try? await Task.sleep(for: .seconds(0.9))
            guard !Task.isCancelled else { return }
            showsConsent = true
        }
        .sheet(isPresented: $showsConsent) {
            if let partner {
                CommonGroundConsent(person: partner) {
                    showsConsent = false
                    thinking = true
                }
                .presentationDetents([.height(400)])
                .presentationDragIndicator(.visible)
            }
        }
    }
}

private struct CommonGroundConsent: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    let person: CommonGroundPerson
    let onShare: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: -10) {
                CommonGroundAvatar(person: model.me, size: 56, ringed: true)
                CommonGroundAvatar(person: person, size: 56, ringed: true)
            }
            .padding(.top, 28)
            Text("Share card with \(person.name)?")
                .font(.title3.weight(.bold))
                .padding(.top, 12)
            Text("\(model.myTopics.count) topics. No chats.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.top, 2)
            FlowLayout(spacing: 6) {
                ForEach(model.myTopics, id: \.self) { CommonGroundTopicPill(topic: $0) }
            }
            .padding(.top, 16)
            Spacer(minLength: 20)
            Button("Share card", action: onShare)
                .buttonStyle(CommonGroundPrimaryButtonStyle())
            Button("Not now") { dismiss() }
                .font(.body.weight(.semibold))
                .frame(minHeight: 44)
                .padding(.top, 6)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
        .background(Color(uiColor: .systemGroupedBackground))
    }
}

// MARK: - Code (room)

private struct CommonGroundCodeView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    @Binding var path: [CommonGroundRoute]
    @State private var code = ""
    @State private var joining = false

    private let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "delete"]

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 2) {
                Text("Pair code")
                    .font(.system(size: 24, weight: .bold))
                Text("Same code, same room")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 72)
            HStack(spacing: 22) {
                ForEach(0..<4, id: \.self) { index in
                    Circle()
                        .fill(index < code.count ? Color.primary : Color(uiColor: .tertiarySystemFill))
                        .frame(width: 13, height: 13)
                }
            }
            .padding(.top, 32)
            Spacer()
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                ForEach(keys, id: \.self) { key in
                    keyView(key)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
        .background {
            SessionDetailBackground(tint: commonGroundTint).ignoresSafeArea()
        }
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .topLeading) { SessionDetailBackButton { dismiss() } }
        .onAppear {
            code = ""
            joining = false
        }
    }

    @ViewBuilder
    private func keyView(_ key: String) -> some View {
        if key.isEmpty {
            Color.clear.frame(height: 62)
        } else {
            Button {
                press(key)
            } label: {
                Group {
                    if key == "delete" {
                        Image(systemName: "delete.left").font(.system(size: 20, weight: .medium))
                    } else {
                        Text(key).font(.system(size: 26, weight: .medium))
                    }
                }
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, minHeight: 62)
                .sessionGlass(in: RoundedRectangle(cornerRadius: SessionDetailMetrics.actionCornerRadius, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(joining)
            .accessibilityLabel(key == "delete" ? "Delete" : key)
        }
    }

    private func press(_ key: String) {
        if key == "delete" {
            if !code.isEmpty { code.removeLast() }
            return
        }
        guard code.count < 4 else { return }
        code.append(key)
        if code.count == 4 {
            joining = true
            let entered = code
            Task {
                do {
                    try await model.join(code: entered)
                    path.append(.lobby)
                } catch {
                    model.report(error)
                    code = ""
                    joining = false
                }
            }
        }
    }
}

private struct CommonGroundLobbyView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var path: [CommonGroundRoute]
    @State private var thinking = false

    var body: some View {
        Group {
            if thinking {
                CommonGroundWaitPage(steps: ["Reading \(model.members.count + 1) cards", "Finding overlap", "Grouping topics"]) {
                    do {
                        try await model.loadResults()
                        path = [.room]
                    } catch {
                        model.report(error)
                        thinking = false
                    }
                }
            } else {
                CommonGroundPage {
                    CommonGroundHero(title: "Room \(model.roomCode)", status: "\(model.members.count + 1) people") {
                        CommonGroundStack(people: [model.me] + model.members, size: 92)
                    } actions: {
                        EmptyView()
                    }
                    CommonGroundSection {
                        CommonGroundPeopleRows(
                            entries: ([model.me] + model.members).map { CommonGroundPeopleRows.Entry(person: $0, isMe: $0.id == model.me.id) },
                            onSelect: nil
                        )
                    }
                    .padding(.horizontal, 16)
                }
                .safeAreaInset(edge: .bottom) {
                    Button("Find common ground") { thinking = true }
                        .buttonStyle(CommonGroundPrimaryButtonStyle())
                        .disabled(model.members.count < 2)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 8)
                }
            }
        }
        .task(id: thinking) {
            guard !thinking else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                await model.refreshRoom()
            }
        }
    }
}

private enum CommonGroundRoomTab: String, CaseIterable, Identifiable {
    case people = "People"
    case topics = "Topics"
    var id: Self { self }
}

private struct CommonGroundRoomView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var path: [CommonGroundRoute]
    @State private var tab = CommonGroundRoomTab.people
    @State private var notice: String?

    var body: some View {
        let results = model.results
        let topics = results?.topics ?? []
        CommonGroundPage {
            CommonGroundHero(title: "Room \(model.roomCode)", status: "\(model.members.count + 1) people · \(topics.count) shared topics") {
                CommonGroundStack(people: [model.me] + model.members, size: 92)
            } actions: {
                CommonGroundActions {
                    SessionProfileActionButton(title: "Start group", symbol: "person.3", tint: commonGroundTint) {
                        notice = "Group created"
                    }
                    SessionProfileActionButton(title: "Meet", symbol: "calendar", tint: commonGroundTint) {
                        notice = "Invite sent"
                    }
                    SessionProfileActionButton(title: "Share code", symbol: "square.and.arrow.up", tint: commonGroundTint) {
                        notice = "Code copied"
                    }
                    SessionProfileActionButton(title: "Leave", symbol: "rectangle.portrait.and.arrow.right", tint: commonGroundTint) {
                        path = []
                    }
                }
            }

            if let suggestion = results?.suggestion {
                let others = suggestion.people.filter { $0.id != model.me.id }
                let includesMe = others.count < suggestion.people.count
                let names = CommonGroundRoomView.list(others.map(\.name))
                CommonGroundSection(title: "Suggested") {
                    HStack(spacing: 12) {
                        CommonGroundStack(people: suggestion.people, size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(suggestion.label).font(.headline)
                            Text(includesMe ? "You, " + names : names)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Button("Start") { notice = "Group created" }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .padding(.vertical, 10)
                }
                .padding(.horizontal, 16)
            }

            VStack(spacing: 16) {
                Picker("Room content", selection: $tab) {
                    ForEach(CommonGroundRoomTab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                CommonGroundSection {
                    switch tab {
                    case .people:
                        CommonGroundPeopleRows(entries: (results?.people ?? []).map(CommonGroundPeopleRows.Entry.init)) { person in
                            path.append(.match(person.id))
                        }
                    case .topics:
                        ForEach(Array(topics.enumerated()), id: \.offset) { index, topic in
                            if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 42) }
                            HStack(spacing: 12) {
                                let style = commonGroundStyle(for: topic.label)
                                SessionSettingsIconTile(systemImage: style.symbol, color: style.color)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(topic.label).font(.body)
                                    Text("\(topic.people.count) people")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 8)
                                CommonGroundStack(people: topic.people, size: 34)
                            }
                            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                            .padding(.vertical, 8)
                            .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
        }
        .overlay(alignment: .bottom) { CommonGroundToast(text: $notice) }
    }

    static func list(_ names: [String]) -> String {
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + (names.last ?? "")
    }
}

// MARK: - Match

private enum CommonGroundMatchTab: String, CaseIterable, Identifiable {
    case shared = "Shared"
    case trade = "Trade"
    var id: Self { self }
}

private struct CommonGroundMatchView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    let personID: String

    var body: some View {
        if let match = model.matches[personID] {
            CommonGroundMatchContent(match: match)
        } else {
            CommonGroundWaitPage(steps: ["Reading cards", "Finding overlap"]) {
                do {
                    try await model.loadMatch(personID)
                } catch {
                    model.report(error)
                    dismiss()
                }
            }
            .overlay(alignment: .topLeading) { SessionDetailBackButton { dismiss() } }
        }
    }
}

private struct CommonGroundMatchContent: View {
    @EnvironmentObject private var model: CommonGroundModel
    let match: CommonGroundMatch
    @State private var tab = CommonGroundMatchTab.shared
    @State private var showsDraft = false
    @State private var notice: String?

    var body: some View {
        let person = match.person
        CommonGroundPage {
            CommonGroundHero(title: person.name, status: person.lab) {
                CommonGroundMatchBadge(me: model.me, person: person, score: match.score)
            } actions: {
                CommonGroundActions {
                    SessionProfileActionButton(title: "Add", symbol: "person.badge.plus", tint: commonGroundTint) {
                        notice = "Request sent to \(person.name)"
                    }
                    SessionProfileActionButton(title: "Joint idea", symbol: "doc.text", tint: commonGroundTint) {
                        showsDraft = true
                    }
                    SessionProfileActionButton(title: "Meet", symbol: "calendar", tint: commonGroundTint) {
                        notice = "Invite sent to \(person.name)"
                    }
                    SessionProfileActionButton(title: "Chat", symbol: "message", tint: commonGroundTint) {
                        notice = "Chat opened"
                    }
                }
            }

            VStack(spacing: 16) {
                Picker("Match content", selection: $tab) {
                    ForEach(CommonGroundMatchTab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                switch tab {
                case .shared:
                    CommonGroundSection {
                        if match.shared.isEmpty {
                            row("No direct overlap", nil)
                        }
                        ForEach(Array(match.shared.enumerated()), id: \.offset) { index, reason in
                            if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                            row(reason.topic, reason.why, style: commonGroundStyle(for: reason.topic))
                        }
                    }
                case .trade:
                    VStack(spacing: 16) {
                        if match.youBring.isEmpty && match.theyBring.isEmpty {
                            CommonGroundSection { row("No clear trade yet", nil) }
                        }
                        if !match.youBring.isEmpty {
                            tradeSection("You bring", match.youBring, whose: "\(person.name)'s")
                        }
                        if !match.theyBring.isEmpty {
                            tradeSection("\(person.name) brings", match.theyBring, whose: "your")
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
        }
        .overlay(alignment: .bottom) { CommonGroundToast(text: $notice) }
        .sheet(isPresented: $showsDraft) {
            CommonGroundDraft(match: match) {
                showsDraft = false
                notice = "Shared as a document"
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private func tradeSection(_ title: String, _ items: [CommonGroundTrade], whose: String) -> some View {
        CommonGroundSection(title: title) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                row(item.topic, "For \(whose) \(item.target.prefix(1).lowercased() + item.target.dropFirst())", style: commonGroundStyle(for: item.topic))
            }
        }
    }

    private func row(_ title: String, _ subtitle: String?, style: (symbol: String, color: Color)? = nil) -> some View {
        HStack(spacing: 12) {
            if let style {
                SessionSettingsIconTile(systemImage: style.symbol, color: style.color)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                if let subtitle {
                    Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
    }
}

private struct CommonGroundDraft: View {
    let match: CommonGroundMatch
    let onShare: () -> Void

    private var text: String {
        let topics = match.shared.map(\.topic)
        let title = topics.first ?? match.theyBring.first?.topic ?? "Working together"
        var lines = [title]
        if topics.count > 1 {
            lines += ["", "Shared: " + topics.joined(separator: ", ")]
        }
        let mine = match.youBring.prefix(2).map(\.topic)
        let theirs = match.theyBring.prefix(2).map(\.topic)
        if !mine.isEmpty || !theirs.isEmpty {
            lines.append("")
            if !mine.isEmpty { lines.append("You: " + mine.joined(separator: ", ")) }
            if !theirs.isEmpty { lines.append("\(match.person.name): " + theirs.joined(separator: ", ")) }
        }
        if !match.nextStep.isEmpty {
            lines += ["", "First step: " + match.nextStep]
        }
        return lines.joined(separator: "\n")
    }

    var body: some View {
        VStack(spacing: 16) {
            Text("Joint idea")
                .font(.headline)
                .padding(.top, 22)
            CommonGroundSection {
                Text(text)
                    .font(.subheadline)
                    .padding(SessionDetailMetrics.rowHorizontalInset)
            }
            Spacer(minLength: 0)
            Button("Share with \(match.person.name)", action: onShare)
                .buttonStyle(CommonGroundPrimaryButtonStyle())
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .background(Color(uiColor: .systemGroupedBackground))
    }
}

// MARK: - Pieces

/// Grouped section like the info page's, with a tighter corner radius.
private struct CommonGroundSection<Content: View>: View {
    var title: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    Color(uiColor: .secondarySystemGroupedBackground),
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct CommonGroundAvatar: View {
    let person: CommonGroundPerson
    var size: CGFloat = 40
    /// Opaque backing and a ring, for avatars that overlap.
    var ringed = false

    var body: some View {
        let shape = Circle()
        IdentityAvatar(name: person.name, imageSource: nil, kind: .person, size: size, seed: person.id)
            .clipShape(shape)
            .background(Color(uiColor: .systemBackground), in: shape)
            .overlay { if ringed { shape.stroke(Color(uiColor: .systemBackground), lineWidth: 3) } }
    }
}

/// The room's would-be group: member avatars as circles in a grid.
private struct CommonGroundStack: View {
    let people: [CommonGroundPerson]
    var size: CGFloat = 36

    var body: some View {
        let shown = Array(people.prefix(9))
        let columns = shown.count <= 1 ? 1 : shown.count <= 4 ? 2 : 3
        let gap = columns == 1 ? 0 : max(2, size * 0.04)
        let tile = (size - gap * CGFloat(columns - 1)) / CGFloat(columns)
        ZStack {
            VStack(spacing: gap) {
                ForEach(0..<((shown.count + columns - 1) / columns), id: \.self) { row in
                    HStack(spacing: gap) {
                        ForEach(shown[(row * columns)..<min(shown.count, row * columns + columns)]) { person in
                            IdentityAvatar(name: person.name, imageSource: nil, kind: .person, size: tile, seed: person.id)
                                .clipShape(Circle())
                        }
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Contacts-style rows inside a grouped section.
private struct CommonGroundPeopleRows: View {
    struct Entry: Identifiable {
        let person: CommonGroundPerson
        let subtitle: String
        let score: Int?
        var id: String { person.id }

        init(_ ranked: CommonGroundRanked) {
            person = ranked.person
            subtitle = ranked.headline.isEmpty ? ranked.person.lab : ranked.headline
            score = ranked.score
        }

        init(person: CommonGroundPerson, isMe: Bool) {
            self.person = person
            subtitle = isMe ? "You" : person.lab
            score = nil
        }
    }

    let entries: [Entry]
    let onSelect: ((CommonGroundPerson) -> Void)?

    var body: some View {
        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
            if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 52) }
            if let onSelect {
                Button { onSelect(entry.person) } label: { row(entry) }
                    .buttonStyle(SessionRowButtonStyle())
            } else {
                row(entry)
            }
        }
    }

    private func row(_ entry: Entry) -> some View {
        HStack(spacing: 12) {
            CommonGroundAvatar(person: entry.person, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.person.name).font(.headline).foregroundStyle(.primary)
                Text(entry.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if let score = entry.score {
                Text("\(score)%")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if onSelect != nil {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
        .contentShape(Rectangle())
    }
}

private struct CommonGroundPulse: View {
    let me: CommonGroundPerson
    let partner: CommonGroundPerson?
    @State private var animate = false

    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .stroke([KordiTheme.brandPink, KordiTheme.brandCyan, KordiTheme.brandAmber][index].opacity(0.45), lineWidth: 1.5)
                    .frame(width: 120, height: 120)
                    .scaleEffect(animate ? 2.5 : 0.8)
                    .opacity(animate ? 0 : 1)
                    .animation(.easeOut(duration: 2.4).repeatForever(autoreverses: false).delay(Double(index) * 0.8), value: animate)
                    .opacity(partner == nil ? 1 : 0)
            }
            HStack(spacing: -14) {
                CommonGroundAvatar(person: me, size: 92, ringed: true)
                if let partner {
                    CommonGroundAvatar(person: partner, size: 92, ringed: true)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .shadow(color: .black.opacity(0.08), radius: 10, y: 4)
        }
        .frame(height: 280)
        .onAppear { animate = true }
    }
}

/// Two overlapping avatars with the match score on a tinted capsule.
private struct CommonGroundMatchBadge: View {
    let me: CommonGroundPerson
    let person: CommonGroundPerson
    let score: Int

    var body: some View {
        HStack(spacing: -14) {
            CommonGroundAvatar(person: me, size: 80, ringed: true)
            CommonGroundAvatar(person: person, size: 80, ringed: true)
        }
        .overlay(alignment: .bottom) {
            Text("\(score)% match")
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(commonGroundTint, in: Capsule())
                .overlay(Capsule().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                .offset(y: 12)
        }
        .padding(.bottom, 12)
    }
}

/// Small topic capsule with its icon colour.
private struct CommonGroundTopicPill: View {
    let topic: String
    /// Gray fill and faint icon, for topics with no recent evidence.
    var muted = false

    var body: some View {
        let style = commonGroundStyle(for: topic)
        HStack(spacing: 5) {
            Image(systemName: style.symbol)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(muted ? Color(uiColor: .tertiaryLabel) : style.color)
            Text(topic)
                .font(.caption.weight(.medium))
                .foregroundStyle(muted ? .secondary : .primary)
                .lineLimit(1)
        }
        .padding(.horizontal, 9)
        .frame(height: 26)
        .background(muted ? Color(uiColor: .tertiarySystemFill) : style.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

private struct CommonGroundThinking: View {
    let steps: [String]
    /// Runs while the steps cycle; the last step holds until it finishes.
    let work: @MainActor () async -> Void
    @State private var index = 0

    var body: some View {
        VStack(spacing: 14) {
            KordiMark(size: 72, colorRelay: true)
            Text(steps[min(index, steps.count - 1)])
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .contentTransition(.opacity)
        }
        .frame(maxWidth: .infinity)
        .task {
            let stepper = Task { @MainActor in
                for step in steps.indices {
                    withAnimation { index = step }
                    try? await Task.sleep(for: .seconds(0.75))
                }
            }
            await work()
            stepper.cancel()
        }
    }
}

/// The login screen's primary button: a full-width dark capsule.
private struct CommonGroundPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(KordiTheme.loginPrimaryText)
            .background(KordiTheme.loginPrimaryFill, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.42)
    }
}

private struct CommonGroundToast: View {
    @Binding var text: String?

    var body: some View {
        Group {
            if let text {
                Text(text)
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .sessionGlass(in: Capsule())
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task(id: text) {
                        try? await Task.sleep(for: .seconds(1.6))
                        withAnimation { self.text = nil }
                    }
            }
        }
        .padding(.bottom, 24)
        .animation(.snappy, value: text)
    }
}
#endif
