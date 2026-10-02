import SwiftData
import XCTest
@testable import Kordi

/// Fails `copyItem` for one source file name to simulate an interrupted copy.
private final class FailingCopyFileManager: FileManager {
    private let failingSourceName: String

    init(failingSourceName: String) {
        self.failingSourceName = failingSourceName
        super.init()
    }

    override func copyItem(at srcURL: URL, to dstURL: URL) throws {
        if srcURL.lastPathComponent == failingSourceName {
            throw CocoaError(.fileWriteOutOfSpace)
        }
        try super.copyItem(at: srcURL, to: dstURL)
    }
}

@MainActor
final class LocalMessageStoreRelocationTests: XCTestCase {
    private let accountId = "acct_relocation"
    private var applicationSupport: URL!
    private var legacy: URL { applicationSupport.appendingPathComponent("default.store") }
    private var storeDirectory: URL { applicationSupport.appendingPathComponent("Kordi/MessageStore", isDirectory: true) }
    private var relocated: URL { storeDirectory.appendingPathComponent("messages.store") }
    private var partial: URL { storeDirectory.appendingPathComponent("messages.store.partial") }

    override func setUpWithError() throws {
        applicationSupport = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-store-relocation-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: applicationSupport, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: applicationSupport)
    }

    func testLegacyStoreMovesToTheProtectedDirectory() throws {
        try seed(legacy, conversationId: "person:legacy")
        let recorder = RecordingLocalDataProtection()

        let store = try LocalMessageStore(applicationSupportDirectory: applicationSupport, protection: recorder)

        XCTAssertEqual(store.loadConversations(accountId: accountId).map(\.id), ["person:legacy"])
        XCTAssertTrue(exists(relocated))
        XCTAssertFalse(exists(partial))
        for file in MessageStoreLocation.storeFiles(legacy) {
            XCTAssertFalse(exists(file), "\(file.lastPathComponent) must be removed after the new store opens")
        }
        XCTAssertTrue(try isExcludedFromBackup(storeDirectory))
        XCTAssertTrue(recorder.calls.contains(.prepare(
            path: storeDirectory.path,
            protection: .completeUntilFirstUserAuthentication,
            excludeFromBackup: true
        )))
        XCTAssertEqual(recorder.appliedProtection(to: relocated), [.completeUntilFirstUserAuthentication])
    }

    func testRelocationKeepsRecordsThatOnlyExistInTheWriteAheadLog() throws {
        // Simulate a process that ended before SQLite checkpointed its log:
        // copy the files while the seeding container is still open.
        let seedDirectory = applicationSupport.appendingPathComponent("seed", isDirectory: true)
        try FileManager.default.createDirectory(at: seedDirectory, withIntermediateDirectories: true)
        let seedStore = seedDirectory.appendingPathComponent("default.store")
        try withExtendedLifetime(try seedContainer(seedStore, conversationId: "person:wal")) {
            for (source, target) in zip(MessageStoreLocation.storeFiles(seedStore), MessageStoreLocation.storeFiles(legacy))
                where exists(source) && !source.lastPathComponent.hasSuffix("-shm") {
                try FileManager.default.copyItem(at: source, to: target)
            }
        }
        XCTAssertTrue(exists(MessageStoreLocation.storeFiles(legacy)[1]), "The fixture must include a write-ahead log")

        let store = try LocalMessageStore(applicationSupportDirectory: applicationSupport)

        XCTAssertEqual(store.loadConversations(accountId: accountId).map(\.id), ["person:wal"])
        XCTAssertFalse(exists(legacy))
    }

    func testFailedCopyFallsBackToTheIntactLegacyStore() throws {
        try seed(legacy, conversationId: "person:legacy")
        let recorder = RecordingLocalDataProtection()

        let store = try LocalMessageStore(
            applicationSupportDirectory: applicationSupport,
            fileManager: FailingCopyFileManager(failingSourceName: "default.store"),
            protection: recorder
        )

        XCTAssertEqual(store.loadConversations(accountId: accountId).map(\.id), ["person:legacy"])
        XCTAssertTrue(exists(legacy))
        XCTAssertEqual(try relocationFiles(), [], "A failed copy must leave no relocated files behind")
        XCTAssertTrue(recorder.calls.contains(.excludeFromBackup(path: legacy.path)))
    }

    func testInterruptedRelocationLeftoversAreReplaced() throws {
        try seed(legacy, conversationId: "person:legacy")
        let leftover = Data("interrupted".utf8)
        try FileManager.default.createDirectory(at: storeDirectory, withIntermediateDirectories: true)
        let relocatedWAL = MessageStoreLocation.storeFiles(relocated)[1]
        try leftover.write(to: relocatedWAL)
        try leftover.write(to: partial)

        let store = try LocalMessageStore(applicationSupportDirectory: applicationSupport)

        XCTAssertEqual(store.loadConversations(accountId: accountId).map(\.id), ["person:legacy"])
        XCTAssertFalse(exists(partial))
        XCTAssertFalse(exists(legacy), "A clean relocation removes the legacy store")
        XCTAssertNotEqual(try? Data(contentsOf: relocatedWAL), leftover)
    }

    func testRelocatedStoreWinsOverALegacyStore() throws {
        try FileManager.default.createDirectory(at: storeDirectory, withIntermediateDirectories: true)
        try seed(relocated, conversationId: "person:relocated")
        try seed(legacy, conversationId: "person:legacy")

        let store = try LocalMessageStore(applicationSupportDirectory: applicationSupport)

        XCTAssertEqual(store.loadConversations(accountId: accountId).map(\.id), ["person:relocated"])
        XCTAssertFalse(exists(legacy))
    }

    func testDirectoryPreparationFailureStillOpensTheRelocatedStoreWithoutDeleting() throws {
        try FileManager.default.createDirectory(at: storeDirectory, withIntermediateDirectories: true)
        try seed(relocated, conversationId: "person:relocated")
        try seed(legacy, conversationId: "person:legacy")

        let store = try LocalMessageStore(
            applicationSupportDirectory: applicationSupport,
            protection: RecordingLocalDataProtection(failsPrepare: true)
        )

        XCTAssertEqual(store.loadConversations(accountId: accountId).map(\.id), ["person:relocated"])
        XCTAssertTrue(exists(relocated))
        XCTAssertTrue(exists(legacy))
    }

    func testFreshInstallOpensTheProtectedLocation() throws {
        do {
            let store = try LocalMessageStore(applicationSupportDirectory: applicationSupport)
            store.saveConversations([conversation(id: "person:new")], accountId: accountId)
        }

        let reopened = try LocalMessageStore(applicationSupportDirectory: applicationSupport)

        XCTAssertEqual(reopened.loadConversations(accountId: accountId).map(\.id), ["person:new"])
        XCTAssertTrue(exists(relocated))
        XCTAssertFalse(exists(legacy))
    }

    func testUnpreparedDirectoryWithoutAStoreUsesTheLegacyLocation() throws {
        let recorder = RecordingLocalDataProtection(failsPrepare: true)

        let resolution = MessageStoreLocation.resolve(
            legacy: legacy,
            applicationSupport: applicationSupport,
            fileManager: .default,
            protection: recorder
        )

        XCTAssertEqual(resolution, .init(url: legacy, removeAfterOpen: nil, didCopy: false, isLegacyFallback: true))
    }

    func testCopiedStoreThatFailsToOpenIsDiscardedForTheLegacyStore() throws {
        let legacy = legacy
        try Data("legacy".utf8).write(to: legacy)
        let recorder = RecordingLocalDataProtection()

        let opened = try MessageStoreLocation.open(
            legacy: legacy,
            applicationSupport: applicationSupport,
            fileManager: .default,
            protection: recorder
        ) { url -> URL in
            guard url == legacy else { throw CocoaError(.fileReadCorruptFile) }
            return url
        }

        XCTAssertEqual(opened, legacy)
        XCTAssertEqual(try Data(contentsOf: legacy), Data("legacy".utf8))
        XCTAssertEqual(try relocationFiles(), [])
        XCTAssertTrue(recorder.calls.contains(.excludeFromBackup(path: legacy.path)))
    }

    // MARK: - Helpers

    private func seed(_ url: URL, conversationId: String) throws {
        // Release the container so its SQLite connection closes before the test.
        _ = try seedContainer(url, conversationId: conversationId)
    }

    private func seedContainer(_ url: URL, conversationId: String) throws -> ModelContainer {
        // Matches the default configuration earlier builds used.
        let container = try ModelContainer(
            for: CachedConversationRecord.self,
            CachedMessageRecord.self,
            CachedMessagePageRecord.self,
            configurations: ModelConfiguration(url: url)
        )
        let context = ModelContext(container)
        context.insert(CachedConversationRecord(accountId: accountId, conversation: conversation(id: conversationId)))
        try context.save()
        return container
    }

    private func relocationFiles() throws -> [String] {
        guard exists(storeDirectory) else { return [] }
        return try FileManager.default.contentsOfDirectory(atPath: storeDirectory.path)
            .filter { $0.hasPrefix("messages.store") }
            .sorted()
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    private func conversation(id: String) -> ConversationSummary {
        ConversationSummary(
            id: id,
            kind: .person,
            peerAccountId: "relocation-peer",
            agentId: nil,
            ownerDisplayName: "Relocation peer",
            displayName: "Relocation peer",
            lastMessage: "",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:relocation"
        )
    }
}
