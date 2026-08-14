import XCTest
@testable import Kordi

final class CloudWireCacheTests: XCTestCase {
    func testSnapshotRoundTripsCompleteHistoryAndCursor() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-wire-cache-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = CloudWireCache(directory: directory)
        let message = CloudMessageDTO(
            messageId: "message-latest",
            fromAccountId: "acct-me",
            toAccountId: "acct-peer",
            body: "Latest from the Mac",
            createdAt: "2026-08-08T17:30:00Z",
            deliveredAt: "2026-08-08T17:30:01Z",
            readAt: nil,
            direction: "outgoing",
            sessionId: "session:direct-person:acct-me:acct-peer"
        )
        let fork = CloudSessionForkSummary(
            forkSessionId: "session:fork:child",
            parentSessionId: "session:self-agent:root",
            parentMessageId: "message-latest",
            createdByAccountId: "acct-me",
            createdAt: "2026-08-08T17:31:00Z"
        )

        let saved = await cache.save(
            accountId: "acct-me",
            cursor: "842",
            lastStreamSequence: 842,
            messagesByPeer: ["acct-peer": [message]],
            sessionForksById: [fork.forkSessionId: fork]
        )
        let restored = await cache.load(accountId: "acct-me")

        XCTAssertTrue(saved)
        XCTAssertEqual(restored?.cursor, "842")
        XCTAssertEqual(restored?.lastStreamSequence, 842)
        XCTAssertEqual(restored?.messagesByPeer["acct-peer"], [message])
        XCTAssertEqual(restored?.sessionForksById?[fork.forkSessionId], fork)
        XCTAssertEqual(restored?.forkLineageVersion, CloudWireSnapshot.currentForkLineageVersion)
    }

    func testOlderSnapshotWithoutForkLineageVersionStillDecodesForUpgradeReplay() throws {
        let data = Data(#"{"accountId":"acct-me","cursor":"cursor-old","messagesByPeer":{},"sessionForksById":{},"savedAt":0}"#.utf8)

        let snapshot = try JSONDecoder().decode(CloudWireSnapshot.self, from: data)

        XCTAssertNil(snapshot.lastStreamSequence)
        XCTAssertNil(snapshot.forkLineageVersion)
        XCTAssertNotNil(snapshot.sessionForksById)
    }

    func testSnapshotSaveReportsFailureBeforeTheSyncCursorCanAdvance() async throws {
        let parent = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-wire-cache-blocked-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let blockingFile = parent.appendingPathComponent("not-a-directory")
        try Data("blocked".utf8).write(to: blockingFile)
        let cache = CloudWireCache(directory: blockingFile)

        let saved = await cache.save(
            accountId: "acct-me",
            cursor: "cursor-843",
            lastStreamSequence: 843,
            messagesByPeer: [:]
        )

        XCTAssertFalse(saved)
    }

    func testForkLineageUpgradeCannotResumeFromAnOlderCursor() {
        XCTAssertTrue(CloudSyncRecoveryPolicy.requiresBootstrap(
            hasHydratedWireSnapshot: true,
            hasHydratedForkLineage: false
        ))
        XCTAssertTrue(CloudSyncRecoveryPolicy.requiresBootstrap(
            hasHydratedWireSnapshot: false,
            hasHydratedForkLineage: true
        ))
        XCTAssertFalse(CloudSyncRecoveryPolicy.requiresBootstrap(
            hasHydratedWireSnapshot: true,
            hasHydratedForkLineage: true
        ))
    }
}
