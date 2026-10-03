import XCTest
@testable import Kordi

/// Client side of the server's content removal contract: the capability
/// version, content-free removal events, deleted quote sources, and local
/// cache eviction. The delete choices are in MessageDeletePresentationTests.
final class ContentRemovalTests: XCTestCase {
    // MARK: Capability version

    func testSyncAndBootstrapResponsesDecodeTheContentRemovalVersion() throws {
        let sync = try JSONDecoder().decode(
            CloudChatSyncResponse.self,
            from: Data(ContentRemovalFixtures.syncBody(events: "", version: 1).utf8)
        )
        XCTAssertEqual(sync.contentRemovalVersion, 1)
        let bootstrap = try JSONDecoder().decode(
            CloudChatBootstrapResponse.self,
            from: Data(ContentRemovalFixtures.bootstrapBody(version: 0).utf8)
        )
        XCTAssertEqual(bootstrap.contentRemovalVersion, 0)
    }

    func testOlderServersWithoutTheFieldStillDecode() throws {
        let sync = try JSONDecoder().decode(
            CloudChatSyncResponse.self,
            from: Data(ContentRemovalFixtures.syncBody(events: "", version: nil).utf8)
        )
        XCTAssertNil(sync.contentRemovalVersion)
        let bootstrap = try JSONDecoder().decode(
            CloudChatBootstrapResponse.self,
            from: Data(ContentRemovalFixtures.bootstrapBody(version: nil).utf8)
        )
        XCTAssertNil(bootstrap.contentRemovalVersion)
    }

    func testSyncPassesTheVersionThroughFromBootstrapAndIncrementalSync() async throws {
        let client = ContentRemovalFixtures.client(VersionReportingURLProtocol.self)

        let bootstrap = try await client.sync(token: "session", cursor: "0")
        let incremental = try await client.sync(token: "session", cursor: "4")

        XCTAssertEqual(bootstrap.contentRemovalVersion, 1)
        XCTAssertEqual(incremental.contentRemovalVersion, 1)
        XCTAssertEqual(incremental.cursor, "5")
    }

    func testAppModelTracksTheVersionAndResetsItPerAccount() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let model = try String(contentsOf: root.appendingPathComponent("Kordi/App/AppModel.swift"), encoding: .utf8)

