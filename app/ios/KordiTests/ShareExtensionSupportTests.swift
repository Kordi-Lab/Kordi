import XCTest
import UniformTypeIdentifiers
@testable import Kordi

final class ShareExtensionSupportTests: XCTestCase {
    func testSharePayloadPrefersOnePublicURLAndKeepsNotesSeparate() async throws {
        let textProvider = NSItemProvider(object: "fallback text" as NSString)
        let url = try XCTUnwrap(URL(string: "https://example.com/page?token=redacted"))
        let urlProvider = NSItemProvider()
        urlProvider.registerDataRepresentation(
            forTypeIdentifier: UTType.url.identifier,
            visibility: .all
        ) { completion in
            completion(url.absoluteString.data(using: .utf8), nil)
            return nil
        }

        let payload = try await SharePayloadLoader.load(from: [textProvider, urlProvider])

        XCTAssertEqual(payload, .url(url))
        XCTAssertEqual(
            payload.body(with: "Please review"),
            "Please review\n\nhttps://example.com/page?token=redacted"
        )
        XCTAssertNil(SharePayload.normalizedURL("https://user:secret@example.com/private"))
    }

    func testSharePayloadRejectsUnsupportedOrOversizedText() async {
        await XCTAssertThrowsErrorAsync(try await SharePayloadLoader.load(from: []))
        XCTAssertNil(SharePayload.normalizedText(String(repeating: "a", count: 16 * 1024 + 1)))
        XCTAssertNil(SharePayload.normalizedURL("https://example.com/" + String(repeating: "a", count: 16 * 1024)))
    }

    func testShareConfigurationValidatesBuildSettings() throws {
        let configuration = try KordiShareConfiguration.configured(infoDictionary: [
            "KordiCloudBaseURL": "https://kordi.ai",
            "KordiDistributionChannel": "production",
            "KordiShareAppGroup": "group.ai.kordi.share",
            "KordiShareCredentialService": "ai.kordi.share-session",
            "KordiHostAppURLScheme": "kordi"
        ])

        XCTAssertEqual(configuration.hostAppURL?.absoluteString, "kordi://share")
        XCTAssertThrowsError(try KordiShareConfiguration.configured(infoDictionary: [
            "KordiCloudBaseURL": "https://kordi.ai.evil.example",
            "KordiDistributionChannel": "production",
            "KordiShareAppGroup": "group.ai.kordi.share",
            "KordiShareCredentialService": "ai.kordi.share-session",
            "KordiHostAppURLScheme": "kordi"
        ]))
    }

    func testShareCredentialRoundTripsInItsOwnKeychainService() throws {
        let configuration = KordiShareConfiguration(
            baseURL: try XCTUnwrap(URL(string: "https://kordi.ai")),
            appGroupIdentifier: "group.ai.kordi.share",
            credentialService: "ai.kordi.share-tests.\(UUID().uuidString)",
            hostAppURLScheme: "kordi"
        )
        let store = ShareExtensionCredentialStore(configuration: configuration)
        defer { try? store.delete() }
        let credential = ShareExtensionCredential(
            token: "test-token",
            accountID: "acct_test",
            expiresAt: "2099-01-01T00:00:00Z"
        )

        try store.save(credential)

        XCTAssertEqual(try store.load(), credential)
        XCTAssertFalse(credential.isExpired)
        XCTAssertTrue(ShareExtensionCredential(
            token: "test-token",
            accountID: "acct_test",
            expiresAt: "2000-01-01T00:00:00.123Z"
        ).isExpired)
        XCTAssertTrue(ShareExtensionCredential(
            token: "test-token",
            accountID: "acct_test",
            expiresAt: "not-a-date"
        ).isExpired)
    }

    func testShareDestinationSearchAndSendAttemptsAreDeterministic() {
        let direct = ShareConversation(
            id: "direct",
            title: "Design team",
            subtitle: "Review the launch",
            kind: "direct",
            updatedAt: .distantFuture
        )
        let agent = ShareConversation(
            id: "agent",
            title: "My Kordi",
            subtitle: "Research assistant",
            kind: "ai",
            updatedAt: .distantPast
        )

        XCTAssertEqual(filteredShareConversations([direct, agent], query: " launch "), [direct])
        XCTAssertEqual(filteredShareConversations([direct, agent], query: "research"), [agent])

        var attempts = ShareSendAttemptIDs()
        let directID = attempts.id(for: direct.id)
        XCTAssertEqual(attempts.id(for: direct.id), directID)
        XCTAssertNotEqual(attempts.id(for: agent.id), directID)
        XCTAssertNotNil(shareExtensionDate("2026-08-29T15:06:12.345Z"))
    }
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected an error", file: file, line: line)
    } catch {
        // Expected.
    }
}
