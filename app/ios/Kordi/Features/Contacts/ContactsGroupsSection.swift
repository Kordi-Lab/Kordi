import SwiftUI

/// Every group chat the account has joined, newest activity first. Sits
/// between the pinned rows and the contacts and folds away from its header.
struct ContactsGroupsSection: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let spaces: [GroupSpaceSummary]
    let isSearching: Bool
    var onOpenConversation: ((ConversationSummary) -> Void)? = nil
    @State private var isCollapsed = false
    @State private var isExpanded = false

    /// Groups shown before the "Show all" row.
    static let previewLimit = 5

    /// Joined groups from the loaded chat list, filtered by name while searching.
    static func spaces(in model: AppModel, matching searchText: String) -> [GroupSpaceSummary] {
        let spaces = GroupSpaceCatalog.build(
            conversations: model.conversations,
            ownAccountId: model.account?.accountId ?? ""
        )
        guard !searchText.isEmpty else { return spaces }
        return spaces.filter { $0.displayName.localizedCaseInsensitiveContains(searchText) }
    }

    /// The first few groups, or every group while expanded or searching.
    static func visible<Item>(_ items: [Item], isExpanded: Bool, isSearching: Bool) -> [Item] {
        isExpanded || isSearching ? items : Array(items.prefix(previewLimit))
    }

    private var showsRows: Bool { isSearching || !isCollapsed }
    private var showsMoreToggle: Bool { !isSearching && spaces.count > Self.previewLimit }

    var body: some View {
        Section {
            if showsRows {
                ForEach(Self.visible(spaces, isExpanded: isExpanded, isSearching: isSearching)) { space in
                    if let conversation = Self.conversation(for: space) {
                        entry(space: space, conversation: conversation)
                    }
                }
                if showsMoreToggle { moreToggle }
            }
        } header: {
            ContactsSectionHeader(title: "Groups", count: spaces.count, isCollapsed: isSearching ? nil : isCollapsed) {
                withAnimation(reduceMotion ? nil : GroupChannelDisclosureMotion.animation) { isCollapsed.toggle() }
            }
        }
        .listSectionSeparator(.hidden)
    }

    private var moreToggle: some View {
        Button {
            withAnimation(reduceMotion ? nil : GroupChannelDisclosureMotion.animation) { isExpanded.toggle() }
        } label: {
            Text(isExpanded ? "Show less" : "Show all \(spaces.count)")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.leading, 56)
                .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contactsListRow()
        .listRowSeparator(.hidden)
    }

    @ViewBuilder
    private func entry(space: GroupSpaceSummary, conversation: ConversationSummary) -> some View {
        Group {
            if let onOpenConversation {
                Button { onOpenConversation(conversation) } label: { ContactsGroupRow(space: space) }
                    .buttonStyle(.plain)
            } else {
                NavigationLink(value: conversation) { ContactsGroupRow(space: space) }
            }
        }
        .contactsListRow()
    }

    /// The group's main chat, or its most recent one when there is no main chat.
    static func conversation(for space: GroupSpaceSummary) -> ConversationSummary? {
        space.membershipSessions.first { $0.sessionId == $0.groupSpaceId } ?? space.membershipSessions.first
    }

    /// "3 people · 09:41"; the time is left out when the group has no activity yet.
    static func subtitle(peopleCount: Int, lastActivityAt: Date, now: Date = Date()) -> String {
        let people = peopleCount == 1 ? "1 person" : "\(peopleCount) people"
        let time = chatListTimestamp(lastActivityAt, now: now)
        return time.isEmpty ? people : "\(people) · \(time)"
    }
}

private struct ContactsGroupRow: View {
    let space: GroupSpaceSummary

    private var subtitle: String {
        ContactsGroupsSection.subtitle(peopleCount: space.participants.count, lastActivityAt: space.lastActivityAt)
    }

    var body: some View {
        ContactsRowLayout(
            title: space.displayName,
            subtitle: subtitle,
            subtitleIcon: space.isGroundingGroup ? Image("CommonGroundHug") : nil,
            subtitleIconLabel: "Grounding"
        ) {
            if AvatarImageLoader.normalizedSource(space.avatarSource) != nil {
                GroupAvatarStack(participants: space.participants, size: 44, imageSource: space.avatarSource)
            } else {
                GroupInitialTile(name: space.displayName, seed: space.preferenceId, size: 44)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(space.isGroundingGroup ? "\(space.displayName), Grounding, \(subtitle)" : "\(space.displayName), \(subtitle)")
    }
}

/// A group without its own picture: the name's initial on a muted colour
/// that stays the same for the group on every device.
struct GroupInitialTile: View {
    let name: String
    let seed: String
    var size: CGFloat = 44

    static let palette: [Color] = [
        Color(red: 0.24, green: 0.36, blue: 0.85),
        Color(red: 0.18, green: 0.43, blue: 0.36),
        Color(red: 0.54, green: 0.35, blue: 0.17),
        Color(red: 0.42, green: 0.36, blue: 0.66),
        Color(red: 0.63, green: 0.29, blue: 0.25),
        Color(red: 0.18, green: 0.44, blue: 0.53),
    ]

    /// FNV-1a over the seed, so the colour does not change between launches.
    static func paletteIndex(for seed: String) -> Int {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in seed.utf8 {
            hash = (hash ^ UInt64(byte)) &* 0x0000_0100_0000_01b3
        }
        return Int(hash % UInt64(palette.count))
    }

    static func initial(of name: String) -> String {
        name.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "#"
    }

    var body: some View {
        Text(Self.initial(of: name))
            .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Self.palette[Self.paletteIndex(for: seed)],
                        in: RoundedRectangle(cornerRadius: size * 0.17, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// Section title in Contacts. With `isCollapsed` set, the header shows a
/// chevron and the count and folds the section when tapped.
struct ContactsSectionHeader: View {
    let title: String
    var count: Int? = nil
    var isCollapsed: Bool? = nil
    var onToggle: (() -> Void)? = nil

    var body: some View {
        if let isCollapsed, let onToggle {
            Button(action: onToggle) { label(isCollapsed: isCollapsed) }
                .buttonStyle(.plain)
                .accessibilityValue(isCollapsed ? "Collapsed" : "Expanded")
        } else {
            label(isCollapsed: nil)
        }
    }

    private func label(isCollapsed: Bool?) -> some View {
        HStack(spacing: 4) {
            Text(title)
            if let isCollapsed {
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .rotationEffect(.degrees(isCollapsed ? -90 : 0))
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 8)
            if let count {
                Text("\(count)").monospacedDigit()
            }
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.secondary)
        .textCase(nil)
        .frame(maxWidth: .infinity, minHeight: isCollapsed == nil ? nil : 32, alignment: .leading)
        .contentShape(Rectangle())
        .padding(.top, 10)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}