        XCTAssertTrue(model.contains("@Published private(set) var serverContentRemovalVersion = 0"))
        XCTAssertTrue(model.contains("let removalVersion = response.contentRemovalVersion ?? 0"))
        let accountObserver = try XCTUnwrap(model.range(of: "if oldValue?.accountId != account?.accountId {"))
        XCTAssertTrue(model[accountObserver.upperBound...].prefix(240).contains("serverContentRemovalVersion = 0"))
    }

    // MARK: Content-free events

    func testContentFreeDeletedAndHiddenEventsProjectDeletions() async throws {
        let client = ContentRemovalFixtures.client(RemovalEventsURLProtocol.self)

        let response = try await client.sync(token: "session", cursor: "10")

        XCTAssertEqual(response.events.map(\.eventType), ["message.deleted", "message.deleted"])
        XCTAssertEqual(response.events.map(\.messageId), ["message-deleted", "message-hidden"])
        XCTAssertEqual(response.events.map { $0.payload?.messageId }, ["message-deleted", "message-hidden"])
        XCTAssertEqual(response.events.last?.payload?.sessionId, "session:group:removal")
        XCTAssertTrue(response.events.allSatisfy { $0.payload?.message == nil })
    }

    func testNoncriticalSupersededEventYieldsNoEventsAndDoesNotThrow() async throws {
        let client = ContentRemovalFixtures.client(SupersededEventURLProtocol.self)

        let response = try await client.sync(token: "session", cursor: "20")

        XCTAssertTrue(response.events.isEmpty)
        XCTAssertEqual(response.cursor, "21")
    }

    func testUnknownCriticalEventStillAsksForAnUpdate() async {
        let client = ContentRemovalFixtures.client(UnknownCriticalEventURLProtocol.self)

        do {
            _ = try await client.sync(token: "session", cursor: "30")
            XCTFail("An unknown critical event must stop sync.")
        } catch let error as CloudAPIError {
            XCTAssertEqual(error.code, "CLIENT_UPDATE_REQUIRED")
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    // MARK: Deleted quote sources

    func testMessageActionSourceDecodesWithAndWithoutSourceDeleted() throws {
        let scrubbed = #"{"sourceSessionId":"session:direct","sourceMessageId":"m1","senderLabel":"Maya","textPreview":"","attachmentCount":0,"createdAtMs":1786000000000,"sourceDeleted":true}"#
        let legacy = #"{"sourceSessionId":"session:direct","sourceMessageId":"m1","senderLabel":"Maya","textPreview":"Hello","attachmentCount":1}"#

        let deleted = try JSONDecoder().decode(MessageActionSource.self, from: Data(scrubbed.utf8))
        let live = try JSONDecoder().decode(MessageActionSource.self, from: Data(legacy.utf8))

        XCTAssertEqual(deleted.sourceDeleted, true)
        XCTAssertEqual(deleted.textPreview, "")
        XCTAssertNil(deleted.mentions)
        XCTAssertNil(live.sourceDeleted)
        XCTAssertEqual(live.textPreview, "Hello")
        // Replies this app writes never claim a deleted source.
        let encoded = try JSONEncoder().encode(live)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("sourceDeleted"))
    }

    func testDirectGroupAndAgentResponseEnvelopesKeepTheDeletedSourceFlag() throws {
        let source = #"{"sourceSessionId":"session:direct","sourceMessageId":"m1","senderLabel":"Maya","textPreview":"","attachmentCount":0,"sourceDeleted":true}"#
        let action = #"{"schemaVersion":1,"kind":"quote","source":\#(source)}"#
        let direct = #"{"schemaVersion":1,"kind":"message","text":"Replying","messageAction":\#(action)}"#
        let body = CloudMessageCodec.directPrefix + ContentRemovalFixtures.base64URL(direct)
        XCTAssertEqual(CloudMessageCodec.directEnvelope(body)?.messageAction?.source.sourceDeleted, true)
        let response = #"{"text":"Answer","messageAction":{"schemaVersion":1,"kind":"thread","source":\#(source)}}"#
        let responseBody = CloudMessageCodec.agentResponsePrefix + ContentRemovalFixtures.base64URL(response)
        XCTAssertEqual(CloudMessageCodec.agentResponseMessageAction(responseBody)?.source.sourceDeleted, true)
        XCTAssertEqual(CloudMessageCodec.displayText(responseBody), "Answer")

        let groupSource = MessageActionSource(
            sourceSessionId: "session:group", sourceMessageId: "group-message", senderLabel: "Maya",
            textPreview: "", attachmentCount: 0, sourceDeleted: true
        )
        let participant = CloudGroupParticipant(accountId: "acct_me", displayName: "Me", avatarUrl: nil, role: "owner")
        let envelope = CloudGroupControlEnvelope(
            kind: "group-message", groupId: "group", groupSpaceId: nil, groupTitle: "Group",
            createdByAccountId: "acct_me", actor: participant, participants: [participant],
            message: CloudGroupMessagePayload(
                id: "reply", senderAccountId: "acct_me", text: "Replying", createdAtMs: 1_786_000_000_000,
                senderKind: "human", senderDisplayName: "Me", deliveryState: "complete",
                replyToMessageId: "group-message", requestId: nil, messageAction: .quote(groupSource)
            )
        )
        let decoded = try XCTUnwrap(CloudGroupMessageCodec.parse(CloudGroupMessageCodec.encode(envelope)))
        XCTAssertEqual(decoded.message?.messageAction?.source.sourceDeleted, true)
    }

    func testDeletedSourcePreviewReplacesTheQuotedText() {
        XCTAssertEqual(
            MessageQuotePresentation.previewText("", attachmentCount: 0, sourceDeleted: true),
            "Original message was deleted"
        )
        XCTAssertEqual(
            MessageQuotePresentation.previewText("Stale words", attachmentCount: 2, sourceDeleted: true),
            "Original message was deleted"
        )
        XCTAssertEqual(MessageQuotePresentation.previewText("Hello  there", attachmentCount: 0), "Hello there")
        XCTAssertEqual(
            MessageQuotePresentation.previewText("Hello", attachmentCount: 0, sourceDeleted: false),
            "Hello"
        )
    }

    func testDeletedQuoteIsPlainTextWithoutANavigationHint() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Kordi/Features/Conversation/MessageBubble.swift"),
            encoding: .utf8
        )
        let start = try XCTUnwrap(source.range(of: "private func deletedQuoteLine("))
        let end = try XCTUnwrap(source.range(of: "private func quoteButton(", range: start.upperBound..<source.endIndex))
        let body = String(source[start.lowerBound..<end.lowerBound])

        XCTAssertTrue(source.contains("if source.sourceDeleted == true { deletedQuoteLine(source) } else { quoteButton(source) }"))
        XCTAssertFalse(body.contains("Button"))
        XCTAssertFalse(body.contains("accessibilityHint"))
        XCTAssertTrue(body.contains(".italic()"))
        XCTAssertTrue(body.contains(".foregroundStyle(.secondary)"))
        XCTAssertTrue(body.contains(".accessibilityElement(children: .combine)"))
        XCTAssertTrue(body.contains(".accessibilityLabel(\"Quoted message from \\(senderLabel): \\(previewText)\")"))
    }

    // MARK: Local cache eviction

    func testReleasedIdsSkipAttachmentsAndLivePhotoCompanionsStillUsed() {
        let live = LivePhotoAttachment(
            video: LivePhotoResource(attachmentId: "live-video", name: "Live.mov", mimeType: "video/quicktime", sizeBytes: 1),
            playback: LivePhotoResource(attachmentId: "live-playback", name: "Live.mp4", mimeType: "video/mp4", sizeBytes: 1)
        )
        let removed = ContentRemovalFixtures.message("removed", attachments: [
            ContentRemovalFixtures.attachment("shared"),
            ContentRemovalFixtures.attachment("only-removed", livePhoto: live),
        ])
        let remaining = ContentRemovalFixtures.message("remaining", attachments: [ContentRemovalFixtures.attachment("shared")])
        let candidates = MessageAttachmentReferences.ids(in: removed)

        XCTAssertEqual(candidates, ["shared", "only-removed", "live-video", "live-playback"])
        XCTAssertEqual(
            MessageAttachmentReferences.released(candidates, keptBy: [CloudMessageDTO](), rendered: [remaining]),
            ["only-removed", "live-video", "live-playback"]
        )
        XCTAssertEqual(
            MessageAttachmentReferences.released([], keptBy: [CloudMessageDTO](), rendered: [remaining]),
            []
        )
    }

    func testSyncedMessagesAndVoiceAudioKeepTheirCachedFiles() throws {
        let voice = VoiceMessage(mediaId: "voice-audio", mimeType: "audio/mp4", durationMs: 1_000,
                                 waveformSamples: [], transcript: "")
        let synced = CloudMessageDTO(
            messageId: "synced", fromAccountId: "acct_me", toAccountId: "acct_peer", body: "Hi",
            createdAt: "2026-10-01T00:00:00Z", deliveredAt: nil, readAt: nil, direction: "outgoing",
            sessionId: "session:direct", voiceMessage: voice
        )
        XCTAssertEqual(MessageAttachmentReferences.ids(in: synced), ["voice-audio"])
        XCTAssertEqual(
            MessageAttachmentReferences.released(["voice-audio", "gone"], keptBy: [synced], rendered: [ChatMessage]()),
            ["gone"]
        )

        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let model = try String(contentsOf: root.appendingPathComponent("Kordi/App/AppModel.swift"), encoding: .utf8)
        let start = try XCTUnwrap(model.range(of: "private func removeCloudMessages("))
        let body = model[start.lowerBound...].prefix(2_400)
        XCTAssertTrue(body.contains("removedAttachmentIDs.formUnion(MessageAttachmentReferences.ids(in: $0))"))
        XCTAssertTrue(body.contains("defer { evictReleasedAttachmentFiles(removedAttachmentIDs) }"))
        XCTAssertTrue(body.contains("MessageAttachmentReferences.released(candidates,"))
        XCTAssertTrue(body.contains("Task { await store.evict(attachmentIds: released, accountId: accountId) }"))
    }

    func testEvictRemovesBothVariantsOfOneAttachmentOnly() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("content-removal-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AttachmentFileStore(directory: directory)
        let removed = ContentRemovalFixtures.attachment("att_1")
        let similar = ContentRemovalFixtures.attachment("att_10")
        let other = ContentRemovalFixtures.attachment("att_2")
        let removedPreview = try await store.store(Data("p".utf8), attachment: removed, accountId: "acct", variant: .preview)
        let removedOriginal = try await store.store(Data("o".utf8), attachment: removed, accountId: "acct", variant: .original)
        let similarOriginal = try await store.store(Data("s".utf8), attachment: similar, accountId: "acct")
        let otherOriginal = try await store.store(Data("x".utf8), attachment: other, accountId: "acct")
        let otherAccount = try await store.store(Data("a".utf8), attachment: removed, accountId: "acct_other")

        let count = await store.evict(attachmentIds: ["att_1"], accountId: "acct")

        XCTAssertEqual(count, 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: removedPreview.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: removedOriginal.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: similarOriginal.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: otherOriginal.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: otherAccount.path))
        let evictedLookup = await store.cachedURL(for: removed, accountId: "acct", variant: .preview)
        let keptLookup = await store.cachedURL(for: other, accountId: "acct")
        XCTAssertNil(evictedLookup)
        XCTAssertEqual(keptLookup, otherOriginal)
        let emptyCount = await store.evict(attachmentIds: [""], accountId: "acct")
        XCTAssertEqual(emptyCount, 0)
    }
}

