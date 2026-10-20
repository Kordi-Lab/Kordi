import SwiftUI

private enum CommonGroundRoomTab: String, CaseIterable, Identifiable {
    case people = "People"
    case topics = "Topics"
    var id: Self { self }
}

/// What the Start group sheet opens with: a topic's name and people.
struct CommonGroundGroupDraft: Identifiable {
    let name: String
    let topic: String?
    let selected: Set<String>
    var id: String { "\(topic ?? name)|\(selected.sorted().joined(separator: ","))" }

    init(theme: CommonGroundTheme, me: String) {
        name = theme.label
        topic = theme.label
        selected = Set(theme.people.map(\.accountId).filter { $0 != me })
    }
}

/// Room results: the suggested group, people ranked by match, shared topics,
/// and the groups started from this room. A closed room is read-only.
struct CommonGroundResultsView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.commonGroundOpenConversation) private var openConversation
    let code: String
    @Binding var path: [CommonGroundRoute]
    @State private var tab = CommonGroundRoomTab.people
    @State private var draft: CommonGroundGroupDraft?

    private var results: CommonGroundResults? { model.results[code] }
    private var room: CommonGroundRoom? { model.rooms[code] }
    private var closed: Bool { model.isClosed(code) }
    private var members: [CommonGroundPerson] { room?.members ?? results?.people.map(\.person) ?? [] }

    var body: some View {
        let topics = results?.topics ?? []
        CommonGroundPage(onBack: { path = [] }) {
            CommonGroundHero(title: model.roomTitle(code), status: status(topics: topics.count)) {
                CommonGroundStack(people: [model.me] + members, size: 92)
            } actions: {
                if !closed {
                    CommonGroundActions(columns: 2) {
                        ShareLink(item: code) {
                            SessionProfileActionLabel(title: "Share code", symbol: "square.and.arrow.up", tint: commonGroundTint, isSelected: false)
                        }
                        .buttonStyle(.plain)
                        SessionProfileActionButton(title: "Leave", symbol: "rectangle.portrait.and.arrow.right", tint: commonGroundTint, action: leave)
                    }
                }
            }

            VStack(spacing: 16) {
                if let suggestion = results?.suggestion {
                    suggestionCard(suggestion)
                }
                invitationsSection
                groupsSection
                Picker("Room content", selection: $tab) {
                    ForEach(CommonGroundRoomTab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                CommonGroundSection {
                    switch tab {
                    case .people: peopleRows
                    case .topics: topicRows(topics)
                    }
                }
                if closed {
                    Button("Remove", role: .destructive, action: leave)
                        .font(.subheadline)
                        .buttonStyle(.borderless)
                        .padding(.top, 8)
                }
            }
            .padding(.horizontal, 16)
        }
        .task(id: results?.status) {
            if results == nil { await model.loadResults(code, quiet: true) }
            await model.waitForResults(code)
        }
        .task { if room == nil { await model.refreshRoom(code) } }
        .sheet(item: $draft) { draft in
            CommonGroundStartGroupSheet(
                defaultName: draft.name,
                people: sheetPeople(draft),
                preselected: draft.selected
            ) { name, ids in
                guard let created = await model.createGroup(code: code, name: name, memberIds: ids, topic: draft.topic) else { return false }
                await openGroup(created.group.groupSpaceId, conversationId: created.group.conversationId)
                return true
            }
            .environmentObject(model)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private func status(topics: Int) -> String {
        if results?.isMatching == true, !closed { return "Finding common ground" }
        if results?.status == "failed" { return "Matching failed for some people" }
        return "\(members.count + 1) people · \(topics) shared topics" + (closed ? " · Closed" : "")
    }

    private func leave() {
        Task {
            await model.leaveRoom(code)
            path = []
        }
    }

    /// Room members plus anyone in the topic the room no longer lists.
    private func sheetPeople(_ draft: CommonGroundGroupDraft) -> [CommonGroundPerson] {
        let extra = (results?.topics ?? []).flatMap(\.people)
            .filter { draft.selected.contains($0.accountId) && !members.map(\.accountId).contains($0.accountId) }
        var seen = Set<String>()
        return (members + extra).filter { $0.accountId != model.me.accountId && seen.insert($0.accountId).inserted }
    }

    private func suggestionCard(_ suggestion: CommonGroundTheme) -> some View {
        let others = suggestion.people.filter { $0.accountId != model.me.accountId }
        let includesMe = others.count < suggestion.people.count
        let names = commonGroundNameList(others.map(\.displayName))
        return CommonGroundSection(title: "Suggested group") {
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
                if !closed {
                    Button("Start group") { draft = CommonGroundGroupDraft(theme: suggestion, me: model.me.accountId) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .padding(.vertical, 10)
        }
    }

    @ViewBuilder private var invitationsSection: some View {
        let invitations = results?.invitations ?? room?.invitations ?? []
        if !invitations.isEmpty {
            CommonGroundSection(title: "Invitations") {
                ForEach(Array(invitations.enumerated()), id: \.element.id) { index, invitation in
                    if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                    HStack(spacing: 12) {
                        Text("\(invitation.from.displayName) invited you to \(invitation.name)")
                            .font(.body)
                        Spacer(minLength: 8)
                        if !closed {
                            Button("Join") { Task { await join(invitation) } }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                                .disabled(model.busy == "invite:\(invitation.invitationRef)")
                        }
                    }
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .padding(.vertical, 8)
                    .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                }
            }
        }
    }

    @ViewBuilder private var groupsSection: some View {
        let groups = results?.groups ?? room?.groups ?? []
        if !groups.isEmpty {
            CommonGroundSection(title: "Groups") {
                ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                    if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(group.name).font(.body)
                            if let topic = group.topic?.trimmingCharacters(in: .whitespaces), !topic.isEmpty {
                                Text("From \(topic)")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            } else if group.memberCount > 0 {
                                Text(group.memberCount == 1 ? "1 person" : "\(group.memberCount) people")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        if group.joined {
                            Button("Open") { Task { await openGroup(group.groupSpaceId, conversationId: group.conversationId) } }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                        }
                    }
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .padding(.vertical, 8)
                    .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                }
            }
        }
    }

    @ViewBuilder private var peopleRows: some View {
        let people = results?.people ?? []
        if people.isEmpty {
            CommonGroundRow(title: results?.isMatching == true ? "Matching" : "No matches yet")
        } else {
            CommonGroundPeopleRows(
                entries: people.map { .init(person: $0.person, subtitle: $0.headline, score: $0.score) }
            ) { path.append(.match($0.accountId)) }
        }
    }

    @ViewBuilder private func topicRows(_ topics: [CommonGroundTheme]) -> some View {
        if topics.isEmpty {
            CommonGroundRow(title: results?.isMatching == true ? "Matching" : "No shared topics yet")
        }
        ForEach(Array(topics.enumerated()), id: \.offset) { index, topic in
            if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 42) }
            HStack(spacing: 12) {
                let style = commonGroundStyle(for: topic.label)
                SessionSettingsIconTile(systemImage: style.symbol, color: style.color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(topic.label).font(.body).lineLimit(2)
                    Text("\(topic.people.count) people")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                CommonGroundStack(people: topic.people, size: 28)
                if !closed {
                    Button("Start") { draft = CommonGroundGroupDraft(theme: topic, me: model.me.accountId) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(!topic.people.contains { $0.accountId != model.me.accountId })
                }
            }
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .padding(.vertical, 8)
            .frame(minHeight: SessionDetailMetrics.rowMinHeight)
        }
    }

    private func join(_ invitation: CommonGroundInvitation) async {
        guard let joined = await model.joinInvitation(code: code, invitationRef: invitation.invitationRef) else { return }
        await openGroup(joined.groupSpaceId, conversationId: joined.conversationId)
    }

    private func openGroup(_ groupSpaceId: String, conversationId: String?) async {
        if let conversation = await appModel.commonGroundGroupConversation(groupSpaceId: groupSpaceId, conversationId: conversationId) {
            openConversation(conversation)
        } else {
            model.notice = "The group is in Chats."
        }
    }
}

/// Name and members for a new group; the suggestion is preselected.
struct CommonGroundStartGroupSheet: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    let people: [CommonGroundPerson]
    let create: (String, [String]) async -> Bool
    @State private var name: String
    @State private var selected: Set<String>

    init(defaultName: String, people: [CommonGroundPerson], preselected: Set<String>, create: @escaping (String, [String]) async -> Bool) {
        self.people = people
        self.create = create
        _name = State(initialValue: defaultName)
        _selected = State(initialValue: preselected)
    }

    var body: some View {
        VStack(spacing: 16) {
            Text("Start group")
                .font(.headline)
                .padding(.top, 22)
            ScrollView {
                VStack(spacing: 16) {
                    CommonGroundSection {
                        TextField("Group name", text: $name)
                            .font(.body)
                            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                            .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                    }
                    CommonGroundSection(title: "Members") {
                        ForEach(Array(people.enumerated()), id: \.element.id) { index, person in
                            if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset + 52) }
                            memberRow(person)
                        }
                    }
                }
            }
            Button("Create") {
                Task {
                    let ids = people.map(\.accountId).filter(selected.contains)
                    if await create(name.trimmingCharacters(in: .whitespacesAndNewlines), ids) { dismiss() }
                }
            }
            .buttonStyle(CommonGroundPrimaryButtonStyle())
            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || selected.isEmpty || model.busy == "group")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private func memberRow(_ person: CommonGroundPerson) -> some View {
        let isOn = selected.contains(person.accountId)
        return Button {
            if isOn { selected.remove(person.accountId) } else { selected.insert(person.accountId) }
        } label: {
            HStack(spacing: 12) {
                CommonGroundAvatar(person: person, size: 40)
                Text(person.displayName).font(.body).foregroundStyle(.primary)
                Spacer(minLength: 8)
                Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isOn ? commonGroundTint : Color(uiColor: .tertiaryLabel))
            }
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .padding(.vertical, 6)
            .frame(minHeight: SessionDetailMetrics.rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(SessionRowButtonStyle())
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
