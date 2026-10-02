import XCTest
@testable import Kordi

/// Client side of the server's content removal contract: the capability
/// version and content-free removal events.
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