private enum ContentRemovalFixtures {
    static let conversation = #"{"id":"conversation-removal","kind":"group","shared_title":"Removal","version":1,"created_by_account_id":"acct_me","legacy_session_id":"session:group:removal","forked_from_session_id":null,"forked_from_message_id":null,"latest_message_sequence":3,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","members":[{"account_id":"acct_me","display_name":"Me","avatar_url":null,"role":"owner","membership_state":"active","version":1,"last_delivered_sequence":3,"last_read_sequence":3,"joined_at":"2026-10-01T00:00:00Z","left_at":null}],"preferences":{"conversation_id":"conversation-removal","account_id":"acct_me","personal_title":null,"version":1}}"#

    static func syncBody(events: String, version: Int?, cursor: Int = 5) -> String {
        let field = version.map { #","content_removal_version":\#($0)"# } ?? ""
        return #"{"protocol_version":2,"events":[\#(events)],"next_cursor":"\#(cursor)","last_stream_seq":\#(cursor),"has_more":false,"server_time":"2026-10-01T00:00:00Z"\#(field)}"#
    }

    static func bootstrapBody(version: Int?) -> String {
        let field = version.map { #","content_removal_version":\#($0)"# } ?? ""
        return #"{"protocol_version":2,"session_visibility":{"hiddenSessionIds":[],"deletedSessionIds":[],"pinnedSessionIds":[],"mutedSessionIds":[],"unreadSessionIds":[],"pinnedGroupSpaceIds":[]},"conversations":[],"latest_messages":[],"next_cursor":"4","last_stream_seq":4,"server_time":"2026-10-01T00:00:00Z"\#(field)}"#
    }

    static func event(seq: Int, type: String, critical: Bool, entity: String, payload: String) -> String {
        #"{"stream_seq":\#(seq),"event_id":"event-\#(seq)","protocol_version":2,"type":"\#(type)","critical":\#(critical),"conversation_id":"conversation-removal","entity_id":"\#(entity)","entity_version":2,"occurred_at":"2026-10-01T00:00:0\#(seq % 10)Z","payload":\#(payload)}"#
    }

    static func client(_ protocolClass: URLProtocol.Type) -> CloudAPIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [protocolClass]
        return CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )
    }

