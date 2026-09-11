import XCTest
import Security
import Testing
@testable import Kordi

private final class SubsessionReadURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard request.value(forHTTPHeaderField: "X-Test-Subsession") != "hang" else { return }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"sessionId":"task","parentSessionId":"parent","parentRequestId":"request","ownerAccountId":"owner","agentId":"agent","ownerDisplayName":"Owner","agentDisplayName":"Helper","title":"Background task","status":"failed","version":1,"messages":[],"updatedAt":"2026-09-08T00:00:00Z"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

struct SubsessionFailureTests {
    private func client(hangs: Bool) -> (CloudAPIClient, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SubsessionReadURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Test-Subsession": hangs ? "hang" : "failed"]
        let session = URLSession(configuration: configuration)
        return (CloudAPIClient(session: session), session)
    }

    @Test func nonRespondingReadHasABoundedDeadline() async {
        let (api, session) = client(hangs: true)
        defer { session.invalidateAndCancel() }
        let clock = ContinuousClock(), start = ContinuousClock.now
        do {
            _ = try await api.agentSubsession(token: "synthetic", id: "task", includeMessages: true, timeout: .milliseconds(50))
            Issue.record("A nonresponding read must time out")
        } catch {
            #expect((error as? URLError)?.code == .timedOut)
            #expect(AgentSubsessionLoadFailure(error: error) == .timedOut)
        }
        #expect(start.duration(to: clock.now) < .seconds(2))
    }

    @Test func failedTaskRemainsFailedWhenItsHistoryIsEmpty() async throws {
        let (api, session) = client(hangs: false)
        defer { session.invalidateAndCancel() }
        let task = try await api.agentSubsession(token: "synthetic", id: "task", includeMessages: true)
        #expect(task.state == .failed)
        #expect(task.conversation.agentActivity == .failed)
        #expect(task.messages.isEmpty)
    }

    @Test func cancelledViewReadIsNotReportedAsTaskFailure() async {
        let (api, session) = client(hangs: true)
        defer { session.invalidateAndCancel() }
        let read = Task { try await api.agentSubsession(token: "synthetic", id: "task", includeMessages: true) }
        read.cancel()
        do { _ = try await read.value; Issue.record("The read should be cancelled") }
        catch { #expect(CloudTransportErrorPolicy.isCancellation(error)) }
    }

    @Test func accessAndConnectionFailuresRemainDistinctFromExecutionFailure() {
        #expect(AgentSubsessionLoadFailure(error: URLError(.notConnectedToInternet)) == .unavailable)
        for status in [401, 403, 404] {
            #expect(AgentSubsessionLoadFailure(error: CloudAPIError(code: "unavailable", message: "Unavailable", statusCode: status)) == .inaccessible)
        }
    }
}

private final class SessionActivityCancellationURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if request.value(forHTTPHeaderField: "X-Test-Activity-Result") == "cancel" {
            client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"code":"synthetic_failure","message":"Synthetic activity failure."}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
struct SessionActivityCancellationTests {
    private func model(result: String) -> (AppModel, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionActivityCancellationURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Test-Activity-Result": result]
        let session = URLSession(configuration: configuration)
        return (AppModel(api: CloudAPIClient(session: session), previewMode: true), session)
    }

    @Test func cancelledActivityLoadPreservesExistingNoticeAndActivity() async throws {
        let (model, session) = model(result: "cancel")
        defer { session.invalidateAndCancel() }
        let conversation = try #require(model.conversations.first)
        let previousActivity = model.sessionActivityByID
        model.errorMessage = "Existing notice"
        await model.loadSessionActivity(conversation)
        #expect(model.errorMessage == "Existing notice")
        #expect(model.sessionActivityByID == previousActivity)
    }

    @Test func realActivityFailureStillSurfaces() async throws {
        let (model, session) = model(result: "failure")
        defer { session.invalidateAndCancel() }
        let conversation = try #require(model.conversations.first)
        await model.loadSessionActivity(conversation)
        #expect(model.errorMessage == "Synthetic activity failure.")
    }

    @Test func alreadyCancelledActivityLoadDoesNotSurfaceAnError() async throws {
        let (model, session) = model(result: "failure")
        defer { session.invalidateAndCancel() }
        let conversation = try #require(model.conversations.first)
        model.errorMessage = "Existing notice"
        let task = Task { @MainActor in await model.loadSessionActivity(conversation) }
        task.cancel()
        await task.value
        #expect(model.errorMessage == "Existing notice")
    }

    @Test func detailLoadChecksCancellationBetweenRequestsAndBeforePublishing() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let detail = try String(contentsOf: directory.appendingPathComponent("Kordi/Features/Conversation/SessionDetailSheet.swift"), encoding: .utf8)
        let start = try #require(detail.range(of: ".sensoryFeedback(.selection, trigger: notificationsMuted)"))
        let end = try #require(detail.range(of: ".quickLookPreview", range: start.upperBound..<detail.endIndex))
        let loading = detail[start.upperBound..<end.lowerBound]
        #expect(loading.components(separatedBy: "guard !Task.isCancelled else { return }").count == 4)
        let source = try String(contentsOf: directory.appendingPathComponent("Kordi/App/AppModel.swift"), encoding: .utf8)
        let activityStart = try #require(source.range(of: "func loadSessionActivity("))
        let activityEnd = try #require(source.range(of: "func lookupContact(", range: activityStart.upperBound..<source.endIndex))
        let activity = source[activityStart.lowerBound..<activityEnd.lowerBound]
        #expect(activity.contains("guard !Task.isCancelled, let token, let accountId = account?.accountId"))
        #expect(activity.contains("guard !Task.isCancelled, self.token == token, account?.accountId == accountId"))
        #expect(activity.contains("guard self.token == token, account?.accountId == accountId,"))
        #expect(activity.contains("CloudTransportErrorPolicy.shouldSurface(error, taskIsCancelled: Task.isCancelled)"))
    }
}

