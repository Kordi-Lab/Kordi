import XCTest
@testable import Kordi

/// Records every protection request and forwards it to the system
/// implementation, optionally failing selected steps.
final class RecordingLocalDataProtection: LocalDataProtecting, @unchecked Sendable {
    enum Call: Equatable {
        case prepare(path: String, protection: FileProtectionType, excludeFromBackup: Bool)
        case apply(path: String, protection: FileProtectionType)
        case excludeFromBackup(path: String)
    }

    private let lock = NSLock()
    private var recorded: [Call] = []
    private let system = SystemLocalDataProtection()
    private let failsPrepare: Bool
    private let failingApplyNames: Set<String>

    init(failsPrepare: Bool = false, failingApplyNames: Set<String> = []) {
        self.failsPrepare = failsPrepare
        self.failingApplyNames = failingApplyNames
    }

    var calls: [Call] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func prepareDirectory(_ url: URL, protection: FileProtectionType, excludeFromBackup: Bool) throws {
        record(.prepare(path: url.path, protection: protection, excludeFromBackup: excludeFromBackup))
        if failsPrepare { throw CocoaError(.fileWriteNoPermission) }
        try system.prepareDirectory(url, protection: protection, excludeFromBackup: excludeFromBackup)
    }

    @discardableResult
    func apply(_ protection: FileProtectionType, to url: URL) -> Bool {
        record(.apply(path: url.path, protection: protection))
        if failingApplyNames.contains(url.lastPathComponent) { return false }
        return system.apply(protection, to: url)
    }

    func excludeFromBackup(_ url: URL) {
        record(.excludeFromBackup(path: url.path))
        system.excludeFromBackup(url)
    }

    func appliedProtection(to url: URL) -> [FileProtectionType] {
        calls.compactMap { call in
            guard case let .apply(path, protection) = call, path == url.path else { return nil }
            return protection
        }
    }

    private func record(_ call: Call) {
        lock.lock()
        recorded.append(call)
        lock.unlock()
    }
}

func isExcludedFromBackup(_ url: URL) throws -> Bool {
    try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true
}

final class LocalDataProtectionTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-data-protection-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testAttachmentClassKeepsOnlyAudioReadableWhileLocked() {
        let afterFirstUnlock = FileProtectionType.completeUntilFirstUserAuthentication
        let unlessOpen = FileProtectionType.completeUnlessOpen

