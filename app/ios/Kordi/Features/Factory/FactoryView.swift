import SwiftUI

struct FactoryView: View {
    @EnvironmentObject private var model: AppModel
    @State private var searchText = ""
    @State private var presentedSheet: FactorySheet?
    @State private var librarySection = FactoryLibrarySection.skill
    @State private var previewWorkspace: FactoryWorkspace?

    private var agents: [CloudAgent] {
        model.ownedAgents
            .filter { agent in
                let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !query.isEmpty else { return true }
                return agent.name.localizedCaseInsensitiveContains(query)
                    || agent.role.localizedCaseInsensitiveContains(query)
                    || agent.description?.localizedCaseInsensitiveContains(query) == true
            }
            .sorted {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
    }

    private var libraryArtifacts: [FactoryLibraryArtifact] {
        artifacts(for: librarySection)
            .filter { artifact in
                let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !query.isEmpty else { return true }
                return artifact.name.localizedCaseInsensitiveContains(query)
                    || artifact.description.localizedCaseInsensitiveContains(query)
            }
    }

    var body: some View {
        factoryHome
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.refreshFactory() }
#if DEBUG
        .task {
            await Task.yield()
            previewWorkspace = FactoryWorkspace.previewSelection
        }
#endif
        .navigationDestination(for: FactoryWorkspace.self) { workspace in
            workspacePage(workspace)
        }
#if DEBUG
        .navigationDestination(item: $previewWorkspace) { workspace in
            workspacePage(workspace)
        }
#endif
        .navigationDestination(for: CloudAgent.self) { agent in
            AgentEditorView(agentID: agent.agentId)
        }
        .navigationDestination(for: ConversationSummary.self) { conversation in
            ConversationView(conversation: conversation)
        }
        .navigationDestination(for: FactoryLibraryArtifact.self) { artifact in
            FactoryLibraryArtifactView(artifact: artifact)
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .account:
                AccountSheet()
            case .create:
                CreateAgentSheet()
            }
        }
    }

    private var factoryHome: some View {
        List {
            Section {
                ForEach(FactoryWorkspace.allCases) { workspace in
                    NavigationLink(value: workspace) {
                        FactoryWorkspaceRow(workspace: workspace)
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollBounceBehavior(.always)
        .refreshable { await model.refreshFactory() }
        .onAppear { searchText = "" }
        .toolbar {
            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .topBarLeading) {
                    accountButton
                }
                .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarLeading) {
                    accountButton
                }
            }

            if #available(iOS 26.0, *) {
                ToolbarItem(placement: .topBarTrailing) {
                    createButton
                }
                .sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    createButton
                }
            }
        }
    }

    @ViewBuilder
    private func workspacePage(_ workspace: FactoryWorkspace) -> some View {
        VStack(spacing: 0) {
            workspaceHeader(workspace)
            workspaceContent(workspace)
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle(workspace.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func workspaceContent(_ workspace: FactoryWorkspace) -> some View {
        switch workspace {
        case .build:
            buildList
        case .agents:
            agentList
        case .library:
            libraryList
        }
    }

    @ViewBuilder
    private func workspaceHeader(_ workspace: FactoryWorkspace) -> some View {
        switch workspace {
        case .build, .agents:
            KordiPageSearchHeader(
                text: $searchText,
                prompt: "Search agents",
                accessibilityLabel: "Search agents"
            ) {
                EmptyView()
            }
        case .library:
            KordiPageSearchHeader(
                text: $searchText,
                prompt: "Search \(librarySection.pluralLabel.lowercased())",
                accessibilityLabel: "Search Factory Library"
            ) {
                Picker("Library section", selection: $librarySection) {
                    ForEach(FactoryLibrarySection.allCases) { section in
                        Text(section.label).tag(section)
                    }
                }
                .pickerStyle(.segmented)
            }
        }
    }

    private var buildList: some View {
        List {
            Section {
                Button {
                    presentedSheet = .create
                } label: {
                    FactoryBuildCard()
                }
                .buttonStyle(.plain)
                .kordiListRow()
            }

            if !agents.isEmpty {
                Section("Agents") {
                    ForEach(Array(agents.prefix(3))) { agent in
                        NavigationLink(value: agent) {
                            FactoryAgentRow(agent: agent)
                        }
                        .kordiListRow()
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollBounceBehavior(.always)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await model.refreshFactory() }
    }

    private var agentList: some View {
        List {
            if agents.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No agents yet" : "No agents found",
                    systemImage: searchText.isEmpty ? "wand.and.stars" : "magnifyingglass"
                )
                .listRowSeparator(.hidden)
            } else {
                ForEach(agents) { agent in
                    NavigationLink(value: agent) {
                        FactoryAgentRow(agent: agent)
                    }
                    .kordiListRow()
                }
            }
        }
        .listStyle(.plain)
        .scrollBounceBehavior(.always)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await model.refreshFactory() }
    }

    private var libraryList: some View {
        List {
            if libraryArtifacts.isEmpty {
                ContentUnavailableView(
                    searchText.isEmpty ? "No \(librarySection.pluralLabel.lowercased())" : "No library items found",
                    systemImage: searchText.isEmpty ? librarySection.symbol : "magnifyingglass"
                )
                .listRowSeparator(.hidden)
            } else {
                ForEach(libraryArtifacts) { artifact in
                    NavigationLink(value: artifact) {
                        FactoryCapabilityRow(artifact: artifact)
                    }
                    .kordiListRow()
                }
            }
        }
        .listStyle(.plain)
        .scrollBounceBehavior(.always)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await model.refreshFactory() }
    }

    private func artifacts(for section: FactoryLibrarySection) -> [FactoryLibraryArtifact] {
        var indexed: [String: FactoryLibraryArtifact] = [:]

        for agent in model.ownedAgents {
            switch section {
            case .skill:
                for skill in agent.skills {
                    let key = skill.name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
                    var artifact = indexed[key] ?? FactoryLibraryArtifact(
                        kind: .skill,
                        name: skill.name,
                        description: skill.description,
                        content: skill.content
                    )
                    if artifact.description.isEmpty { artifact.description = skill.description }
                    if artifact.content?.nonEmpty == nil { artifact.content = skill.content }
                    indexed[key] = artifact
                }
            case .tool:
                for name in agent.modelRouting.tools ?? [] {
                    let key = name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
                    let artifact = indexed[key] ?? FactoryLibraryArtifact(
                        kind: .tool,
                        name: name,
                        description: "",
                        content: nil
                    )
                    indexed[key] = artifact
                }
            case .plugin:
                for name in agent.modelRouting.plugins ?? [] {
                    let key = name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
                    let artifact = indexed[key] ?? FactoryLibraryArtifact(
                        kind: .plugin,
                        name: name,
                        description: "",
                        content: nil
                    )
                    indexed[key] = artifact
                }
            }
        }

        return indexed.values.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private var accountButton: some View {
        Button {
            presentedSheet = .account
        } label: {
            IdentityAvatar(
                name: model.account?.preferredName ?? "Me",
                imageSource: model.account?.avatarUrl.nonEmpty,
                kind: .person,
                size: 32,
                seed: model.account?.accountId
            )
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Account settings")
    }

    private var createButton: some View {
        Button {
            presentedSheet = .create
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Create agent")
    }
}

private enum FactorySheet: String, Identifiable {
    case account
    case create

    var id: Self { self }
}

private enum FactoryWorkspace: String, CaseIterable, Identifiable, Hashable {
    case build
    case agents
    case library

    var id: Self { self }

    var title: String {
        switch self {
        case .build: "Build"
        case .agents: "Agents"
        case .library: "Library"
        }
    }

    var symbol: String {
        switch self {
        case .build: "hammer"
        case .agents: "person.2"
        case .library: "books.vertical"
        }
    }

#if DEBUG
    static var previewSelection: Self? {
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--preview-factory-library") { return .library }
        if arguments.contains("--preview-factory-agents") { return .agents }
        if arguments.contains("--preview-factory-build") { return .build }
        return nil
    }
#endif
}

private enum FactoryLibrarySection: String, CaseIterable, Identifiable, Hashable {
    case skill
    case tool
    case plugin

    var id: Self { self }

    var label: String {
        switch self {
        case .skill: "Skills"
        case .tool: "Tools"
        case .plugin: "Plugins"
        }
    }

    var pluralLabel: String { label }

    var symbol: String {
        switch self {
        case .skill: "puzzlepiece.extension.fill"
        case .tool: "wrench.and.screwdriver.fill"
        case .plugin: "shippingbox.fill"
        }
    }
}

private struct FactoryLibraryArtifact: Identifiable, Hashable {
    let kind: FactoryLibrarySection
    let name: String
    var description: String
    var content: String?

    var id: String { "\(kind.rawValue):\(name.lowercased())" }
}

private struct FactoryLibraryArtifactView: View {
    let artifact: FactoryLibraryArtifact

    var body: some View {
        List {
            Section("Overview") {
                LabeledContent("Type", value: artifact.kind.rawValue.capitalized)
                if let description = artifact.description.nonEmpty {
                    Text(description)
                }
            }

            if let content = artifact.content?.nonEmpty {
                Section("Instructions") {
                    Text(content)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(artifact.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct FactoryBuildCard: View {
    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: "hammer")
                .font(.title3.weight(.regular))
                .foregroundStyle(.primary)
                .symbolRenderingMode(.monochrome)
                .frame(width: 44, height: 44)

            Text("New Agent")
                .font(.headline)

            Spacer(minLength: 4)

            Image(systemName: "plus.circle.fill")
                .font(.title3)
                .foregroundStyle(KordiTheme.signalBlue)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("New Agent")
    }
}

private struct FactoryWorkspaceRow: View {
    let workspace: FactoryWorkspace

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: workspace.symbol)
                .font(.body.weight(.regular))
                .foregroundStyle(.primary)
                .symbolRenderingMode(.monochrome)
                .frame(width: 28, height: 44)

            Text(workspace.title)
                .font(.body)
        }
        .frame(minHeight: 50)
        .accessibilityElement(children: .combine)
    }
}

private struct FactoryCapabilityRow: View {
    let artifact: FactoryLibraryArtifact

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: artifact.kind.symbol)
                .font(.title3.weight(.regular))
                .foregroundStyle(.primary)
                .symbolRenderingMode(.monochrome)
                .frame(width: 44, height: 44)

            Text(artifact.name)
                .font(.headline)
                .lineLimit(1)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct FactoryAgentRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let agent: CloudAgent

    var body: some View {
        HStack(spacing: 11) {
            IdentityAvatar(
                name: agent.name,
                imageSource: agent.avatarUrl.nonEmpty,
                kind: .agent,
                size: avatarSize,
                seed: agent.agentId
            )

            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name)
                    .font(.headline)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    .fixedSize(horizontal: false, vertical: dynamicTypeSize.isAccessibilitySize)
                Text(agent.role)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(agent.name), \(agent.role)")
    }

    private var avatarSize: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 52 : 44
    }
}

private struct CreateAgentSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @State private var draft = CloudAgentDraft()
    @State private var isSaving = false
    @State private var showsError = false
    @State private var errorMessage = ""

    var body: some View {
        NavigationStack {
            Form {
                AgentEditorForm(draft: $draft)
            }
            .navigationTitle("Create Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Creating…" : "Create", action: createAgent)
                        .disabled(!draft.isValid || isSaving)
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .alert("Couldn’t create agent", isPresented: $showsError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage)
        }
    }

    private func createAgent() {
        guard !isSaving, draft.isValid else { return }
        isSaving = true
        Task {
            if await model.createAgent(draft) != nil {
                dismiss()
            } else {
                errorMessage = model.errorMessage ?? "Check the fields and try again."
                showsError = true
            }
            isSaving = false
        }
    }
}

private struct AgentEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    let agentID: String

    @State private var draft = CloudAgentDraft()
    @State private var originalDraft = CloudAgentDraft()
    @State private var isLoaded = false
    @State private var isSaving = false
    @State private var isDeleting = false
    @State private var showsDeleteConfirmation = false
    @State private var showsError = false
    @State private var errorTitle = ""
    @State private var errorMessage = ""

    private var isDirty: Bool { isLoaded && draft != originalDraft }
    private var currentAgent: CloudAgent? { model.ownedAgent(id: agentID) }
    private var agentConversations: [ConversationSummary] {
        model.conversations
            .filter { $0.kind == .agent && $0.agentId == agentID }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    var body: some View {
        Group {
            if isLoaded {
                Form {
                    if !agentConversations.isEmpty {
                        Section("Conversations") {
                            ForEach(agentConversations) { conversation in
                                NavigationLink(value: conversation) {
                                    Label {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(conversation.displayName)
                                            Text(conversation.lastMessage)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                    } icon: {
                                        Image(systemName: "bubble.left.and.bubble.right.fill")
                                            .foregroundStyle(KordiTheme.agentViolet)
                                    }
                                }
                            }
                        }
                    }

                    AgentEditorForm(draft: $draft)

                    if let agent = currentAgent {
                        Section("Cloud record") {
                            LabeledContent("Status", value: (agent.status ?? "active").capitalized)
                            if let updated = formattedCloudDate(agent.updatedAt) {
                                LabeledContent("Updated", value: updated)
                            }
                            if let created = formattedCloudDate(agent.createdAt) {
                                LabeledContent("Created", value: created)
                            }
                            LabeledContent("Agent ID") {
                                Text(agent.agentId)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                                    .lineLimit(1)
                            }
                        }
                    }

                    Section {
                        Button("Delete Agent", role: .destructive) {
                            showsDeleteConfirmation = true
                        }
                        .disabled(isSaving || isDeleting)
                    }
                }
            } else {
                ContentUnavailableView(
                    "Agent unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text("Return to Factory and refresh the agent list.")
                )
            }
        }
        .navigationTitle(isLoaded ? draft.name : "Agent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : "Save", action: saveAgent)
                    .disabled(!draft.isValid || !isDirty || isSaving || isDeleting)
            }
        }
        .onAppear(perform:loadAgent)
        .interactiveDismissDisabled(isSaving || isDeleting)
        .confirmationDialog(
            "Delete \(draft.name)?",
            isPresented: $showsDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete Agent", role: .destructive, action: deleteAgent)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the agent from your Cloud account.")
        }
        .alert(errorTitle, isPresented: $showsError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage)
        }
    }

    private func loadAgent() {
        guard !isLoaded, let agent = model.ownedAgent(id: agentID) else { return }
        let loaded = CloudAgentDraft(agent: agent)
        draft = loaded
        originalDraft = loaded
        isLoaded = true
    }

    private func saveAgent() {
        guard draft.isValid, isDirty, !isSaving else { return }
        isSaving = true
        Task {
            if let updated = await model.updateAgent(id: agentID, draft: draft) {
                let saved = CloudAgentDraft(agent: updated)
                draft = saved
                originalDraft = saved
            } else {
                presentError(
                    title: "Couldn’t save agent",
                    message: model.errorMessage ?? "Check the fields and try again."
                )
            }
            isSaving = false
        }
    }

    private func deleteAgent() {
        guard !isDeleting else { return }
        isDeleting = true
        Task {
            if await model.archiveAgent(id: agentID) {
                dismiss()
            } else {
                presentError(
                    title: "Couldn’t delete agent",
                    message: model.errorMessage ?? "Try again when the connection is available."
                )
            }
            isDeleting = false
        }
    }

    private func presentError(title: String, message: String) {
        errorTitle = title
        errorMessage = message
        showsError = true
    }

    private func formattedCloudDate(_ value: String?) -> String? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        return date?.formatted(date: .abbreviated, time: .shortened)
    }
}

