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

    func testGroupsUseFixedOrderNewestFirstAndSkipEmptyGroups() {
        let groups = MemoryPresentation.groups([
            memory("g1", .group, updatedAt: "2026-10-01T00:00:00Z"),
            memory("c-old", .conversation, updatedAt: "2026-09-01T00:00:00Z"),
            memory("c-new", .conversation, updatedAt: "2026-10-06T00:00:00.250Z"),
            memory("c-mid", .conversation, updatedAt: "2026-10-02T00:00:00Z"),
        ])
        XCTAssertEqual(groups.map(\.label), ["Conversations", "Groups"])
        XCTAssertEqual(groups[0].memories.map(\.memoryId), ["c-new", "c-mid", "c-old"])

        let all = MemoryPresentation.groups([
            memory("g", .group, updatedAt: "2026-10-01T00:00:00Z"),
            memory("p", .project, updatedAt: "2026-10-01T00:00:00Z"),
            memory("c", .conversation, updatedAt: "2026-10-01T00:00:00Z"),
        ])
        XCTAssertEqual(all.map(\.label), ["Conversations", "Projects", "Groups"])
        XCTAssertTrue(MemoryPresentation.groups([]).isEmpty)
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
        XCTAssertEqual(MemoryPresentation.detail(today, now: now, calendar: calendar), "From a correction · Launch copy with Priya · Today")
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
        XCTAssertEqual(MemoryPresentation.replayRunsLabel(0), "Nothing stored")
        XCTAssertEqual(MemoryPresentation.replayRunsLabel(1), "1 run")
        XCTAssertEqual(MemoryPresentation.replayRunsLabel(6), "6 runs")
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
            {"memoryId":"m2","scope":"workspace","scopeId":"w1","scopeLabel":null,"source":"imported","text":"Future value.","createdAt":"2026-10-05T10:00:00.123Z","updatedAt":"2026-10-05T10:00:00.123Z"}
          ],
          "settings": {"memoryEnabled": false, "excludeSensitive": true}
        }
        """#
        let response = try JSONDecoder().decode(CloudMemoryListResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.memories.count, 2)
        XCTAssertEqual(response.memories[0].scope, .conversation)
        XCTAssertEqual(response.memories[0].source, .userCorrection)
        XCTAssertEqual(response.memories[1].scope, .other("workspace"))
        XCTAssertEqual(response.memories[1].source, .other("imported"))
        XCTAssertNil(response.memories[1].scopeLabel)
        XCTAssertEqual(response.settings, CloudMemorySettings(memoryEnabled: false, excludeSensitive: true))
        XCTAssertEqual(MemoryPresentation.groups(response.memories).map(\.label), ["Conversations", "Other"])
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
        XCTAssertEqual(model.memories.count, 7)
        XCTAssertEqual(model.groups.map(\.label), ["Conversations", "Projects", "Groups"])
        XCTAssertEqual(model.replayRunCount, 6)
        let rejected = await model.save(memoryId: "lesson-1", draft: String(repeating: "a", count: 501))
        XCTAssertEqual(rejected, "Memories are 500 characters or fewer.")
        let saved = await model.save(memoryId: "lesson-1", draft: " Short  headlines. ")
        XCTAssertNil(saved)
        XCTAssertEqual(model.memories.first { $0.memoryId == "lesson-1" }?.text, "Short headlines.")
        await model.forgetAll()
        XCTAssertTrue(model.memories.isEmpty)
        await model.clearReplayState()
        XCTAssertEqual(model.replayRunCount, 0)
    }
}

extension MemoryPresentationTests {
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