        XCTAssertEqual(LocalDataProtectionClass.backgroundStore, afterFirstUnlock)
        XCTAssertEqual(LocalDataProtectionClass.downloadedMedia, unlessOpen)
        XCTAssertEqual(LocalDataProtectionClass.attachment(fileName: "photo.jpg", mimeType: "image/jpeg"), unlessOpen)
        XCTAssertEqual(LocalDataProtectionClass.attachment(fileName: "report.pdf", mimeType: nil), unlessOpen)
        XCTAssertEqual(LocalDataProtectionClass.attachment(fileName: "clip.mp4", mimeType: "video/mp4"), unlessOpen)
        XCTAssertEqual(LocalDataProtectionClass.attachment(fileName: "voice.m4a", mimeType: "audio/mp4"), afterFirstUnlock)
        XCTAssertEqual(LocalDataProtectionClass.attachment(fileName: "voice", mimeType: "AUDIO/ogg"), afterFirstUnlock)
        for name in ["a.m4a", "a.aac", "a.MP3", "a.wav", "a.caf", "a.opus", "a.ogg"] {
            XCTAssertEqual(LocalDataProtectionClass.attachment(fileName: name, mimeType: nil), afterFirstUnlock, name)
        }
    }

    func testWritingOptionMatchesProtectionClass() {
        XCTAssertEqual(
            LocalDataProtectionClass.writingOption(for: .completeUnlessOpen),
            .completeFileProtectionUnlessOpen
        )
        XCTAssertEqual(
            LocalDataProtectionClass.writingOption(for: .completeUntilFirstUserAuthentication),
            .completeFileProtectionUntilFirstUserAuthentication
        )
        XCTAssertEqual(LocalDataProtectionClass.writingOption(for: .complete), .completeFileProtection)
        XCTAssertEqual(LocalDataProtectionClass.writingOption(for: FileProtectionType.none), .noFileProtection)
    }

    func testSystemProtectionCreatesDirectoryAndExcludesItFromBackup() throws {
        let nested = directory.appendingPathComponent("a/b", isDirectory: true)
        let protection = SystemLocalDataProtection()

        try protection.prepareDirectory(nested, protection: .completeUnlessOpen, excludeFromBackup: true)
        try protection.prepareDirectory(nested, protection: .completeUnlessOpen, excludeFromBackup: true)

        XCTAssertTrue(FileManager.default.fileExists(atPath: nested.path))
        XCTAssertTrue(try isExcludedFromBackup(nested))
        XCTAssertTrue(protection.apply(.completeUnlessOpen, to: nested.appendingPathComponent("missing")))
        protection.excludeFromBackup(nested.appendingPathComponent("missing"))
    }

    func testSystemProtectionOnlyThrowsWhenTheDirectoryCannotBeCreated() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("file")
        try Data([1]).write(to: file)

        XCTAssertThrowsError(try SystemLocalDataProtection().prepareDirectory(
            file.appendingPathComponent("child"),
            protection: .completeUnlessOpen,
            excludeFromBackup: false
        ))
    }

    func testAttachmentStoreRequestsCompleteUnlessOpenForImagesInBothWritePaths() async throws {
        let recorder = RecordingLocalDataProtection()
        let store = await settledStore(protection: recorder)
        let image = attachment(id: "photo", name: "photo.jpg", mimeType: "image/jpeg")
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("kordi-source-\(UUID().uuidString).jpg")
        defer { try? FileManager.default.removeItem(at: source) }
        try Data([1, 2, 3]).write(to: source)

        let written = try await store.store(Data([9]), attachment: image, accountId: "acct_a", variant: .preview)
        let moved = try await store.store(fileAt: source, attachment: image, accountId: "acct_a", variant: .original)

        XCTAssertEqual(recorder.appliedProtection(to: written), [.completeUnlessOpen])
        XCTAssertEqual(recorder.appliedProtection(to: moved), [.completeUnlessOpen])
        let accountDirectory = written.deletingLastPathComponent()
        XCTAssertTrue(recorder.calls.contains(.prepare(
            path: accountDirectory.path,
            protection: .completeUnlessOpen,
            excludeFromBackup: false
        )))
        XCTAssertEqual(try Data(contentsOf: moved), Data([1, 2, 3]))
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path), "Caching must not consume the source")
    }

    func testAttachmentStoreKeepsAudioAvailableAfterFirstUnlock() async throws {
        let recorder = RecordingLocalDataProtection()
        let store = await settledStore(protection: recorder)
        let voice = attachment(id: "voice", name: "voice.m4a", mimeType: "audio/mp4")

        let url = try await store.store(Data([4, 5]), attachment: voice, accountId: "acct_a")

        XCTAssertEqual(recorder.appliedProtection(to: url), [.completeUntilFirstUserAuthentication])
    }

    func testProtectionUpgradeWritesMarkerOnlyWhenEveryFileSucceeds() throws {
        let account = directory.appendingPathComponent("0123456789abcdef", isDirectory: true)
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        let photo = account.appendingPathComponent("att-original-photo.jpg")
        let voice = account.appendingPathComponent("att-original-voice.m4a")
        let partialDownload = account.appendingPathComponent(".pending.download")
        for file in [photo, voice, partialDownload] { try Data([1]).write(to: file) }
        let marker = directory.appendingPathComponent(AttachmentProtectionUpgrade.markerName)

        let failing = RecordingLocalDataProtection(failingApplyNames: [photo.lastPathComponent])
        XCTAssertFalse(AttachmentProtectionUpgrade.run(in: directory, protection: failing))
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
        XCTAssertEqual(failing.appliedProtection(to: voice), [.completeUntilFirstUserAuthentication],
            "One failure must not stop the remaining files from upgrading")

        let succeeding = RecordingLocalDataProtection()
        XCTAssertTrue(AttachmentProtectionUpgrade.run(in: directory, protection: succeeding))
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
        XCTAssertEqual(succeeding.appliedProtection(to: photo), [.completeUnlessOpen])
        XCTAssertEqual(succeeding.appliedProtection(to: voice), [.completeUntilFirstUserAuthentication])
        XCTAssertEqual(succeeding.appliedProtection(to: account), [.completeUnlessOpen])
        XCTAssertEqual(succeeding.appliedProtection(to: partialDownload), [], "Hidden temporary files are skipped")

        let afterMarker = RecordingLocalDataProtection()
        XCTAssertTrue(AttachmentProtectionUpgrade.run(in: directory, protection: afterMarker))
        XCTAssertEqual(afterMarker.calls, [], "The pass runs only once")
    }

    func testProtectionUpgradeSkipsAMissingCacheWithoutWritingAMarker() {
        let recorder = RecordingLocalDataProtection()

        XCTAssertTrue(AttachmentProtectionUpgrade.run(in: directory, protection: recorder))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        XCTAssertEqual(recorder.calls, [])
    }

    func testFirstCacheLookupStartsTheProtectionUpgrade() async throws {
        let account = directory.appendingPathComponent("0123456789abcdef", isDirectory: true)
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        let existing = account.appendingPathComponent("old-original-photo.jpg")
        try Data([1]).write(to: existing)
        let recorder = RecordingLocalDataProtection()
        let store = AttachmentFileStore(directory: directory, protection: recorder)

        _ = await store.cachedURL(for: attachment(id: "x", name: "x.jpg", mimeType: "image/jpeg"), accountId: "acct_a")
        let upgrade = await store.protectionUpgrade
        let succeeded = await upgrade?.value

        XCTAssertEqual(succeeded, true)
        XCTAssertEqual(recorder.appliedProtection(to: existing), [.completeUnlessOpen])
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent(AttachmentProtectionUpgrade.markerName).path
        ))
    }

    func testAPIResponsesBypassTheSharedURLCache() {
        let configuration = CloudAPIClient.reliableSession.configuration

        XCTAssertNil(configuration.urlCache)
        XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
    }

    func testLegacyResponseCachePurgeRunsOnce() throws {
        let suiteName = "kordi-response-cache-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let cache = URLCache(memoryCapacity: 1_024 * 1_024, diskCapacity: 0, directory: nil)
        let request = URLRequest(url: URL(string: "https://kordi.example.test/v1/cloud/messages")!)
        let response = try XCTUnwrap(HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        ))
        let cached = CachedURLResponse(response: response, data: Data("cached".utf8))
        cache.storeCachedResponse(cached, for: request)
        XCTAssertNotNil(cache.cachedResponse(for: request))

        CloudAPIClient.purgeLegacyResponseCacheOnce(defaults: defaults, cache: cache)

        XCTAssertNil(cache.cachedResponse(for: request))
        XCTAssertTrue(defaults.bool(forKey: CloudAPIClient.responseCachePurgeMarker))

        cache.storeCachedResponse(cached, for: request)
        CloudAPIClient.purgeLegacyResponseCacheOnce(defaults: defaults, cache: cache)
        XCTAssertNotNil(cache.cachedResponse(for: request), "The purge runs only once")
    }

    /// A store whose one-time upgrade pass already finished on the empty
    /// cache, so it cannot race the requests a test records.
    private func settledStore(protection: RecordingLocalDataProtection) async -> AttachmentFileStore {
        let store = AttachmentFileStore(directory: directory, protection: protection)
        _ = await store.cachedURL(for: attachment(id: "warm", name: "warm.jpg", mimeType: "image/jpeg"), accountId: "acct_a")
        _ = await store.protectionUpgrade?.value
        return store
    }

    private func attachment(id: String, name: String, mimeType: String) -> ChatAttachment {
        ChatAttachment(
            attachmentId: id,
            name: name,
            kind: mimeType.hasPrefix("image/") ? .image : .file,
            mimeType: mimeType,
            sizeBytes: 1,
            previewURL: nil
        )
    }
}
