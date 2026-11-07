import SwiftUI

extension AppModel {
    /// The Personal agent rows of the Agents tab (#2091).
    func personalAgentRows(searchText: String = "") -> [ConversationSummary] {
        PersonalAgentSessionCatalog.rows(
            conversations: conversations,
            personalAgents: personalAgents,
            ownAccountId: account?.accountId ?? "",
            activeOwnedAgentIds: loadedActiveOwnedAgentIds,
            searchText: searchText
        )
    }
}

/// The Personal agent section above Pinned and Recents: one always-online
/// session per owned agent. Rows offer read state and mute only.
struct PersonalAgentSection: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let searchQuery: String
    @Binding var isCollapsed: Bool
    let onOpen: (ConversationSummary) -> Void

    @State private var status: CloudPersonalAgentStatus?
    @State private var showsStatusPage = false

    var body: some View {
        let rows = model.personalAgentRows(searchText: searchQuery)
        VStack(alignment: .leading, spacing: 0) {
            if let status {
                // The status entry stands in for the section header, as on the Mac.
                if searchQuery.isEmpty { statusEntry(status) }
                ForEach(rows) { row($0) }
            } else if !rows.isEmpty {
                Button {
                    isCollapsed.toggle()
                } label: {
                    HStack(spacing: 7) {
                        Text("Personal agent")
                        Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                            .font(.caption2)
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 44 : 32, alignment: .leading)
                    .padding(.horizontal, 16)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isHeader)
                .accessibilityValue(isCollapsed ? "Collapsed" : "Expanded")
                if !isCollapsed || !searchQuery.isEmpty {
                    ForEach(rows) { row($0) }
                }
            } else {
                Color.clear.frame(height: 0)
            }
        }
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .task(id: model.account?.accountId) {
            status = await model.defaultPersonalAgentStatus()
            if ProcessInfo.processInfo.arguments.contains("--preview-personal-agent-page"), status != nil {
                showsStatusPage = true
            }
        }
        .sheet(isPresented: $showsStatusPage) {
            PersonalAgentStatusPage(status: $status)
        }
    }

    /// One status line for the owner's default agent: Not set up, Off, or
    /// what it watches. It opens the status page.
    private func statusEntry(_ status: CloudPersonalAgentStatus) -> some View {
        let live = status.connected && status.proactive
        return Button {
            showsStatusPage = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(live ? Color.green : Color.secondary)
                    .frame(width: PersonalAgentRow.avatarSize, height: PersonalAgentRow.avatarSize)
                    .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Personal agent")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(status.statusLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 58 : 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Personal agent, \(status.statusLine)")
        .accessibilityIdentifier("personal-agent-entry")
    }

    private func row(_ conversation: ConversationSummary) -> some View {
        let isMuted = model.mutedSessionIds.contains(conversation.sessionId)
        let actions = PersonalAgentRowAction.available(isUnread: conversation.hasUnreadAttention, isMuted: isMuted)
        return Button {
            onOpen(conversation)
        } label: {
            PersonalAgentRow(conversation: conversation, isMuted: isMuted)
        }
        .buttonStyle(.plain)
        .contextMenu {
            ForEach(actions, id: \.self) { action in
                Button {
                    perform(action, on: conversation)
                } label: {
                    Label(action.title, systemImage: action.systemImage)
                }
            }
        }
        .accessibilityActions {
            ForEach(actions, id: \.self) { action in
                Button(action.title) { perform(action, on: conversation) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color(uiColor: .separator).opacity(0.45))
                .frame(height: 0.5)
                .padding(.leading, PersonalAgentRow.separatorLeading)
        }
    }

    private func perform(_ action: PersonalAgentRowAction, on conversation: ConversationSummary) {
        Task {
            switch action {
            case .markRead:
                await model.markConversationRead(conversation)
            case .markUnread:
                _ = await model.setConversationUnread(conversation, unread: true)
            case .mute, .unmute:
                _ = await model.setConversationMuted(conversation, muted: action == .mute)
            }
        }
    }
}

struct PersonalAgentRow: View {
    static let avatarSize: CGFloat = 32
    static let separatorLeading: CGFloat = 16 + avatarSize + 10

    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let conversation: ConversationSummary
    var isMuted = false

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            PersonalAgentAvatar(conversation: conversation, size: Self.avatarSize)
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(PersonalAgentSessionCatalog.name(of: conversation))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                            .layoutPriority(1)
                        ChatListStateIndicators(isPinned: false, isMuted: isMuted)
                    }
                    BlobEmojiPreviewText(text: PersonalAgentSessionCatalog.preview(of: conversation))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 1)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(chatListTimestamp(conversation.lastActivityAt))
                        .font(.caption2)
                        .foregroundStyle(conversation.hasUnreadAttention && !isMuted ? chatTheme.accent : .secondary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                    if conversation.hasUnreadAttention {
                        ConversationAttentionBadge(
                            unreadCount: conversation.unreadCount,
                            mentionCount: conversation.unreadMentionCount,
                            isMuted: isMuted
                        )
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: dynamicTypeSize.isAccessibilitySize ? 58 : 44, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Double-tap to open. Touch and hold for more actions.")
    }

    private var accessibilityLabel: String {
        let unread = conversation.unreadCount > 0 ? ", \(conversation.unreadCount) unread" : ""
        let preview = BlobEmojiComposerText.plainText(PersonalAgentSessionCatalog.preview(of: conversation))
        return "\(PersonalAgentSessionCatalog.name(of: conversation)), \(PersonalAgentPresentation.onlineStatus)\(unread)"
            + ChatListStateIndicators.accessibilitySuffix(isPinned: false, isMuted: isMuted)
            + ". \(preview)"
    }
}