    static func base64URL(_ json: String) -> String {
        Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func attachment(_ id: String, livePhoto: LivePhotoAttachment? = nil) -> ChatAttachment {
        ChatAttachment(attachmentId: id, livePhoto: livePhoto, name: "photo.png", kind: .image,
                       mimeType: "image/png", sizeBytes: 1, previewURL: nil)
    }

    static func message(_ id: String, attachments: [ChatAttachment]) -> ChatMessage {
        ChatMessage(id: id, conversationId: "conversation", author: .me, authorName: "Me", text: "",
                    createdAt: Date(), deliveryState: .sent, errorMessage: nil, requestMessageId: nil,
                    attachments: attachments)
    }
}

private class ContentRemovalURLProtocol: URLProtocol {
    class var body: String { "" }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let isBootstrap = request.url?.path.hasSuffix("/bootstrap") == true
        let payload = Data((isBootstrap ? ContentRemovalFixtures.bootstrapBody(version: 1) : Self.body).utf8)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class VersionReportingURLProtocol: ContentRemovalURLProtocol {
    override class var body: String { ContentRemovalFixtures.syncBody(events: "", version: 1) }
}

private final class RemovalEventsURLProtocol: ContentRemovalURLProtocol {
    override class var body: String {
        ContentRemovalFixtures.syncBody(events: [
            ContentRemovalFixtures.event(seq: 1, type: "message.deleted", critical: true, entity: "message-deleted",
                                         payload: #"{"message_id":"message-deleted"}"#),
            ContentRemovalFixtures.event(seq: 2, type: "message.hidden", critical: true, entity: "message-hidden",
                                         payload: #"{"message_id":"message-hidden","conversation":\#(ContentRemovalFixtures.conversation)}"#),
        ].joined(separator: ","), version: 1, cursor: 11)
    }
}

private final class SupersededEventURLProtocol: ContentRemovalURLProtocol {
    override class var body: String {
        ContentRemovalFixtures.syncBody(events: ContentRemovalFixtures.event(
            seq: 3, type: "message.superseded", critical: false, entity: "message-edited",
            payload: #"{"message_id":"message-edited","conversation":\#(ContentRemovalFixtures.conversation)}"#
        ), version: 1, cursor: 21)
    }
}

private final class UnknownCriticalEventURLProtocol: ContentRemovalURLProtocol {
    override class var body: String {
        ContentRemovalFixtures.syncBody(events: ContentRemovalFixtures.event(
            seq: 4, type: "message.reshaped", critical: true, entity: "message-edited",
            payload: #"{"message_id":"message-edited"}"#
        ), version: 1, cursor: 31)
    }
}
