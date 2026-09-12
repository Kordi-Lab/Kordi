import Foundation
import XCTest
@testable import Kordi

final class MessageDeletionRecoveryTests: XCTestCase {
    func testCanonicalMessageDeletesWithoutRecovery() async throws {
        let (api, session) = await client()
        defer { session.invalidateAndCancel() }
        let deletedID = try await api.deleteMessage(token: "normal", sessionId: "photo-session",
            messageId: PhotoDeletionProtocol.canonicalID, forEveryone: true)
        XCTAssertEqual(deletedID, PhotoDeletionProtocol.canonicalID)
    }

    func testOwnPhotoRecoversCanonicalIdentityForBothDeletionScopes() async throws {
        for everyone in [false, true] {
            let (api, session) = await client()
            defer { session.invalidateAndCancel() }
            let deletedID = try await api.deleteMessage(token: everyone ? "recover-everyone" : "recover-me", sessionId: "photo-session",
                messageId: PhotoDeletionProtocol.staleID, forEveryone: everyone,
                clientMessageId: PhotoDeletionProtocol.clientID)
            XCTAssertEqual(deletedID, PhotoDeletionProtocol.canonicalID)
        }
    }

    func testRecoveryDoesNotDeleteTheParentOfAReply() async throws {
        let (api, session) = await client()
        defer { session.invalidateAndCancel() }
        try await api.deleteMessage(token: "reply", sessionId: "photo-session",
            messageId: PhotoDeletionProtocol.staleID, forEveryone: true,
            clientMessageId: PhotoDeletionProtocol.clientID)
    }

    func testMissingOrUnrelatedMessagesAndDeniedRequestsRemainFailures() async {
        for scenario in ["missing", "unrelated", "wrong-sender", "wrong-conversation", "forbidden", "retry-fails", "no-client"] {
            let (api, session) = await client()
            defer { session.invalidateAndCancel() }
            do {
                try await api.deleteMessage(token: scenario, sessionId: "photo-session",
                    messageId: PhotoDeletionProtocol.staleID, forEveryone: true,
                    clientMessageId: scenario == "no-client" ? nil : PhotoDeletionProtocol.clientID)
                XCTFail("Deletion must not report success for \(scenario)")
            } catch let error as CloudAPIError {
                XCTAssertEqual(error.statusCode, scenario == "forbidden" ? 403 : 404)
            } catch { XCTFail("Unexpected failure type: \(type(of: error))") }
        }
    }

    private func client() async -> (CloudAPIClient, URLSession) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PhotoDeletionProtocol.self]
        let session = URLSession(configuration: config)
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17081")!, session: session)
        await api.activateAccount("fixture-owner")
        return (api, session)
    }
}

private final class PhotoDeletionProtocol: URLProtocol {
    static let staleID = "00000000-0000-4000-8000-000000000001"
    static let clientID = "00000000-0000-4000-8000-000000000002"
    static let canonicalID = "00000000-0000-4000-8000-000000000003"
    static let conversationID = "00000000-0000-4000-8000-000000000004"
    static let parentID = "00000000-0000-4000-8000-000000000005"

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let scenario = request.value(forHTTPHeaderField: "Authorization")?.replacingOccurrences(of: "Bearer ", with: "") ?? ""
        let path = request.url!.path
        var status = 200
        var payload: [String: Any] = [:]
        if path == "/v2/chat/sync/bootstrap" {
            let date = "2026-01-01T00:00:00Z"
            payload = ["protocol_version": 2, "conversations": [[
                "id": Self.conversationID, "kind": "direct", "version": 1,
                "created_by_account_id": "fixture-owner", "legacy_session_id": "photo-session",
                "latest_message_sequence": 1, "created_at": date, "updated_at": date,
                "members": [], "preferences": ["conversation_id": Self.conversationID,
                    "account_id": "fixture-owner", "version": 1]
            ]], "latest_messages": [], "next_cursor": "0", "last_stream_seq": 0,
                "server_time": date, "session_visibility": ["hiddenSessionIds": [], "deletedSessionIds": []]]
        } else if request.httpMethod == "DELETE" {
            XCTAssertEqual(path, "/v2/chat/conversations/\(Self.conversationID)/messages/\(path.hasSuffix(Self.canonicalID) ? Self.canonicalID : Self.staleID)")
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "for_everyone" }?.value, scenario == "recover-me" ? "false" : "true")
            status = scenario == "forbidden" ? 403 : path.hasSuffix(Self.canonicalID) && scenario != "retry-fails" ? 204 : 404
        } else if path.contains("/threads/") {
            XCTAssertNotEqual(scenario, "forbidden", "Permission failures must not trigger identity recovery")
            XCTAssertNotEqual(scenario, "no-client", "Recovery needs a stable client identity")
            XCTAssertEqual(path, "/v2/chat/conversations/\(Self.conversationID)/threads/\(Self.clientID)")
            if scenario == "missing" { status = 404 }
            else {
                var photo = message(id: Self.canonicalID, clientID: scenario == "unrelated" ? Self.parentID : Self.clientID)
                if scenario == "wrong-sender" { photo["sender_account_id"] = "fixture-peer" }
                if scenario == "wrong-conversation" { photo["conversation_id"] = Self.parentID }
                payload = ["root": scenario == "reply" ? message(id: Self.parentID, clientID: Self.parentID) : photo,
                    "messages": scenario == "reply" ? [photo] : [], "is_thread": scenario == "reply"]
            }
        } else { XCTFail("Unexpected request: \(request.httpMethod ?? "") \(path)"); status = 404 }
        if status >= 400 {
            payload = ["error": ["code": status == 403 ? "CHAT_FORBIDDEN" : "CHAT_ENTITY_NOT_FOUND",
                "message": "The requested conversation or message is unavailable."]]
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if status != 204 { client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: payload)) }
        client?.urlProtocolDidFinishLoading(self)
    }

    private func message(id: String, clientID: String) -> [String: Any] {
        ["id": id, "client_message_id": clientID, "conversation_id": Self.conversationID,
            "conversation_sequence": 1, "sender_account_id": "fixture-owner", "kind": "text",
            "content": ["schema": 1, "blocks": [], "legacy_attachments": []],
            "attachment_ids": ["fixture-photo"], "version": 1, "created_at": "2026-01-01T00:00:00Z"]
    }
}
