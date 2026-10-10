import XCTest
@testable import Kordi

/// Answers memory routes with the server's `{ errorCode, message }` error bodies.
private final class MemoryErrorURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let status: Int
        let body: String
        if request.httpMethod == "PATCH" {
            status = 422
            body = #"{"errorCode":"memory_rejected","message":"This looks like a health detail. Save a memory about the task instead."}"#
        } else {
            status = 409
            body = #"{"errorCode":"memory_disabled","message":"Memory is off for this account."}"#
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class MemoryPresentationTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private let now = ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z")!

    private func memory(_ id: String, _ scope: CloudMemoryScope, updatedAt: String, source: CloudMemorySource = .manual, label: String? = "Weekly planning") -> CloudMemory {
        CloudMemory(memoryId: id, scope: scope, scopeId: "scope-\(id)", scopeLabel: label, source: source, text: "Memory \(id)", createdAt: updatedAt, updatedAt: updatedAt)
    }

    func testSettingsListOnlyGlobalMemoriesNewestFirst() {
        let memories = [
            memory("g-old", .global, updatedAt: "2026-09-01T00:00:00Z"),
            memory("c", .conversation, updatedAt: "2026-10-06T00:00:00Z"),
            memory("g-new", .global, updatedAt: "2026-10-06T00:00:00.250Z"),
            memory("grp", .group, updatedAt: "2026-10-05T00:00:00Z"),
            memory("p", .project, updatedAt: "2026-10-04T00:00:00Z"),
        ]
        XCTAssertEqual(MemoryPresentation.globalMemories(memories).map(\.memoryId), ["g-new", "g-old"])
        XCTAssertTrue(MemoryPresentation.globalMemories([]).isEmpty)
        XCTAssertEqual(MemoryPresentation.globalMemoriesTitle(count: 2), "Global memories · 2")
    }

    func testValidationNormalisesAndEnforcesTheLimit() {
        XCTAssertEqual(MemoryPresentation.validate("  Keep   headlines\n\tshort.  "), .valid("Keep headlines short."))
        XCTAssertEqual(MemoryPresentation.validate(" \n\t "), .invalid("Enter a memory."))
        XCTAssertEqual(MemoryPresentation.validate(String(repeating: "a", count: 500)), .valid(String(repeating: "a", count: 500)))
        XCTAssertEqual(MemoryPresentation.validate(String(repeating: "a", count: 501)), .invalid("Memories are 500 characters or fewer."))
        // Collapsed whitespace counts once, so this fits after normalisation.
        XCTAssertEqual(MemoryPresentation.validate(String(repeating: "a", count: 499) + "   b").isValid, false)
        XCTAssertEqual(MemoryPresentation.validate(String(repeating: "a", count: 498) + "   b").isValid, true)
        XCTAssertEqual(MemoryPresentation.counter("abc"), "3 / 500")
        XCTAssertTrue(MemoryPresentation.isOverLimit(String(repeating: "a", count: 501)))
        XCTAssertFalse(MemoryPresentation.isOverLimit(String(repeating: "a", count: 500)))
    }

    func testSourceLabels() {
        XCTAssertEqual(MemoryPresentation.sourceLabel(.userCorrection), "From a correction")
        XCTAssertEqual(MemoryPresentation.sourceLabel(.repeatedFailure), "From a repeated failure")
        XCTAssertEqual(MemoryPresentation.sourceLabel(.outcome), "From an outcome")
        XCTAssertEqual(MemoryPresentation.sourceLabel(.manual), "Added by hand")
    }

    func testDetailAndDateLabels() {
        let today = memory("a", .conversation, updatedAt: "2026-10-07T08:00:00Z", source: .userCorrection, label: "Launch copy with Priya")
        XCTAssertEqual(MemoryPresentation.detail(today, now: now, calendar: calendar), "From a correction · Today")
        XCTAssertEqual(MemoryPresentation.dateLabel("2026-10-06T23:00:00Z", now: now, calendar: calendar), "Yesterday")
        let older = MemoryPresentation.dateLabel("2026-09-01T10:00:00Z", now: now, calendar: calendar, locale: Locale(identifier: "en_US"))
        XCTAssertEqual(older, "Sep 1, 2026")
        let unlabeled = memory("b", .project, updatedAt: "2026-10-07T08:00:00Z", label: nil)
        XCTAssertEqual(MemoryPresentation.detail(unlabeled, now: now, calendar: calendar), "Added by hand · Today")
    }

    func testForgetConsequencesSingularAndPlural() {
        XCTAssertEqual(
            MemoryPresentation.forgetConsequences(count: 1),
            "This deletes 1 memory from your account and every signed-in device. It cannot be undone."
        )
        XCTAssertEqual(
            MemoryPresentation.forgetConsequences(count: 7),
            "This deletes 7 memories from your account and every signed-in device. It cannot be undone."
        )
    }

    func testSyncCaptionVariants() {
        let account = "taylor@memory.example"
        XCTAssertEqual(MemoryPresentation.syncCaption(accountLabel: account, lastSyncedAt: nil, now: now), "Not synced yet with taylor@memory.example")
        XCTAssertEqual(MemoryPresentation.syncCaption(accountLabel: account, lastSyncedAt: now.addingTimeInterval(-20), now: now), "Synced with taylor@memory.example · just now")
        XCTAssertEqual(MemoryPresentation.syncCaption(accountLabel: account, lastSyncedAt: now.addingTimeInterval(-60), now: now), "Synced with taylor@memory.example · 1 minute ago")
        XCTAssertEqual(MemoryPresentation.syncCaption(accountLabel: account, lastSyncedAt: now.addingTimeInterval(-25 * 60), now: now), "Synced with taylor@memory.example · 25 minutes ago")
        XCTAssertEqual(MemoryPresentation.syncCaption(accountLabel: account, lastSyncedAt: now.addingTimeInterval(-3 * 3_600), now: now, calendar: calendar), "Synced with taylor@memory.example · Today")
        XCTAssertEqual(MemoryPresentation.accountLabel(email: "", kordiId: "482731906"), "482731906")
        XCTAssertEqual(MemoryPresentation.accountLabel(email: "a@b.example", kordiId: "482731906"), "a@b.example")
    }

    func testCapabilityGating() throws {
        let decoder = JSONDecoder()
        let older = try decoder.decode(CloudAuthCapabilities.self, from: Data(#"{"password":true,"oauthProviders":["google","github"]}"#.utf8))
        XCTAssertFalse(MemoryPresentation.isAvailable(older))
        let current = try decoder.decode(CloudAuthCapabilities.self, from: Data(#"{"password":true,"oauthProviders":[{"id":"google"}],"memoryVersion":1}"#.utf8))
        XCTAssertTrue(MemoryPresentation.isAvailable(current))
        XCTAssertFalse(MemoryPresentation.isAvailable(nil))
    }

    func testListResponseDecodesUnknownValuesWithoutFailing() throws {
        let json = #"""
        {
          "memories": [
            {"memoryId":"m1","scope":"conversation","scopeId":"c1","scopeLabel":"Weekly planning","source":"user_correction","text":"Ask first.","createdAt":"2026-10-06T10:00:00Z","updatedAt":"2026-10-06T10:00:00Z"},
            {"memoryId":"m3","scope":"global","scopeId":"account","scopeLabel":null,"source":"manual","text":"Reply in bullet points.","createdAt":"2026-10-04T10:00:00Z","updatedAt":"2026-10-04T10:00:00Z"},
            {"memoryId":"m2","scope":"workspace","scopeId":"w1","scopeLabel":null,"source":"imported","text":"Future value.","createdAt":"2026-10-05T10:00:00.123Z","updatedAt":"2026-10-05T10:00:00.123Z"}
          ],
          "settings": {"memoryEnabled": false, "excludeSensitive": true}
        }
        """#
        let response = try JSONDecoder().decode(CloudMemoryListResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.memories.count, 3)
        XCTAssertEqual(response.memories[0].scope, .conversation)
        XCTAssertEqual(response.memories[0].source, .userCorrection)
        XCTAssertEqual(response.memories[1].scope, .global)
        XCTAssertEqual(response.memories[2].scope, .other("workspace"))
        XCTAssertEqual(response.memories[2].source, .other("imported"))
        XCTAssertNil(response.memories[2].scopeLabel)
        XCTAssertEqual(response.settings, CloudMemorySettings(memoryEnabled: false, excludeSensitive: true))
        XCTAssertEqual(MemoryPresentation.globalMemories(response.memories).map(\.memoryId), ["m3"])
        // A scope from a newer server never shows on a conversation's tab.
        let scopes = MemoryPresentation.ConversationScopes(conversation: ["w1"], group: ["w1"], project: ["w1"])
        XCTAssertTrue(MemoryPresentation.memories(response.memories, for: scopes).isEmpty)
    }

    func testSettingsUpdateOmitsUnsetFields() throws {
        let data = try JSONEncoder().encode(CloudMemorySettingsUpdateRequest(memoryEnabled: false, excludeSensitive: nil))
        XCTAssertEqual(String(decoding: data, as: UTF8.self), #"{"memoryEnabled":false}"#)
    }

    @MainActor
    func testPreviewServiceMatchesDesktopSamples() async throws {
        let service = PreviewMemoryService(now: now, latency: .zero)
        let model = MemorySettingsModel(service: service, accountLabel: "taylor@memory.example")
        await model.load()
        XCTAssertEqual(model.memories.count, 9)
        // Settings list only the global samples; the group sample belongs to the preview group.
        XCTAssertEqual(model.globalMemories.map(\.memoryId), ["lesson-8", "lesson-9"])
        let previewGroup = groupConversation(sessionId: "session:group:mobile", groupSpaceId: "session:group:mobile")
        XCTAssertEqual(model.memories(for: MemoryPresentation.conversationScopes(for: previewGroup)).map(\.memoryId), ["lesson-7"])
        let launchCopy = directConversation(sessionId: "conv-launch-copy")
        XCTAssertEqual(model.memories(for: MemoryPresentation.conversationScopes(for: launchCopy)).map(\.memoryId), ["lesson-1", "lesson-2"])
        let rejected = await model.save(memoryId: "lesson-1", draft: String(repeating: "a", count: 501))
        XCTAssertEqual(rejected, "Memories are 500 characters or fewer.")
        let saved = await model.save(memoryId: "lesson-1", draft: " Short  headlines. ")
        XCTAssertNil(saved)
        XCTAssertEqual(model.memories.first { $0.memoryId == "lesson-1" }?.text, "Short headlines.")
        await model.forgetAll()
        XCTAssertTrue(model.memories.isEmpty)
    }
}

extension MemoryPresentationTests {
    fileprivate func groupConversation(sessionId: String, groupSpaceId: String?) -> ConversationSummary {
        ConversationSummary(
            id: "group:test", kind: .group, peerAccountId: "acct_owner", agentId: nil,
            ownerDisplayName: "Design review", displayName: "main", lastMessage: "",
            lastActivityAt: Date(), unreadCount: 0, avatarSource: nil, agentActivity: nil,
            sessionId: sessionId, groupSpaceId: groupSpaceId
        )
    }

    private func scoped(_ id: String, _ scope: CloudMemoryScope, _ scopeId: String, updatedAt: String = "2026-10-01T00:00:00Z") -> CloudMemory {
        CloudMemory(memoryId: id, scope: scope, scopeId: scopeId, scopeLabel: nil, source: .manual, text: id, createdAt: updatedAt, updatedAt: updatedAt)
    }

    fileprivate func directConversation(sessionId: String, subsessionId: String? = nil) -> ConversationSummary {
        ConversationSummary(
            id: "agent:test", kind: .agent, peerAccountId: "acct_owner", agentId: "agent-1",
            ownerDisplayName: "Me", displayName: "My Kordi", lastMessage: "",
            lastActivityAt: Date(), unreadCount: 0, avatarSource: nil, agentActivity: nil,
            sessionId: sessionId, subsessionId: subsessionId
        )
    }

    func testConversationScopesUseTheCloudSessionId() {
        let conversation = directConversation(sessionId: "0acdb239-cf23-46b0-872b-ed92cf6028eb", subsessionId: "sub-1")
        let scopes = MemoryPresentation.conversationScopes(for: conversation)
        XCTAssertEqual(scopes.conversation, ["0acdb239-cf23-46b0-872b-ed92cf6028eb", "sub-1"])
        XCTAssertTrue(scopes.group.isEmpty)
        XCTAssertTrue(scopes.project.isEmpty)
        let memories = [
            scoped("mine", .conversation, "0acdb239-cf23-46b0-872b-ed92cf6028eb", updatedAt: "2026-10-02T00:00:00Z"),
            scoped("thread", .conversation, "sub-1", updatedAt: "2026-10-03T00:00:00Z"),
            scoped("other-chat", .conversation, "another-chat"),
            scoped("global", .global, "account"),
            scoped("same-id-group", .group, "0acdb239-cf23-46b0-872b-ed92cf6028eb"),
        ]
        XCTAssertEqual(MemoryPresentation.memories(memories, for: scopes).map(\.memoryId), ["thread", "mine"])
    }

    func testGroupScopesAcceptSpaceIdStrippedAndFullSessionId() {
        let uuid = "7f3c2a10-5b1e-4c3d-9a8f-2e6b1d0c4f55"
        let conversation = groupConversation(sessionId: "session:group:\(uuid)", groupSpaceId: "space-123")
        let scopes = MemoryPresentation.conversationScopes(for: conversation)
        XCTAssertEqual(scopes.group, ["space-123", uuid, "session:group:\(uuid)"])
        XCTAssertEqual(scopes.conversation, ["session:group:\(uuid)"])
        // Without a group space id, both session id forms still match.
        let bare = groupConversation(sessionId: "session:group:\(uuid)", groupSpaceId: nil)
        XCTAssertEqual(MemoryPresentation.conversationScopes(for: bare).group, [uuid, "session:group:\(uuid)"])
        // A bare prefix is never stripped to an empty id.
        let other = groupConversation(sessionId: "session:group:", groupSpaceId: " ")
        XCTAssertEqual(MemoryPresentation.conversationScopes(for: other).group, ["session:group:"])
    }

    func testGroupTabMatchesEachScopeIdFormNewestFirst() {
        let uuid = "7f3c2a10-5b1e-4c3d-9a8f-2e6b1d0c4f55"
        let conversation = groupConversation(sessionId: "session:group:\(uuid)", groupSpaceId: "space-123")
        let memories = [
            scoped("stripped", .group, uuid, updatedAt: "2026-10-03T00:00:00Z"),
            scoped("full", .group, "session:group:\(uuid)", updatedAt: "2026-10-01T00:00:00Z"),
            scoped("space", .group, "space-123", updatedAt: "2026-10-02T00:00:00Z"),
            scoped("group-conversation", .conversation, "session:group:\(uuid)", updatedAt: "2026-09-30T00:00:00Z"),
            scoped("other-group", .group, "another-uuid"),
            scoped("same-id-conversation", .conversation, uuid),
            scoped("same-id-project", .project, "space-123"),
        ]
        let matched = MemoryPresentation.memories(memories, for: MemoryPresentation.conversationScopes(for: conversation))
        XCTAssertEqual(matched.map(\.memoryId), ["stripped", "space", "full", "group-conversation"])
        XCTAssertTrue(MemoryPresentation.memories(memories, for: .init()).isEmpty)
    }

    @MainActor
    func testServerErrorCodesAndMessagesReachTheScreen() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemoryErrorURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let api = CloudAPIClient(session: session)

        do {
            _ = try await api.updateMemory(token: "token", memoryId: "m1", text: "Text")
            XCTFail("Expected a rejection")
        } catch let error as CloudAPIError {
            XCTAssertEqual(error.code, "memory_rejected")
            XCTAssertEqual(error.statusCode, 422)
        }

        let model = MemorySettingsModel(service: CloudMemoryService(api: api) { "token" }, accountLabel: nil)
        let inline = await model.save(memoryId: "m1", draft: "Text")
        XCTAssertEqual(inline, "This looks like a health detail. Save a memory about the task instead.")

        do {
            _ = try await api.updateMemorySettings(token: "token", memoryEnabled: true)
            XCTFail("Expected memory_disabled")
        } catch let error as CloudAPIError {
            XCTAssertEqual(error.code, "memory_disabled")
            XCTAssertEqual(error.statusCode, 409)
        }
        await model.delete(CloudMemory(memoryId: "m1", scope: .conversation, scopeId: "c", scopeLabel: nil, source: .manual, text: "Text", createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z"))
        XCTAssertEqual(model.errorMessage, "Memory is off for this account.")
    }
}

private extension MemoryPresentation.Validation {
    var isValid: Bool {
        if case .valid = self { return true }
        return false
    }
}

extension MemoryPresentationTests {
    func testEveryConversationGetsAMemoryTabWhenAvailable() {
        let capabilities = CloudAuthCapabilities(password: true, memoryVersion: 1)
        XCTAssertEqual(SessionDetailTab.tabs(for: .group, capabilities: capabilities), [.members, .memory, .media, .files, .todo])
        XCTAssertEqual(SessionDetailTab.tabs(for: .person, capabilities: capabilities), [.media, .files, .todo, .groups, .memory])
        XCTAssertEqual(SessionDetailTab.tabs(for: .agent, capabilities: capabilities), [.media, .files, .todo, .memory])
    }

    func testTabsLeaveOutMemoryWithoutTheCapability() {
        XCTAssertEqual(SessionDetailTab.tabs(for: .group, capabilities: nil), [.members, .media, .files, .todo])
        XCTAssertEqual(SessionDetailTab.tabs(for: .group, capabilities: CloudAuthCapabilities(password: true, memoryVersion: nil)), [.members, .media, .files, .todo])
        XCTAssertEqual(SessionDetailTab.tabs(for: .person, memoryAvailable: false), [.media, .files, .todo, .groups])
        XCTAssertEqual(SessionDetailTab.tabs(for: .agent, memoryAvailable: false), [.media, .files, .todo])
    }
}