final class CloudModelDecodingTests: XCTestCase {
    func testThreadAttentionKeepsTotalAndThreadCountsDistinct() throws {
        let json = #"{"conversation_id":"c","session_id":"s","unread_count":7,"thread_unread_count":3,"thread_count":2,"next_root_id":"root","next_message_id":"reply"}"#
        let attention = try JSONDecoder().decode(CloudThreadAttention.self, from: Data(json.utf8))
        XCTAssertEqual(attention.unreadCount, 7)
        XCTAssertEqual(attention.threadUnreadCount, 3)
        XCTAssertEqual(attention.threadCount, 2)
        XCTAssertEqual(attention.nextMessageId, "reply")
        let payload: [AnyHashable: Any] = ["notification_type":"message", "account_id":"account", "session_id":"s", "message_id":"reply", "thread_root_id":"root"]
        XCTAssertEqual(KordiMessageNotificationPayload(payload)?.threadRootID, "root")
    }

    func testInstallationDeviceIdentityIsStableAndDistinctAcrossStores() throws {
        let firstService = "io.kordi.tests.device.\(UUID().uuidString)"
        let secondService = "io.kordi.tests.device.\(UUID().uuidString)"
        let defaultsName = "io.kordi.tests.session-store.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsName))
        defer {
            defaults.removePersistentDomain(forName: defaultsName)
            for service in [firstService, secondService] {
                SecItemDelete([
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: service
                ] as CFDictionary)
            }
        }
        let firstStore = KeychainSessionStore(
            service: firstService,
            developmentDefaults: defaults
        )
        let secondStore = KeychainSessionStore(
            service: secondService,
            developmentDefaults: defaults
        )

        let firstKey = try firstStore.loadOrCreateDevicePublicKey()
        XCTAssertNil(try firstStore.loadToken())
        try firstStore.saveToken("temporary-session")
        XCTAssertEqual(try firstStore.loadToken(), "temporary-session")
        try firstStore.deleteToken()
        XCTAssertNil(try firstStore.loadToken())

        XCTAssertEqual(firstKey.count, 65)
        XCTAssertEqual(firstKey.first, 0x04)
        XCTAssertEqual(try firstStore.loadOrCreateDevicePublicKey(), firstKey)
        XCTAssertNotEqual(try secondStore.loadOrCreateDevicePublicKey(), firstKey)
    }

    func testCancelledSessionLoadIsNotClassifiedAsACloudConnectionFailure() {
        XCTAssertTrue(CloudTransportErrorPolicy.isCancellation(CancellationError()))
        XCTAssertTrue(CloudTransportErrorPolicy.isCancellation(URLError(.cancelled)))
        XCTAssertFalse(CloudTransportErrorPolicy.isCancellation(URLError(.timedOut)))
        XCTAssertFalse(CloudTransportErrorPolicy.shouldSurface(
            CancellationError(),
            taskIsCancelled: false
        ))
        XCTAssertFalse(CloudTransportErrorPolicy.shouldSurface(
            URLError(.timedOut),
            taskIsCancelled: true
        ))
        XCTAssertTrue(CloudTransportErrorPolicy.shouldSurface(
            URLError(.timedOut),
            taskIsCancelled: false
        ))
    }

    func testDefaultClientUsesConfiguredOriginAndWaitsForConnectivity() {
        XCTAssertEqual(CloudAPIClient.productionBaseURL.absoluteString, "https://kordi.ai")
        XCTAssertTrue(CloudAPIClient.reliableSession.configuration.waitsForConnectivity)
        XCTAssertEqual(CloudAPIClient.reliableSession.configuration.timeoutIntervalForRequest, 30)
    }

