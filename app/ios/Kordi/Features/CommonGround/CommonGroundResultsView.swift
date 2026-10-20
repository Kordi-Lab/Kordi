import SwiftUI

private enum CommonGroundRoomTab: String, CaseIterable, Identifiable {
    case people = "People"
    case topics = "Topics"
    var id: Self { self }
}

/// Room results: the suggested group, people ranked by match, shared topics,
/// and the groups started from this room.
struct CommonGroundResultsView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.commonGroundOpenConversation) private var openConversation
    let code: String
    @Binding var path: [CommonGroundRoute]
    @State private var tab = CommonGroundRoomTab.people
    @State private var startsGroup = false

    private var results: CommonGroundResults? { model.results[code] }
    private var room: CommonGroundRoom? { model.rooms[code] }
    private var members: [CommonGroundPerson] { room?.members ?? results?.people.map(\.person) ?? [] }

    var body: some View {
        let topics = results?.topics ?? []
        CommonGroundPage(onBack: { path = [] }) {
            CommonGroundHero(title: room?.title ?? "Room \(code)", status: status(topics: topics.count)) {
                CommonGroundStack(people: [model.me] + members, size: 92)
            } actions: {
                CommonGroundActions(columns: 3) {
                    SessionProfileActionButton(title: "Start group", symbol: "person.3", tint: commonGroundTint) {
                        startsGroup = true
                    }
                    .disabled(members.isEmpty)
                    ShareLink(item: code) {
                        SessionProfileActionLabel(title: "Share code", symbol: "square.and.arrow.up", tint: commonGroundTint, isSelected: false)
                    }
                    .buttonStyle(.plain)
                    SessionProfileActionButton(title: "Leave", symbol: "rectangle.portrait.and.arrow.right", tint: commonGroundTint) {
                        Task {
                            await model.leaveRoom(code)
                            path = []
                        }
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
            }
            .padding(.horizontal, 16)
        }
        .task(id: results?.status) {
            if results == nil { await model.loadResults(code, quiet: true) }
            await model.waitForResults(code)
        }
        .task { if room == nil { await model.refreshRoom(code) } }
        .sheet(isPresented: $startsGroup) {
            CommonGroundStartGroupSheet(
                defaultName: results?.suggestion?.label ?? room?.title ?? "Room \(code)",
                people: members,
                preselected: Set(results?.suggestion?.people.map(\.accountId) ?? [])
            ) { name, ids in
                guard let created = await model.createGroup(code: code, name: name, memberIds: ids) else { return false }
                await openGroup(created.group.groupSpaceId, conversationId: created.group.conversationId)
                return true
            }
            .environmentObject(model)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private func status(topics: Int) -> String {
        if results?.isMatching == true { return "Finding common ground" }
        if results?.status == "failed" { return "Matching failed for some people" }
        return "\(members.count + 1) people · \(topics) shared topics"
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
                Button("Start group") { startsGroup = true }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
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
                        Button("Join") { Task { await join(invitation) } }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(model.busy == "invite:\(invitation.invitationRef)")
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
                            if group.memberCount > 0 {
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

    private func join(_ invitation: CommonGroundInvitation) async {
        guard let joined = await model.joinInvitation(code: code, invitationRef: invitation.invitationRef) else { return }
        await openGroup(joined.groupSpaceId, conversationId: joined.conversationId)
    }

    private func openGroup(_ groupSpaceId: String, conversationId: String?) async {
        if let conversation = await appModel.commonGroundConversation(groupSpaceId: groupSpaceId, conversationId: conversationId) {
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