private struct AgentEditorForm: View {
    @EnvironmentObject private var model: AppModel
    @Binding var draft: CloudAgentDraft

    private let maximumBoundaries = 12
    private let maximumResources = 24
    private let maximumSkills = 12
    private let maximumTools = 24
    private let maximumPlugins = 24
    private let resourceKinds = ["text", "url", "file", "creator-agent"]
    private let modelNames = [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4-mini",
        "gpt-5.4",
        "gpt-5.3-codex-spark",
    ]
    private let thinkingLevels = ["off", "default", "minimal", "low", "medium", "high", "xhigh", "max"]

    private var routes: [String] {
        let provider = model.providerAuthSnapshot?.provider.nonEmpty
        let suggested = modelNames.map { name in
            provider.map { "\($0)/\(name)" } ?? name
        }
        return ([draft.modelRouting.defaultModel, draft.modelRouting.fallbackModel]
            .compactMap { $0?.nonEmpty } + suggested)
            .reduce(into: []) { options, option in
                if !options.contains(option) { options.append(option) }
            }
    }

    private var hasStartedEditing: Bool {
        !draft.name.isEmpty
            || !draft.role.isEmpty
            || !draft.description.isEmpty
            || !draft.systemPrompt.isEmpty
            || !draft.sourceSummary.isEmpty
            || !draft.boundaries.isEmpty
            || !draft.resources.isEmpty
            || !draft.skills.isEmpty
            || !draft.tools.isEmpty
            || !draft.plugins.isEmpty
    }

