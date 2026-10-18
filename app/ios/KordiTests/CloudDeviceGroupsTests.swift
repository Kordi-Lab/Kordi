import XCTest
@testable import Kordi

final class CloudDeviceGroupsTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z")!

    private func iso(_ secondsAgo: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-secondsAgo))
    }

    private func device(
        _ id: String,
        name: String? = "MacBook Pro",
        platform: String? = "macos",
        osVersion: String? = "macOS 26.0",
        secondsAgo: TimeInterval = 60,
        state: String = "authorized",
        current: Bool = false,
        online: Bool = false,
        sessionCount: Int = 1,
        legacy: Bool = false,
        signInMethod: String? = nil,
        sameMachine: Bool = false
    ) -> CloudDeviceAuthorization {
        CloudDeviceAuthorization(
            deviceId: id,
            displayName: name,
            platform: platform,
            osVersion: osVersion,
            appVersion: "0.0.2",
            createdAt: iso(100_000),
            lastActiveAt: iso(secondsAgo),
            authorizationState: state,
            currentDevice: current,
            sessionExpiresAt: nil,
            approximateLocation: "Riyadh, Saudi Arabia",
            syncStatus: CloudDeviceSyncStatus(protocolVersion: 2, lastAppliedSequence: 1, lastSuccessfulCatchUpAt: nil),
            online: online,
            sessionCount: sessionCount,
            legacy: legacy,
            signInMethod: signInMethod,
            sameMachine: sameMachine
        )
    }

    func testRowsWithTheSameNameStaySeparate() {
        let list = CloudDeviceList.make(from: [
            device("a", secondsAgo: 600),
            device("b", secondsAgo: 30, online: true),
        ])
        XCTAssertNil(list.current)
        XCTAssertEqual(list.others.map(\.deviceId), ["b", "a"])
        XCTAssertTrue(list.sameMachine.isEmpty)
    }

    func testSplitsCurrentSameMachineAndOthers() {
        let list = CloudDeviceList.make(from: [
            device("mac"),
            device("phone", name: "iPhone 17e", platform: "ios", current: true, online: true),
            device("phone-old", name: "iPhone 17e", platform: "ios", secondsAgo: 9_000, sameMachine: true),
        ])
        XCTAssertEqual(list.current?.deviceId, "phone")
        XCTAssertEqual(list.sameMachine.map(\.deviceId), ["phone-old"])
        XCTAssertEqual(list.others.map(\.deviceId), ["mac"])
        XCTAssertEqual(list.otherDevices.map(\.deviceId), ["phone-old", "mac"])
        XCTAssertFalse(list.actionsLocked)
    }

    func testPendingRowsSortFirstThenByRecency() {
        let list = CloudDeviceList.make(from: [
            device("recent", name: "Mac Studio", secondsAgo: 10),
            device("older", name: "Mac mini", secondsAgo: 5_000),
            device("pending", name: "MacBook Air", secondsAgo: 9_000, state: "pending_review"),
        ])
        XCTAssertEqual(list.others.map(\.deviceId), ["pending", "recent", "older"])
    }

    func testPendingCurrentDeviceLocksActions() {
        let list = CloudDeviceList.make(from: [
            device("phone", platform: "ios", state: "pending_review", current: true),
            device("mac"),
        ])
        XCTAssertTrue(list.actionsLocked)
        XCTAssertEqual(list.others.map(\.deviceId), ["mac"])
    }

    func testLegacyRowsStayInTheFlatList() {
        let list = CloudDeviceList.make(from: [
            device("old", name: nil, platform: nil, secondsAgo: 900, legacy: true, signInMethod: "google"),
            device("oauth", name: "oauth-github-device", platform: nil, secondsAgo: 100),
            device("mac"),
        ])
        XCTAssertEqual(list.others.map(\.deviceId), ["mac", "oauth", "old"])
        XCTAssertTrue(list.others[1].isLegacySignIn)
        XCTAssertEqual(list.others[1].title, "Kordi device")
    }

    func testPendingApprovalHint() {
        XCTAssertEqual(pendingApprovalHint(reviewEndsAt: nil), "Approve from another device.")
        XCTAssertEqual(pendingApprovalHint(reviewEndsAt: "not a date"), "Approve from another device.")
        let hint = pendingApprovalHint(reviewEndsAt: "2026-10-08T12:00:00Z")
        XCTAssertTrue(hint.hasPrefix("Approve from another device, or wait until "), hint)
        XCTAssertTrue(hint.hasSuffix("."), hint)
    }

    func testLastActiveDescriptionBoundaries() {
        XCTAssertNil(lastActiveDescription(nil, now: now))
        XCTAssertNil(lastActiveDescription("not a date", now: now))
        XCTAssertEqual(lastActiveDescription(iso(59), now: now), "Active just now")
        XCTAssertEqual(lastActiveDescription(iso(-30), now: now), "Active just now")
        XCTAssertEqual(lastActiveDescription(iso(60), now: now), "Active 1 min ago")
        XCTAssertEqual(lastActiveDescription(iso(5 * 60 + 20), now: now), "Active 5 min ago")
        XCTAssertEqual(lastActiveDescription(iso(3_599), now: now), "Active 59 min ago")
        XCTAssertEqual(lastActiveDescription(iso(3_600), now: now), "Active 1 hr ago")
        XCTAssertEqual(lastActiveDescription(iso(3 * 3_600), now: now), "Active 3 hr ago")
        XCTAssertEqual(lastActiveDescription("2026-10-07T11:55:00.123Z", now: now), "Active 4 min ago")
        let older = lastActiveDescription(iso(86_400), now: now)
        XCTAssertTrue(older?.hasPrefix("Last active ") == true, older ?? "nil")
    }

    func testPlatformVersionLabelDoesNotDuplicatePlatform() {
        XCTAssertEqual(device("a", osVersion: "macOS 26.0").platformVersionLabel, "macOS 26.0")
        XCTAssertEqual(device("b", osVersion: "26.0").platformVersionLabel, "macOS 26.0")
        XCTAssertEqual(device("c", osVersion: nil).platformVersionLabel, "macOS")
        XCTAssertEqual(device("d", platform: "ios", osVersion: "iOS 27.0").platformVersionLabel, "iOS 27.0")
        XCTAssertNil(device("e", platform: nil, osVersion: nil).platformVersionLabel)
        XCTAssertEqual(device("f", name: nil, platform: "windows").title, "Windows PC")
    }

    func testSignInMethodLabel() {
        XCTAssertEqual(device("a", signInMethod: "google").signInMethodLabel, "Google")
        XCTAssertEqual(device("b", signInMethod: "github").signInMethodLabel, "GitHub")
        XCTAssertEqual(device("c", signInMethod: "password").signInMethodLabel, "Email and password")
        XCTAssertEqual(device("d", signInMethod: "microsoft").signInMethodLabel, "Microsoft")
        XCTAssertNil(device("e").signInMethodLabel)
    }

    func testDecodeWithoutNewFieldsUsesDefaults() throws {
        let json = #"""
        {"deviceId":"d1","displayName":"MacBook Pro","platform":"macos","osVersion":"macOS 26.0",
         "appVersion":"0.0.2","createdAt":"2026-10-01T00:00:00Z","lastActiveAt":"2026-10-07T00:00:00Z",
         "authorizationState":"authorized","currentDevice":false,"sessionExpiresAt":null,
         "approximateLocation":null,
         "syncStatus":{"protocolVersion":2,"lastAppliedSequence":5,"lastSuccessfulCatchUpAt":null}}
        """#
        let decoded = try JSONDecoder().decode(CloudDeviceAuthorization.self, from: Data(json.utf8))
        XCTAssertFalse(decoded.online)
        XCTAssertEqual(decoded.sessionCount, 1)
        XCTAssertFalse(decoded.legacy)
        XCTAssertNil(decoded.signInMethod)
        XCTAssertFalse(decoded.sameMachine)
        XCTAssertNil(decoded.reviewEndsAt)
        XCTAssertEqual(decoded.title, "MacBook Pro")
    }

    func testDecodeWithNewFields() throws {
        let json = #"""
        {"devices":[{"deviceId":"d2","displayName":null,"platform":null,"osVersion":null,"appVersion":null,
         "createdAt":"2026-10-01T00:00:00Z","lastActiveAt":"2026-10-07T00:00:00.250Z",
         "authorizationState":"pending_review","currentDevice":false,"sessionExpiresAt":null,
         "approximateLocation":"Jeddah, Saudi Arabia",
         "syncStatus":{"protocolVersion":2,"lastAppliedSequence":5,"lastSuccessfulCatchUpAt":null},
         "online":true,"sessionCount":3,"legacy":true,"signInMethod":"github",
         "sameMachine":true,"reviewEndsAt":"2026-10-08T00:00:00Z"}]}
        """#
        let decoded = try JSONDecoder().decode(CloudDeviceListResponse.self, from: Data(json.utf8)).devices[0]
        XCTAssertTrue(decoded.online)
        XCTAssertEqual(decoded.sessionCount, 3)
        XCTAssertTrue(decoded.legacy)
        XCTAssertEqual(decoded.signInMethod, "github")
        XCTAssertTrue(decoded.sameMachine)
        XCTAssertEqual(decoded.reviewEndsAt, "2026-10-08T00:00:00Z")
        XCTAssertTrue(decoded.isPendingReview)
        XCTAssertTrue(decoded.isLegacySignIn)
        XCTAssertNotNil(decoded.lastActiveDate)
    }
}