/// An agent's rounded-square avatar for a personal session.
struct PersonalAgentAvatar: View {
    let conversation: ConversationSummary
    var size: CGFloat = PersonalAgentRow.avatarSize

    var body: some View {
        IdentityAvatar(
            name: PersonalAgentSessionCatalog.name(of: conversation),
            imageSource: conversation.avatarSource,
            kind: .agent,
            size: size,
            seed: conversation.agentId?.nonEmpty ?? conversation.sessionId
        )
        .accessibilityHidden(true)
    }
}

/// The owner's Personal agent: the default agent watching the connectors
/// granted to it. Not set up without a connector; otherwise an On/Off
/// switch, what it watches, and what it shared.
struct PersonalAgentStatusPage: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    @Binding var status: CloudPersonalAgentStatus?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var showsConnectors = false

    private var connectorsClient: (any ConnectorsClient)? {
        if model.isPreviewMode { return PreviewConnectorsClient() }
        return ConnectorsAvailability.makeClient(
            connectorsVersion: model.connectorsVersion,
            cloudClient: model.cloudConnectorsClient
        )
    }

    var body: some View {
        NavigationStack {
            SettingsPage {
                header
                if let status {
                    if !status.connected {
                        notSetUp
                    } else {
                        Text(pageStatus(status))
                            .font(SettingsFont.subtitle)
                            .foregroundStyle(status.proactive ? Color.green : Color.secondary)
                            .padding(.vertical, 6)
                        if let errorMessage {
                            Text(errorMessage)
                                .font(SettingsFont.subtitle)
                                .foregroundStyle(KordiTheme.destructiveText)
                        }
                        SettingsSectionTitle("Watching")
                        ForEach(status.sources, id: \.connectorId) { source in
                            SettingsRow {
                                if let provider = ConnectorProviderId(rawValue: source.provider) {
                                    ConnectorLogo(providerId: provider, size: 20)
                                } else {
                                    Image(systemName: "powerplug")
                                }
                                Text(providerName(source.provider)).font(SettingsFont.rowTitle)
                            }
                            .opacity(status.proactive ? 1 : 0.5)
                        }
                        if connectorsClient != nil {
                            Button { showsConnectors = true } label: {
                                SettingsRow {
                                    Text("Manage connectors").font(SettingsFont.rowTitle).foregroundStyle(.primary)
                                } trailing: {
                                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                        if !status.recent.isEmpty {
                            SettingsSectionTitle("Recent").padding(.top, 10)
                            ForEach(status.recent, id: \.self) { share in
                                SettingsRow {
                                    Text(share.text).font(SettingsFont.rowTitle).lineLimit(2)
                                } trailing: {
                                    Text(timeLabel(share.at)).font(SettingsFont.subtitle).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .navigationTitle("Personal agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(isPresented: $showsConnectors) {
                if let connectorsClient {
                    ConnectorsSettingsView(
                        client: connectorsClient,
                        isPreview: connectorsClient is PreviewConnectorsClient
                    )
                }
            }
            .task {
                if let latest = await model.defaultPersonalAgentStatus() { status = latest }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.title3.weight(.semibold))
                .foregroundStyle(status?.proactive == true && status?.connected == true ? Color.green : Color.secondary)
                .frame(width: 40, height: 40)
                .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 10))
            Text("Personal agent").font(SettingsFont.headerTitle)
            Spacer(minLength: 8)
            if let status {
                Toggle("Personal agent", isOn: Binding(get: { status.proactive }, set: setProactive))
                    .labelsHidden()
                    .disabled(!status.connected || isSaving)
                    .accessibilityIdentifier("personal-agent-toggle")
            }
        }
        .padding(.vertical, 8)
    }

    private var notSetUp: some View {
        VStack(spacing: 14) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(.secondary)
                .frame(width: 64, height: 64)
                .background(Color(uiColor: .secondarySystemBackground), in: .circle)
            Text("Add a connector to turn it on.")
                .font(SettingsFont.rowTitle)
                .foregroundStyle(.secondary)
            if connectorsClient != nil {
                Button {
                    showsConnectors = true
                } label: {
                    Label("Connect", systemImage: "powerplug")
                        .font(SettingsFont.action)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("personal-agent-connect")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 48)
    }

    private func setProactive(_ proactive: Bool) {
        guard let current = status, current.connected, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        Task {
            switch await model.setDefaultPersonalAgentProactive(proactive) {
            case .success(let next):
                if let next { status = next }
            case .failure(let error):
                errorMessage = error.message.nonEmpty ?? "Could not update Personal agent."
            }
            isSaving = false
        }
    }

    private func providerName(_ provider: String) -> String {
        ConnectorProviderId(rawValue: provider).map { ConnectorsModel.definition($0).name } ?? provider
    }

    private func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    private func timeLabel(_ value: String) -> String {
        guard let date = date(value) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    /// Off, or what it watches and when it last looked.
    private func pageStatus(_ status: CloudPersonalAgentStatus) -> String {
        guard status.proactive else { return "Off" }
        var parts = [status.statusLine]
        if let checked = date(status.checkedAt) {
            let minutes = max(0, Int(Date().timeIntervalSince(checked) / 60))
            parts.append(minutes < 1 ? "checked just now" : minutes < 60 ? "checked \(minutes) min ago" : "checked at \(checked.formatted(date: .omitted, time: .shortened))")
        }
        return parts.joined(separator: " · ")
    }
}