    var body: some View {
        Group {
            Section {
                TextField("Name", text: $draft.name)
                    .textInputAutocapitalization(.words)
                TextField("Role", text: $draft.role, axis: .vertical)
                    .lineLimit(2...4)
                TextField("Description", text: $draft.description, axis: .vertical)
                    .lineLimit(3...6)
            } header: {
                Text("Identity")
            }

            Section {
                AgentMultilineEditor(
                    text: $draft.systemPrompt,
                    placeholder: "Describe how this agent should behave, what it should do, and its limits.",
                    minimumHeight: 180
                )
            } header: {
                Text("System prompt")
            }

            Section {
                AgentMultilineEditor(
                    text: $draft.sourceSummary,
                    placeholder: "Summarize the material, project, or knowledge this agent should draw from.",
                    minimumHeight: 110
                )
            } header: {
                Text("Source summary")
            }

            Section {
                if draft.boundaries.isEmpty {
                    Text("No boundaries configured.")
                        .foregroundStyle(.secondary)
                }

                ForEach($draft.boundaries) { $boundary in
                    TextField("Boundary", text: $boundary.value, axis: .vertical)
                        .lineLimit(2...5)
                }
                .onDelete(perform: deleteBoundaries)

                Button("Add Boundary", systemImage: "plus", action: addBoundary)
                    .disabled(draft.boundaries.count >= maximumBoundaries)
            } header: {
                Text("Boundaries")
            }

            Section {
                if draft.resources.isEmpty {
                    Text("No resources configured.")
                        .foregroundStyle(.secondary)
                }

                ForEach($draft.resources) { $resource in
                    DisclosureGroup {
                        Picker("Type", selection: $resource.kind) {
                            ForEach(resourceKinds(including: resource.kind), id: \.self) { kind in
                                Text(resourceKindLabel(kind)).tag(kind)
                            }
                        }

                        TextField(resourceValuePrompt(resource.kind), text: $resource.value, axis: .vertical)
                            .lineLimit(2...6)
                            .keyboardType(resource.kind == "url" ? .URL : .default)
                            .textInputAutocapitalization(resource.kind == "url" ? .never : .sentences)
                            .autocorrectionDisabled(resource.kind == "url" || resource.kind == "file")

                        TextField("Title (optional)", text: $resource.title)
                        TextField("Summary (optional)", text: $resource.summary, axis: .vertical)
                            .lineLimit(2...5)
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(resource.title.nonEmpty ?? resource.value.nonEmpty ?? "New resource")
                                    .lineLimit(1)
                                Text(resourceKindLabel(resource.kind))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: resourceSymbol(resource.kind))
                                .foregroundStyle(KordiTheme.agentViolet)
                        }
                    }
                }
                .onDelete(perform: deleteResources)

                Button("Add Resource", systemImage: "plus", action: addResource)
                    .disabled(draft.resources.count >= maximumResources)
            } header: {
                Text("Resources")
            }

