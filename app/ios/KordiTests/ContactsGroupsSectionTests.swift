import XCTest
@testable import Kordi

@MainActor
final class ContactsGroupsSectionTests: XCTestCase {
    func testShowsFirstFiveUntilExpandedOrSearching() {
        let items = Array(1...12)
        XCTAssertEqual(ContactsGroupsSection.visible(items, isExpanded: false, isSearching: false), [1, 2, 3, 4, 5])
        XCTAssertEqual(ContactsGroupsSection.visible(items, isExpanded: true, isSearching: false).count, 12)
        XCTAssertEqual(ContactsGroupsSection.visible(items, isExpanded: false, isSearching: true).count, 12)
        XCTAssertEqual(ContactsGroupsSection.visible([1, 2], isExpanded: false, isSearching: false), [1, 2])
    }

    func testSubtitleCountsPeopleAndOmitsMissingTime() {
        XCTAssertEqual(ContactsGroupsSection.subtitle(peopleCount: 1, lastActivityAt: .distantPast), "1 person")
        XCTAssertEqual(ContactsGroupsSection.subtitle(peopleCount: 3, lastActivityAt: .distantPast), "3 people")
        let now = Date()
        let subtitle = ContactsGroupsSection.subtitle(peopleCount: 3, lastActivityAt: now, now: now)
        XCTAssertEqual(subtitle, "3 people · \(chatListTimestamp(now, now: now))")
    }

    func testUnnamedGroupTitleMatchesDesktopAndDoesNotDependOnViewerOrMemberOrder() {
        let members = [
            CloudGroupParticipant(accountId: "acct_10", displayName: "Taylor", avatarUrl: nil, role: "member"),
            CloudGroupParticipant(accountId: "acct_2", displayName: "Alex", avatarUrl: nil, role: "owner"),
            CloudGroupParticipant(accountId: "acct_4", displayName: "Sam", avatarUrl: nil, role: "member"),
            CloudGroupParticipant(accountId: "acct_20", displayName: "Robin", avatarUrl: nil, role: "member"),
        ]
        XCTAssertEqual(GroupSpaceCatalog.participantTitle(members, creatorAccountId: "acct_2"), "Sam, Taylor +1 more")
        XCTAssertEqual(GroupSpaceCatalog.participantTitle(Array(members.reversed()), creatorAccountId: "acct_2"), "Sam, Taylor +1 more")
        XCTAssertEqual(GroupSpaceCatalog.participantTitle(members), "Sam, Taylor +1 more")
        // The canonical creator can differ from the legacy stable anchor.
        XCTAssertEqual(GroupSpaceCatalog.participantTitle(members, creatorAccountId: "acct_10"), "Alex, Sam +1 more")
        XCTAssertEqual(GroupSpaceCatalog.participantTitle([members[0]], creatorAccountId: "acct_10"), "Taylor")
    }

    func testUnnamedGroupUsesAllChannelMembersWithTheSharedCreator() throws {
        let creator = CloudGroupParticipant(accountId: "acct_creator", displayName: "Creator", avatarUrl: nil, role: "owner")
        let first = CloudGroupParticipant(accountId: "acct_1", displayName: "Sam", avatarUrl: nil, role: "member")
        let second = CloudGroupParticipant(accountId: "acct_2", displayName: "Taylor", avatarUrl: nil, role: "member")
        func channel(_ id: String, participants: [CloudGroupParticipant]) -> ConversationSummary {
            ConversationSummary(
                id: id, kind: .group, peerAccountId: first.accountId, agentId: nil,
                ownerDisplayName: nil, displayName: "Channel", lastMessage: "",
                lastActivityAt: .distantPast, unreadCount: 0, avatarSource: nil,
                agentActivity: nil, sessionId: id, groupSpaceId: "session:root",
                groupCreatorAccountId: creator.accountId, groupParticipants: participants
            )
        }
        let root = channel("session:root", participants: [creator, first])
        let sibling = channel("session:child", participants: [second, first, creator])
        let store = try LocalMessageStore(inMemory: true)
        store.saveConversations([root, sibling], accountId: first.accountId)
        let cached = store.loadConversations(accountId: first.accountId)
        XCTAssertEqual(cached.count, 2)
        XCTAssertTrue(cached.allSatisfy { $0.groupCreatorAccountId == creator.accountId })
        for viewer in [creator.accountId, first.accountId, second.accountId] {
            for channels in [[root, sibling], [sibling, root], cached] {
                let spaces = GroupSpaceCatalog.build(conversations: channels, ownAccountId: viewer)
                XCTAssertEqual(spaces.count, 1)
                XCTAssertEqual(spaces.first?.displayName, "Sam, Taylor")
                XCTAssertEqual(spaces.first?.participants.count, 3)
                XCTAssertEqual(spaces.first?.sessions.count, 2)
            }
        }
    }

}