    func testCloudSessionVisibilityDecodesMacHiddenAndDeletedSessions() throws {
        let payload = Data(#"{"hiddenSessionIds":["session:hidden"],"deletedSessionIds":["session:deleted"],"unreadSessionIds":["session:unread"],"pinnedGroupSpaceIds":["group:space"]}"#.utf8)
        let visibility = try JSONDecoder().decode(CloudSessionVisibility.self, from: payload)

        XCTAssertEqual(visibility.hiddenSessionIds, ["session:hidden"])
        XCTAssertEqual(visibility.deletedSessionIds, ["session:deleted"])
        XCTAssertEqual(visibility.unreadSessionIds, ["session:unread"])
        XCTAssertEqual(visibility.pinnedGroupSpaceIds, ["group:space"])
    }

    func testExpressiveMediaLibraryResponseDecodesCrossDeviceItems() throws {
        let payload = Data(
            #"{"items":[{"itemId":"media-1","attachmentId":"attachment-1","kind":"sticker","name":"wave.webp","mimeType":"image/webp","sizeBytes":128,"createdAt":"2026-08-17T10:00:00Z","updatedAt":"2026-08-17T10:00:00Z"}]}"#.utf8
        )
        let response = try JSONDecoder().decode(CloudExpressiveMediaListResponse.self, from: payload)

        XCTAssertEqual(response.items.first?.attachmentId, "attachment-1")
        XCTAssertEqual(response.items.first?.kind, .sticker)
    }

    func testCloudSessionPinDecodesSharedAndPrivateMacShape() throws {
        let payload = Data(#"{"sessionId":"session:group","sharedMessageId":"msg_shared","privateMessageId":"msg_private","effectiveMessageId":"msg_private","updatedAt":"2026-08-09T10:00:00Z"}"#.utf8)
        let pin = try JSONDecoder().decode(CloudSessionPin.self, from: payload)

        XCTAssertEqual(pin.sessionId, "session:group")
        XCTAssertEqual(pin.sharedMessageId, "msg_shared")
        XCTAssertEqual(pin.privateMessageId, "msg_private")
        XCTAssertEqual(pin.effectiveMessageId, "msg_private")
    }

    @MainActor
    func testSessionPinEventsApplyScopesAndIgnoreStaleUpdates() {
        let sessionId = "session:group"
        let initial = CloudSessionPin(
            sessionId: sessionId,
            sharedMessageId: "msg_shared_old",
            privateMessageId: nil,
            effectiveMessageId: "msg_shared_old",
            updatedAt: "2026-08-17T12:00:00Z"
        )
        let privatePin = AppModel.applyingSessionPinEvents(
            [sessionPinEvent(messageId: "msg_private", scope: "private", updatedAt: "2026-08-17T12:00:01Z")],
            to: [sessionId: initial]
        )
        XCTAssertEqual(privatePin[sessionId]?.effectiveMessageId, "msg_private")
        XCTAssertEqual(privatePin[sessionId]?.lastAction?.kind, "pinned")
        XCTAssertEqual(privatePin[sessionId]?.lastAction?.updatedByAccountId, "acct_alice")

        let sharedReplacement = AppModel.applyingSessionPinEvents(
            [sessionPinEvent(messageId: "msg_shared_new", scope: "shared", updatedAt: "2026-08-17T12:00:02Z")],
            to: privatePin
        )
        XCTAssertEqual(sharedReplacement[sessionId]?.sharedMessageId, "msg_shared_new")
        XCTAssertEqual(sharedReplacement[sessionId]?.effectiveMessageId, "msg_private")

        let privateUnpin = AppModel.applyingSessionPinEvents(
            [sessionPinEvent(messageId: nil, scope: "private", updatedAt: "2026-08-17T12:00:03Z")],
            to: sharedReplacement
        )
        XCTAssertNil(privateUnpin[sessionId]?.privateMessageId)
        XCTAssertEqual(privateUnpin[sessionId]?.effectiveMessageId, "msg_shared_new")
        XCTAssertEqual(privateUnpin[sessionId]?.lastAction?.kind, "unpinned")

        let duplicate = AppModel.applyingSessionPinEvents(
            [sessionPinEvent(messageId: nil, scope: "private", updatedAt: "2026-08-17T12:00:03Z")],
            to: privateUnpin
        )
        XCTAssertEqual(duplicate, privateUnpin)

        let staleUpdate = AppModel.applyingSessionPinEvents(
            [sessionPinEvent(messageId: "msg_stale", scope: "shared", updatedAt: "2026-08-17T12:00:01Z")],
            to: duplicate
        )
        XCTAssertEqual(staleUpdate, privateUnpin)

        let bootstrap = AppModel.applyingSessionPinEvents([
            sessionPinEvent(
                messageId: "msg_bootstrap_shared",
                scope: "shared",
                updatedAt: "2026-08-17T12:00:01Z",
                eventId: "bootstrap:session-pin:\(sessionId):shared"
            ),
            sessionPinEvent(
                messageId: nil,
                scope: "private",
                updatedAt: "2026-08-17T12:00:01Z",
                eventId: "bootstrap:session-pin:\(sessionId):private"
            ),
        ], to: privateUnpin)
        XCTAssertEqual(bootstrap[sessionId]?.sharedMessageId, "msg_bootstrap_shared")
        XCTAssertNil(bootstrap[sessionId]?.privateMessageId)
        XCTAssertEqual(bootstrap[sessionId]?.effectiveMessageId, "msg_bootstrap_shared")
        XCTAssertNil(bootstrap[sessionId]?.lastAction)
    }

    @MainActor
    func testPreviewPinActionsStayInteractiveWithoutACloudSession() async throws {
        let model = AppModel(previewMode: true)
        let conversation = try XCTUnwrap(model.conversations.first(where: { $0.kind == .group }))
        let messages = model.messages(for: conversation)
        let privateMessage = try XCTUnwrap(messages.first)
        let sharedMessage = try XCTUnwrap(messages.dropFirst().first)

        let privatePinned = await model.pin(privateMessage, in: conversation, shared: false)
        let sharedPinned = await model.pin(sharedMessage, in: conversation, shared: true)
        XCTAssertTrue(privatePinned)
        XCTAssertTrue(sharedPinned)
        XCTAssertEqual(model.sessionPinsByID[conversation.sessionId]?.effectiveMessageId, privateMessage.id)
        XCTAssertEqual(model.sessionPinsByID[conversation.sessionId]?.lastAction?.kind, "pinned")

        let privateUnpinned = await model.unpin(privateMessage, in: conversation)
        XCTAssertTrue(privateUnpinned)
        XCTAssertEqual(model.sessionPinsByID[conversation.sessionId]?.effectiveMessageId, sharedMessage.id)
        let sharedUnpinned = await model.unpin(sharedMessage, in: conversation)
        XCTAssertTrue(sharedUnpinned)
        XCTAssertNil(model.sessionPinsByID[conversation.sessionId]?.effectiveMessageId)
        XCTAssertEqual(model.sessionPinsByID[conversation.sessionId]?.lastAction?.kind, "unpinned")
    }

    private func sessionPinEvent(
        messageId: String?,
        scope: String,
        updatedAt: String,
        eventId: String? = nil,
        updatedByAccountId: String? = "acct_alice"
    ) -> CloudSyncEvent {
        CloudSyncEvent(
            eventId: eventId ?? "event:\(scope):\(updatedAt)",
            eventType: "session.pin.updated",
            peerAccountId: nil,
            messageId: messageId,
            payload: CloudSyncEventPayload(
                message: nil,
                messageIds: nil,
                messageId: messageId,
                readAt: nil,
                sessionId: "session:group",
                scope: scope,
                updatedAt: updatedAt,
                updatedByAccountId: updatedByAccountId,
                forkSessionId: nil,
                parentSessionId: nil,
                parentMessageId: nil,
                createdByAccountId: nil,
                createdAt: nil,
                sessionTitle: nil,
                deviceId: nil,
                call: nil
            ),
            occurredAt: updatedAt
        )
    }

    func testOwnedAndSharedAgentShapesDecodeThroughOneModel() throws {
        let avatar = #"{"entityType":"agent","entityId":"cloud_agent_owned","source":"generated","style":"thumbs","seed":"cloud_agent_owned","rendererVersion":"dicebear-rust-10.6.0-styles-10.5.0","uploadedAsset":null,"version":1,"updatedAt":"2026-08-08T00:00:00Z"}"#
        let owned = Data(#"{"agentId":"cloud_agent_owned","ownerAccountId":"acct_me","accessScope":"participant_conversations","status":"active","name":"Research Agent","role":"Researcher","description":null,"systemPrompt":"Help","sourceSummary":null,"boundaries":[],"resources":[],"skills":[{"name":"research","description":"Research sources","content":"Verify every source."}],"modelRouting":{"defaultModel":"codex/gpt-5.6-sol","thinking":"high","tools":["web-search"],"plugins":["citations"]},"createdAt":"2026-08-08T00:00:00Z","updatedAt":"2026-08-08T00:00:00Z","archivedAt":null,"avatar":\#(avatar)}"#.utf8)
        let shared = Data(#"{"agentId":"cloud_agent_shared","ownerAccountId":"acct_maya","ownerDisplayName":"Maya","accessScope":"participant_conversations","name":"Support Agent","role":"Support","description":"Answers product questions","updatedAt":"2026-08-08T00:00:00Z","avatar":\#(avatar)}"#.utf8)

        let decoder = JSONDecoder()
        let ownedAgent = try decoder.decode(CloudAgent.self, from: owned)
        XCTAssertEqual(ownedAgent.status, "active")
        XCTAssertEqual(ownedAgent.modelRouting.defaultModel, "codex/gpt-5.6-sol")
        XCTAssertEqual(ownedAgent.modelRouting.thinking, "high")
        XCTAssertEqual(ownedAgent.modelRouting.tools, ["web-search"])
        XCTAssertEqual(ownedAgent.modelRouting.plugins, ["citations"])
        XCTAssertEqual(ownedAgent.skills.first?.content, "Verify every source.")
        let draft = CloudAgentDraft(agent: ownedAgent)
        XCTAssertEqual(draft.tools.map(\.name), ["web-search"])
        XCTAssertEqual(draft.plugins.map(\.name), ["citations"])
        XCTAssertNil(draft.modelRouting.tools)
        XCTAssertNil(draft.modelRouting.plugins)
        XCTAssertEqual(try decoder.decode(CloudAgent.self, from: shared).ownerDisplayName, "Maya")
    }

    func testContactRequestAndSessionActivityUseProductionCloudShapes() throws {
        let requestPayload = Data(#"{"requestId":"req_1","fromAccountId":"acct_maya","toAccountId":"acct_me","status":"pending","direction":"incoming","message":"Let's connect","createdAt":"2026-08-09T10:00:00Z","decidedAt":null,"counterpart":{"accountId":"acct_maya","kordiId":"284106395","displayName":"Maya","avatarUrl":null,"nodeId":null,"createdAt":"2026-08-09T10:00:00Z"}}"#.utf8)
        let activityPayload = Data(#"{"tasks":[{"taskActivityId":"taskact_1","sessionId":"session:one","taskId":"task_1","title":"Review build","summary":"Check TestFlight","status":"active","createdByAccountId":"acct_me","targetAccountId":null,"participants":[],"artifactIds":[],"responseMessageId":null,"createdAt":"2026-08-09T10:00:00Z","updatedAt":"2026-08-09T10:01:00Z","archivedAt":null}],"artifacts":[{"artifactActivityId":"artifactact_1","sessionId":"session:one","artifactId":"docs/plan.md","name":"plan.md","path":"docs/plan.md","kind":"document","category":"artifact","summary":"Release plan","createdByAccountId":"acct_me","sourceMessageId":"msg_1","attachmentId":null,"contentType":"text/markdown","sizeBytes":42,"createdAt":"2026-08-09T10:00:00Z","updatedAt":"2026-08-09T10:01:00Z","archivedAt":null}]}"#.utf8)

        let request = try JSONDecoder().decode(CloudContactRequest.self, from: requestPayload)
        let activity = try JSONDecoder().decode(CloudSessionActivity.self, from: activityPayload)

        XCTAssertTrue(request.isIncoming)
        XCTAssertEqual(request.counterpart?.preferredName, "Maya")
        XCTAssertEqual(activity.tasks.first?.title, "Review build")
        XCTAssertEqual(activity.artifacts.first?.attachmentId, nil)
    }

    @MainActor
    func testPreviewContactRequestActionsStayLocalAndInteractive() async throws {
        let acceptModel = AppModel(previewMode: true)
        let acceptRequest = try XCTUnwrap(acceptModel.contactRequests.first(where: \.isIncoming))

        XCTAssertNotNil(acceptModel.contactRequests.first { !$0.isIncoming })

        await acceptModel.acceptContactRequest(acceptRequest)

        XCTAssertFalse(acceptModel.contactRequests.contains { $0.id == acceptRequest.id })

        let declineModel = AppModel(previewMode: true)
        let declineRequest = try XCTUnwrap(declineModel.contactRequests.first(where: \.isIncoming))

        await declineModel.rejectContactRequest(declineRequest)

        XCTAssertFalse(declineModel.contactRequests.contains { $0.id == declineRequest.id })
    }

    func testContactPresenceDecodesLastSeenTimestamp() throws {
        let payload = Data(#"{"accountId":"acct_maya","status":"offline","updatedAt":"2026-08-17T10:00:00Z","lastSeenAt":"2026-08-17T09:55:00Z"}"#.utf8)

        let presence = try JSONDecoder().decode(CloudPresenceAccount.self, from: payload)

        XCTAssertEqual(presence.status, .offline)
        XCTAssertEqual(presence.lastSeenAt, "2026-08-17T09:55:00Z")
    }

    func testContactPresencePresentationMatchesTelegramStyle() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let locale = Locale(identifier: "en_US")
        let now = parseCloudDate("2026-08-17T13:00:00Z")

        XCTAssertEqual(
            ContactPresencePresentation.label(
                for: CloudPresenceAccount(
                    accountId: "acct_maya",
                    status: .online,
                    lastSeenAt: nil
                ),
                now: now,
                calendar: calendar,
                locale: locale
            ),
            "online"
        )
        XCTAssertEqual(
            ContactPresencePresentation.label(
                for: CloudPresenceAccount(
                    accountId: "acct_maya",
                    status: .offline,
                    lastSeenAt: "2026-08-17T12:55:00Z"
                ),
                now: now,
                calendar: calendar,
                locale: locale
            ),
            "last seen today at 12:55\u{202F}PM"
        )
        XCTAssertEqual(
            ContactPresencePresentation.label(
                for: CloudPresenceAccount(
                    accountId: "acct_maya",
                    status: .offline,
                    lastSeenAt: "2026-08-17T12:59:30Z"
                ),
                now: now,
                calendar: calendar,
                locale: locale
            ),
            "last seen just now"
        )
        XCTAssertEqual(
            ContactPresencePresentation.label(
                for: CloudPresenceAccount(
                    accountId: "acct_maya",
                    status: .offline,
                    lastSeenAt: "2026-08-17T12:59:30Z"
                ),
                now: parseCloudDate("2026-08-17T13:01:00Z"),
                calendar: calendar,
                locale: locale
            ),
            "last seen today at 12:59\u{202F}PM"
        )
        XCTAssertEqual(
            ContactPresencePresentation.label(
                for: CloudPresenceAccount(
                    accountId: "acct_maya",
                    status: .offline,
                    lastSeenAt: "2026-08-16T12:55:00Z"
                ),
                now: now,
                calendar: calendar,
                locale: locale
            ),
            "last seen yesterday at 12:55\u{202F}PM"
        )
        XCTAssertEqual(
            ContactPresencePresentation.label(
                for: CloudPresenceAccount(
                    accountId: "acct_maya",
                    status: .offline,
                    lastSeenAt: "2026-08-10T12:55:00Z"
                ),
                now: now,
                calendar: calendar,
                locale: locale
            ),
            "last seen Aug 10 at 12:55\u{202F}PM"
        )
        XCTAssertEqual(
            ContactPresencePresentation.label(
                for: nil,
                now: now,
                calendar: calendar,
                locale: locale
            ),
            "last seen recently"
        )
    }

    func testCloudMessageDecodesWithoutAttachmentModel() throws {
        let payload = Data(#"{"messageId":"msg_1","fromAccountId":"acct_me","toAccountId":"acct_maya","body":"Hello","createdAt":"2026-08-08T00:00:00Z","deliveredAt":"2026-08-08T00:00:01Z","readAt":null,"direction":"outgoing","sessionId":"session:direct-person:acct_maya:acct_me","attachments":[]}"#.utf8)
        let message = try JSONDecoder().decode(CloudMessageDTO.self, from: payload)
        XCTAssertEqual(message.body, "Hello")
        XCTAssertEqual(message.direction, "outgoing")
        XCTAssertEqual(message.attachments, [])
        XCTAssertNil(message.messageKind)
    }

    func testCloudMessageAttachmentDecodesMemeMetadataAndLegacyFallback() throws {
        let decoder = JSONDecoder()
        let memePayload = Data(#"{"attachmentId":"att_meme","name":"reaction.webp","kind":"image","subtype":"meme","altText":"A character celebrates a successful deployment.","mimeType":"image/webp","sizeBytes":42,"widthPixels":512,"heightPixels":384,"downloadUrl":null,"previewUrl":null}"#.utf8)
        let legacyPayload = Data(#"{"attachmentId":"att_legacy","name":"photo.jpg","kind":"image","mimeType":"image/jpeg","sizeBytes":42,"downloadUrl":null,"previewUrl":null}"#.utf8)

        let meme = try decoder.decode(CloudMessageAttachment.self, from: memePayload)
        let legacy = try decoder.decode(CloudMessageAttachment.self, from: legacyPayload)

        XCTAssertEqual(meme.subtype, .meme)
        XCTAssertEqual(meme.altText, "A character celebrates a successful deployment.")
        XCTAssertEqual(meme.chatAttachment.kind, .image)
        XCTAssertEqual(meme.chatAttachment.widthPixels, 512)
        XCTAssertEqual(meme.chatAttachment.heightPixels, 384)
        XCTAssertNil(legacy.subtype)
        XCTAssertNil(legacy.altText)
        XCTAssertEqual(legacy.chatAttachment.kind, .image)
    }

    func testCanonicalChatContentEncodesMemeMetadataForOtherClients() throws {
        let content = CloudChatContent(
            body: "",
            attachments: [CloudMessageAttachment(
                attachmentId: "att_meme",
                name: "reaction.gif",
                kind: "image",
                subtype: .meme,
                altText: "A developer celebrates after the final test passes.",
                mimeType: "image/gif",
                sizeBytes: 1_024,
                widthPixels: 640,
                heightPixels: 360,
                downloadUrl: nil,
                previewUrl: nil
            )]
        )
        let encoded = try JSONEncoder().encode(content)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let attachments = try XCTUnwrap(object["legacy_attachments"] as? [[String: Any]])

        XCTAssertEqual(attachments.first?["subtype"] as? String, "meme")
        XCTAssertEqual(
            attachments.first?["altText"] as? String,
            "A developer celebrates after the final test passes."
        )
        XCTAssertEqual(attachments.first?["widthPixels"] as? Int, 640)
        XCTAssertEqual(attachments.first?["heightPixels"] as? Int, 360)
    }

    func testCloudCallActivityMessageKeepsItsWireKind() throws {
        let callID = "0198aabc-8b27-7a30-8cba-215495609c7a"
        let payload = Data(#"{"messageId":"msg_call","fromAccountId":"acct_maya","toAccountId":"acct_me","body":"Maya started a video chat.","createdAt":"2026-08-14T10:00:00Z","deliveredAt":"2026-08-14T10:00:01Z","readAt":null,"direction":"incoming","sessionId":"session:group","attachments":[],"kind":"call.started.0198aabc-8b27-7a30-8cba-215495609c7a"}"#.utf8)

        let message = try JSONDecoder().decode(CloudMessageDTO.self, from: payload)
        let activity = try XCTUnwrap(ChatCallActivity(messageKind: message.messageKind))

        XCTAssertEqual(message.messageKind, "call.started.\(callID)")
        XCTAssertEqual(activity.event, .started)
        XCTAssertEqual(activity.callId, callID)
        XCTAssertEqual(message.body, "Maya started a video chat.")
    }

    func testCallActivityMatchesOnlyItsOwnActiveCall() throws {
        let callID = "0198aabc-8b27-7a30-8cba-215495609c7a"
        let otherCallID = "0198aabc-8b27-7a30-8cba-215495609c7b"
        let activity = try XCTUnwrap(ChatCallActivity(
            messageKind: ChatCallActivity.messageKind(for: .started, callId: callID)
        ))
        let endedActivity = try XCTUnwrap(ChatCallActivity(
            messageKind: ChatCallActivity.messageKind(for: .ended, callId: callID)
        ))
        let activeCall = CloudCall(
            id: callID,
            conversationId: "conversation",
            kind: .video,
            state: .active,
            createdByAccountId: "acct_maya",
            createdAt: "2026-08-14T10:00:00Z",
            answeredAt: "2026-08-14T10:00:01Z",
            endedAt: nil,
            participants: []
        )
        let otherCall = CloudCall(
            id: otherCallID,
            conversationId: "conversation",
            kind: .video,
            state: .active,
            createdByAccountId: "acct_maya",
            createdAt: "2026-08-14T10:00:00Z",
            answeredAt: "2026-08-14T10:00:01Z",
            endedAt: nil,
            participants: []
        )

        XCTAssertTrue(activity.matchesActiveCall(activeCall))
        XCTAssertFalse(activity.matchesActiveCall(otherCall))
        XCTAssertFalse(endedActivity.matchesActiveCall(activeCall))
    }

    func testCallSnapshotOrderingRejectsDelayedStateAfterEnd() {
        let active = CloudCall(
            id: "call-ordering",
            revision: 2,
            conversationId: "conversation",
            kind: .video,
            state: .active,
            createdByAccountId: "acct_maya",
            createdAt: "2026-08-14T10:00:00Z",
            answeredAt: "2026-08-14T10:00:01Z",
            endedAt: nil,
            participants: []
        )
        let delayed = CloudCall(
            id: active.id,
            revision: 1,
            conversationId: active.conversationId,
            kind: active.kind,
            state: .ringing,
            createdByAccountId: active.createdByAccountId,
            createdAt: active.createdAt,
            answeredAt: nil,
            endedAt: nil,
            participants: []
        )
        let ended = CloudCall(
            id: active.id,
            revision: 3,
            conversationId: active.conversationId,
            kind: active.kind,
            state: .ended,
            createdByAccountId: active.createdByAccountId,
            createdAt: active.createdAt,
            answeredAt: active.answeredAt,
            endedAt: "2026-08-14T10:01:00Z",
            participants: []
        )

        XCTAssertFalse(CloudCallSnapshotOrdering.shouldApply(
            delayed,
            after: active,
            endedCallIDs: []
        ))
        XCTAssertTrue(CloudCallSnapshotOrdering.shouldApply(
            ended,
            after: active,
            endedCallIDs: []
        ))
        XCTAssertFalse(CloudCallSnapshotOrdering.shouldApply(
            active,
            after: nil,
            endedCallIDs: [active.id]
        ))
    }

    func testCachedChatMessagePreservesCallActivityKind() throws {
        let callID = "0198aabc-8b27-7a30-8cba-215495609c7a"
        let original = ChatMessage(
            id: "call-event",
            conversationId: "conversation",
            author: .person,
            authorName: "Maya",
            text: "The video call ended.",
            createdAt: Date(timeIntervalSince1970: 1_000),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: ChatCallActivity.messageKind(for: .ended, callId: callID)
        )

        let restored = try JSONDecoder().decode(
            ChatMessage.self,
            from: JSONEncoder().encode(original)
        )

        XCTAssertEqual(restored.messageKind, original.messageKind)
        XCTAssertEqual(restored.callActivity?.event, .ended)
        XCTAssertEqual(restored.callActivity?.callId, callID)
    }

    func testCallSessionDecodesParticipantsAndShortLivedMediaConnection() throws {
        let payload = Data(#"{"call":{"id":"0198aabc-8b27-7a30-8cba-215495609c7a","conversation_id":"0198aabc-4b58-7770-b486-a8e3fb4d0b7e","kind":"meeting","state":"active","created_by_account_id":"acct_maya","created_at":"2026-08-14T10:00:00Z","answered_at":null,"ended_at":null,"participants":[{"account_id":"acct_maya","display_name":"Maya","avatar_url":null,"state":"joined","joined_at":"2026-08-14T10:00:00Z","left_at":null},{"account_id":"acct_me","display_name":"Alex","avatar_url":null,"state":"invited","joined_at":null,"left_at":null}]},"media":{"url":"wss://media.example.test","token":"short-lived-token"}}"#.utf8)

        let response = try JSONDecoder().decode(CloudCallSessionResponse.self, from: payload)

        XCTAssertEqual(response.call.kind, .meeting)
        XCTAssertEqual(response.call.state, .active)
        XCTAssertEqual(response.call.participants.map(\.state), ["joined", "invited"])
        XCTAssertEqual(response.media.url, "wss://media.example.test")
    }

    func testRealtimeTicketCarriesTheBoundDeviceWithoutExposingTheSessionToken() throws {
        let payload = Data(#"{"ticket":"single-use","device_id":"device-ios","expires_at":"2026-08-20T10:00:00Z"}"#.utf8)
        let ticket = try JSONDecoder().decode(CloudChatRealtimeTicket.self, from: payload)

        XCTAssertEqual(ticket.ticket, "single-use")
        XCTAssertEqual(ticket.deviceId, "device-ios")
    }

    func testCloudMessageDecodesAttachmentMetadataUsedByMacOS() throws {
        let payload = Data(#"{"messageId":"msg_file","fromAccountId":"acct_me","toAccountId":"acct_maya","body":"Review this","createdAt":"2026-08-08T00:00:00Z","deliveredAt":"2026-08-08T00:00:01Z","readAt":null,"direction":"outgoing","sessionId":"session:files","attachments":[{"attachmentId":"att_1","name":"launch-plan.pdf","kind":"file","mimeType":"application/pdf","sizeBytes":2048,"downloadUrl":null,"previewUrl":null}]}"#.utf8)
        let message = try JSONDecoder().decode(CloudMessageDTO.self, from: payload)

        XCTAssertEqual(message.attachments.first?.attachmentId, "att_1")
        XCTAssertEqual(message.attachments.first?.name, "launch-plan.pdf")
        XCTAssertEqual(message.attachments.first?.sizeBytes, 2_048)
    }

    func testAgentExecutionLocationNamesOnlyRemoteHosts() {
        XCTAssertEqual(AgentExecutionLocation.cloud.activeLabel, "Running in Kordi Cloud")
        XCTAssertEqual(AgentExecutionLocation.mac(label: "your Mac").activeLabel, "Running on your Mac")
        XCTAssertFalse(AgentExecutionLocation.cloud.activeLabel.localizedCaseInsensitiveContains("iPhone"))
    }

    func testSyncEventDecodesFullHistoricalMessagePayload() throws {
        let payload = Data(#"{"eventId":"42","eventType":"message.upsert","peerAccountId":"acct_me","messageId":"msg_old","payload":{"message":{"messageId":"msg_old","fromAccountId":"acct_me","toAccountId":"acct_me","body":"Older session content","sessionId":"session:desktop:older","createdAt":"2026-08-01T00:00:00Z","deliveredAt":"2026-08-01T00:00:01Z","readAt":"2026-08-01T00:00:01Z","direction":"outgoing","attachments":[]}},"occurredAt":"2026-08-01T00:00:01Z"}"#.utf8)

        let event = try JSONDecoder().decode(CloudSyncEvent.self, from: payload)

        XCTAssertEqual(event.payload?.message?.sessionId, "session:desktop:older")
        XCTAssertEqual(event.payload?.message?.body, "Older session content")
    }

    func testSyncEventDecodesAgentForkLineagePayload() throws {
        let payload = Data(#"{"eventId":"43","eventType":"session-forked","peerAccountId":"session:self-agent:root","messageId":null,"payload":{"forkSessionId":"session:fork:child","parentSessionId":"session:self-agent:root","parentMessageId":"msg_root","createdByAccountId":"acct_me","createdAt":"2026-08-09T10:00:00Z"},"occurredAt":"2026-08-09T10:00:00Z"}"#.utf8)

        let event = try JSONDecoder().decode(CloudSyncEvent.self, from: payload)

        XCTAssertEqual(event.payload?.forkSessionId, "session:fork:child")
        XCTAssertEqual(event.payload?.parentSessionId, "session:self-agent:root")
        XCTAssertEqual(event.payload?.parentMessageId, "msg_root")
    }

    func testDeviceListDecodesReviewAndSyncStateWithoutKeyMaterial() throws {
        let payload = Data(#"{"devices":[{"deviceId":"device_1","displayName":"Ada’s iPhone","platform":"ios","osVersion":"27.0","appVersion":"1.0","createdAt":"2026-08-13T09:00:00Z","lastActiveAt":"2026-08-13T09:05:00Z","authorizationState":"pending_review","currentDevice":false,"sessionExpiresAt":"2026-09-12T09:00:00Z","approximateLocation":null,"syncStatus":{"protocolVersion":2,"lastAppliedSequence":42,"lastSuccessfulCatchUpAt":"2026-08-13T09:04:00Z"}}]}"#.utf8)

        let response = try JSONDecoder().decode(CloudDeviceListResponse.self, from: payload)
        let device = try XCTUnwrap(response.devices.first)

        XCTAssertTrue(device.needsReview)
        XCTAssertFalse(device.currentDevice)
        XCTAssertEqual(device.syncStatus.protocolVersion, 2)
        XCTAssertEqual(device.syncStatus.lastAppliedSequence, 42)
    }

    func testAuthSessionAcceptsDeviceBindingAndLegacyResponses() throws {
        let decoder = JSONDecoder()
        let bound = try decoder.decode(
            CloudSession.self,
            from: Data(#"{"token":"token","expiresAt":"2026-09-12T09:00:00Z","deviceId":"device_1"}"#.utf8)
        )
        let legacy = try decoder.decode(
            CloudSession.self,
            from: Data(#"{"token":"legacy","expiresAt":"2026-09-12T09:00:00Z"}"#.utf8)
        )

        XCTAssertEqual(bound.deviceId, "device_1")
        XCTAssertNil(legacy.deviceId)
    }

    func testDeviceLifecycleEventCarriesTheAffectedInstallation() throws {
        let payload = Data(#"{"eventId":"44","eventType":"device.added","peerAccountId":"acct_me","messageId":null,"payload":{"deviceId":"device_other","authorizationState":"pending_review"},"occurredAt":"2026-08-13T09:00:00Z"}"#.utf8)

        let event = try JSONDecoder().decode(CloudSyncEvent.self, from: payload)

        XCTAssertEqual(event.payload?.deviceId, "device_other")
    }

    func testChatConversationDecodesDurableForkLineage() throws {
        let payload = Data(#"{"id":"conversation-child","kind":"ai","shared_title":"Child","version":3,"created_by_account_id":"acct_me","legacy_session_id":"session:fork:child","group_space_id":"session:group:root","group_title":"Canonical group","forked_from_session_id":"session:self-agent:root","forked_from_message_id":"msg_root","latest_message_sequence":4,"created_at":"2026-08-09T10:00:00Z","updated_at":"2026-08-09T10:01:00Z","members":[{"account_id":"acct_me","display_name":"Me","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":4,"last_read_sequence":4,"joined_at":"2026-08-09T10:00:00Z","left_at":null}],"preferences":{"conversation_id":"conversation-child","account_id":"acct_me","personal_title":null,"version":1}}"#.utf8)

        let conversation = try JSONDecoder().decode(CloudChatConversation.self, from: payload)

        XCTAssertEqual(conversation.legacySessionId, "session:fork:child")
        XCTAssertEqual(conversation.groupSpaceId, "session:group:root")
        XCTAssertEqual(conversation.groupTitle, "Canonical group")
        XCTAssertEqual(conversation.forkedFromSessionId, "session:self-agent:root")
        XCTAssertEqual(conversation.forkedFromMessageId, "msg_root")
    }

    func testCanonicalMessageDecodesGroupedReactionActors() throws {
        let payload = Data(#"{"id":"msg_1","client_message_id":"client_1","conversation_id":"conversation_1","conversation_sequence":1,"sender_account_id":"acct_peer","kind":"text","content":{"schema":1,"blocks":[{"type":"text","text":"Hello"}]},"reply_to_message_id":null,"attachment_ids":[],"version":1,"generation_status":null,"provider_response_id":null,"created_at":"2026-08-24T00:00:00Z","edited_at":null,"deleted_at":null,"reactions":[{"reaction":"👍","account_ids":["acct_a","acct_b"]}]}"#.utf8)

        let message = try JSONDecoder().decode(CloudChatMessage.self, from: payload)

        XCTAssertEqual(message.reactions?.first?.reaction, "👍")
        XCTAssertEqual(message.reactions?.first?.accountIds, ["acct_a", "acct_b"])
    }

    func testCachedLegacyMessageDefaultsMissingReactionsToEmpty() throws {
        let payload = Data(#"{"messageId":"msg_legacy","fromAccountId":"acct_peer","toAccountId":"acct_me","body":"Hello","createdAt":"2026-08-24T00:00:00Z","deliveredAt":null,"readAt":null,"direction":"incoming","sessionId":"session_1","attachments":[]}"#.utf8)

        let message = try JSONDecoder().decode(CloudMessageDTO.self, from: payload)

        XCTAssertTrue(message.reactions.isEmpty)
    }
}


final class CanonicalHistoryProjectionTests: XCTestCase {
    private func project(kind: String, history: Any?) async throws -> CloudMessageDTO {
        var content: [String: Any] = ["schema": 1, "blocks": [["type": "text", "text": "Synthetic historical message"]]]
        if let history { content["canonical_history"] = history }
        let message: [String: Any] = [
            "id": "message", "client_message_id": "upload", "conversation_id": "conversation",
            "conversation_sequence": 8, "sender_account_id": "me", "kind": kind,
            "content": content, "attachment_ids": [], "version": 1,
            "created_at": "2026-09-11T07:30:00Z",
        ]
        let conversation: [String: Any] = [
            "id": "conversation", "kind": "ai", "version": 1,
            "created_by_account_id": "me", "legacy_session_id": "session:agent:history",
            "latest_message_sequence": 8, "created_at": "2026-08-01T00:00:00Z",
            "updated_at": "2026-09-11T07:30:00Z", "members": [],
            "preferences": ["conversation_id": "conversation", "account_id": "me", "version": 1],
        ]
        let decoder = JSONDecoder()
        let wire = try decoder.decode(CloudChatMessage.self, from: JSONSerialization.data(withJSONObject: message))
        let chat = try decoder.decode(CloudChatConversation.self, from: JSONSerialization.data(withJSONObject: conversation))
        return await CloudAPIClient().legacyMessage(from: wire, conversation: chat, viewerAccountId: "me")
    }

    func testImportedUserAndAgentMessagesKeepOriginalDateAndIdentity() async throws {
        for kind in ["canonical-history-user", "canonical-history-agent"] {
            let message = try await project(kind: kind, history: [
                "local_message_id": " original-local-id ",
                "original_created_at": "2026-08-01T12:00:00.123Z",
            ])
            XCTAssertEqual(message.createdAt, "2026-08-01T12:00:00.123Z")
            XCTAssertEqual(message.canonicalHistoryLocalMessageId, "original-local-id")
            XCTAssertEqual(message.messageId, "message")
            XCTAssertEqual(message.conversationSequence, 8)
            let restored = try JSONDecoder().decode(CloudMessageDTO.self, from: JSONEncoder().encode(message))
            XCTAssertEqual(restored, message)
        }
    }

    func testMalformedOrMissingHistoryFallsBackWithoutDroppingMessage() async throws {
        let histories: [Any?] = [nil, "invalid", ["local_message_id": "local", "original_created_at": "invalid"],
            ["local_message_id": " ", "original_created_at": "2026-08-01T00:00:00Z"],
            ["local_message_id": 12, "original_created_at": "2026-08-01T00:00:00Z"]]
        for history in histories {
            let message = try await project(kind: "canonical-history-user", history: history)
            XCTAssertEqual(message.createdAt, "2026-09-11T07:30:00Z")
            XCTAssertNil(message.canonicalHistoryLocalMessageId)
            XCTAssertEqual(message.body, "Synthetic historical message")
        }
    }

    func testOrdinaryMessagesKeepTheirServerDate() async throws {
        let message = try await project(kind: "text", history: [
            "local_message_id": "local", "original_created_at": "2026-08-01T00:00:00Z",
        ])
        XCTAssertEqual(message.createdAt, "2026-09-11T07:30:00Z")
        XCTAssertNil(message.canonicalHistoryLocalMessageId)
    }
}