            Section {
                if draft.skills.isEmpty {
                    Text("No suggested skills configured.")
                        .foregroundStyle(.secondary)
                }

                ForEach($draft.skills) { $skill in
                    DisclosureGroup {
                        TextField("Skill name", text: $skill.name)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        TextField("What this skill helps the agent do", text: $skill.description, axis: .vertical)
                            .lineLimit(2...5)
                        AgentMultilineEditor(
                            text: $skill.content,
                            placeholder: "Optional skill instructions or SKILL.md content",
                            minimumHeight: 100
                        )
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(skill.name.nonEmpty ?? "New skill")
                                    .lineLimit(1)
                                if let description = skill.description.nonEmpty {
                                    Text(description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                        } icon: {
                            Image(systemName: "bolt.fill")
                                .foregroundStyle(KordiTheme.agentViolet)
                        }
                    }
                }
                .onDelete(perform: deleteSkills)

                Button("Add Skill", systemImage: "plus", action: addSkill)
                    .disabled(draft.skills.count >= maximumSkills)
            } header: {
                Text("Suggested skills")
            }

            Section {
                if draft.tools.isEmpty {
                    Text("No runtime tools configured.")
                        .foregroundStyle(.secondary)
                }

                ForEach($draft.tools) { $tool in
                    TextField("Tool name", text: $tool.name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .onDelete(perform: deleteTools)

                Button("Add Tool", systemImage: "plus", action: addTool)
                    .disabled(draft.tools.count >= maximumTools)
            } header: {
                Text("Loaded tools")
            }

            Section {
                if draft.plugins.isEmpty {
                    Text("No runtime plugins configured.")
                        .foregroundStyle(.secondary)
                }

                ForEach($draft.plugins) { $plugin in
                    TextField("Plugin name", text: $plugin.name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .onDelete(perform: deletePlugins)

                Button("Add Plugin", systemImage: "plus", action: addPlugin)
                    .disabled(draft.plugins.count >= maximumPlugins)
            } header: {
                Text("Loaded plugins")
            }

            Section {
                Picker("Who can use this agent", selection: $draft.accessScope) {
                    ForEach(CloudAgentAccessScope.allCases) { scope in
                        Text(scope.label).tag(scope)
                    }
                }

            } header: {
                Text("Access")
            }

            Section {
                Picker("Default model", selection: $draft.modelRouting.defaultModel) {
                    Text("Kordi default").tag(String?.none)
                    ForEach(routes, id: \.self) { route in
                        Text(modelLabel(route)).tag(Optional(route))
                    }
                }

                Picker("Fallback model", selection: $draft.modelRouting.fallbackModel) {
                    Text("None").tag(String?.none)
                    ForEach(routes, id: \.self) { route in
                        Text(modelLabel(route)).tag(Optional(route))
                    }
                }

                Picker("Thinking level", selection: $draft.modelRouting.thinking) {
                    Text("Default").tag(String?.none)
                    ForEach(thinkingLevels, id: \.self) { level in
                        Text(thinkingLabel(level)).tag(Optional(level))
                    }
                }
            } header: {
                Text("Model routing")
            }
            .onChange(of: draft.modelRouting.defaultModel) {
                applyAuthentication(toFallback: false)
            }
            .onChange(of: draft.modelRouting.fallbackModel) {
                applyAuthentication(toFallback: true)
            }

            if hasStartedEditing, let validationMessage = draft.validationMessage {
                Section("Needs attention") {
                    Label(validationMessage, systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                }
            }
        }
    }

    private func addBoundary() {
        guard draft.boundaries.count < maximumBoundaries else { return }
        draft.boundaries.append(CloudAgentBoundaryDraft())
    }

    private func deleteBoundaries(at offsets: IndexSet) {
        draft.boundaries.remove(atOffsets: offsets)
    }

    private func addResource() {
        guard draft.resources.count < maximumResources else { return }
        draft.resources.append(CloudAgentResourceDraft())
    }

    private func deleteResources(at offsets: IndexSet) {
        draft.resources.remove(atOffsets: offsets)
    }

    private func addSkill() {
        guard draft.skills.count < maximumSkills else { return }
        draft.skills.append(CloudAgentSkillDraft())
    }

    private func deleteSkills(at offsets: IndexSet) {
        draft.skills.remove(atOffsets: offsets)
    }

    private func addTool() {
        guard draft.tools.count < maximumTools else { return }
        draft.tools.append(CloudAgentCapabilityDraft())
    }

    private func deleteTools(at offsets: IndexSet) {
        draft.tools.remove(atOffsets: offsets)
    }

    private func addPlugin() {
        guard draft.plugins.count < maximumPlugins else { return }
        draft.plugins.append(CloudAgentCapabilityDraft())
    }

    private func deletePlugins(at offsets: IndexSet) {
        draft.plugins.remove(atOffsets: offsets)
    }

    private func resourceKinds(including current: String) -> [String] {
        current.nonEmpty == nil || resourceKinds.contains(current)
            ? resourceKinds
            : resourceKinds + [current]
    }

    private func resourceKindLabel(_ kind: String) -> String {
        switch kind {
        case "url": "URL"
        case "file": "File"
        case "creator-agent": "Creator agent"
        case "text": "Text"
        default: kind.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    private func resourceSymbol(_ kind: String) -> String {
        switch kind {
        case "url": "link"
        case "file": "doc.text"
        case "creator-agent": "wand.and.stars"
        default: "text.quote"
        }
    }

    private func resourceValuePrompt(_ kind: String) -> String {
        switch kind {
        case "url": "https://example.com/docs"
        case "file": "Path or file reference"
        case "creator-agent": "Creator agent ID"
        default: "Source text or reference"
        }
    }

    private func applyAuthentication(toFallback: Bool) {
        guard let snapshot = model.providerAuthSnapshot else { return }
        let route = toFallback ? draft.modelRouting.fallbackModel : draft.modelRouting.defaultModel
        guard route?.hasPrefix("\(snapshot.provider)/") == true else { return }
        if toFallback {
            draft.modelRouting.fallbackAuthProvider = snapshot.provider
            draft.modelRouting.fallbackAuthChoice = snapshot.authChoice
        } else {
            draft.modelRouting.defaultAuthProvider = snapshot.provider
            draft.modelRouting.defaultAuthChoice = snapshot.authChoice
        }
    }

    private func modelLabel(_ value: String) -> String {
        value.split(separator: "/").last.map(String.init) ?? value
    }

    private func thinkingLabel(_ value: String) -> String {
        value == "xhigh" ? "Extra High" : value.capitalized
    }
}

private struct AgentMultilineEditor: View {
    @Binding var text: String
    let placeholder: String
    let minimumHeight: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 8)
                    .allowsHitTesting(false)
            }

            TextEditor(text: $text)
                .frame(minHeight: minimumHeight)
                .scrollContentBackground(.hidden)
        }
    }
}

#Preview("Factory") {
    NavigationStack {
        FactoryView()
    }
    .environmentObject(AppModel(previewMode: true))
    .tint(KordiTheme.signalBlue)
}
