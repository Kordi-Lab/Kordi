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
        signInMethod: String? = nil
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
            signInMethod: signInMethod
        )
    }

    func testRowsOfTheSameMacFormOneGroup() {
        let grouping = CloudDeviceGrouping.make(from: [
            device("a", secondsAgo: 600),
            device("b", secondsAgo: 30, state: "pending_review", online: true),
        ])
        XCTAssertEqual(grouping.groups.count, 1)
        let group = grouping.groups[0]
        XCTAssertEqual(group.id, "macos::macbook pro")
        XCTAssertEqual(group.sessionCount, 2)
        XCTAssertTrue(group.online)
        XCTAssertTrue(group.pending)
        XCTAssertEqual(group.devices.map(\.deviceId), ["b", "a"])
        XCTAssertEqual(group.lastActiveAt, iso(30))
    }

    func testCurrentDeviceIsExcludedFromGroups() {
        let grouping = CloudDeviceGrouping.make(from: [
            device("phone", name: "iPhone 17e", platform: "ios", current: true, online: true),
            device("mac"),
        ])
        XCTAssertEqual(grouping.current?.deviceId, "phone")
        XCTAssertEqual(grouping.groups.flatMap(\.devices).map(\.deviceId), ["mac"])
        XCTAssertTrue(grouping.legacy.isEmpty)
    }

    func testLegacyAndPlaceholderRowsGoToLegacy() {
        let grouping = CloudDeviceGrouping.make(from: [
            device("old", name: nil, platform: nil, secondsAgo: 900, legacy: true, signInMethod: "google"),
            device("oauth", name: "oauth-github-device", platform: nil, secondsAgo: 100),
            device("password", name: "cloud-email-password-device", platform: nil, secondsAgo: 500),
            device("mac"),
        ])
        XCTAssertEqual(grouping.legacy.map(\.deviceId), ["oauth", "password", "old"])
        XCTAssertEqual(grouping.groups.map(\.id), ["macos::macbook pro"])
        XCTAssertTrue(grouping.legacy.allSatisfy(\.isLegacySignIn))
        XCTAssertEqual(grouping.legacy[0].groupKey, "legacy::oauth")
        XCTAssertEqual(grouping.legacy[0].title, "Kordi device")
    }

    func testGroupsSortOnlineFirstThenByRecency() {
        let grouping = CloudDeviceGrouping.make(from: [
            device("recent", name: "Mac Studio", secondsAgo: 10),
            device("older", name: "Mac mini", secondsAgo: 5_000),
            device("online", name: "MacBook Air", secondsAgo: 9_000, online: true),
        ])
        XCTAssertEqual(grouping.groups.map(\.title), ["MacBook Air", "Mac Studio", "Mac mini"])
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
        XCTAssertEqual(decoded.title, "MacBook Pro")
    }

    func testDecodeWithNewFields() throws {
        let json = #"""
        {"devices":[{"deviceId":"d2","displayName":null,"platform":null,"osVersion":null,"appVersion":null,
         "createdAt":"2026-10-01T00:00:00Z","lastActiveAt":"2026-10-07T00:00:00.250Z",
         "authorizationState":"pending_review","currentDevice":false,"sessionExpiresAt":null,
         "approximateLocation":"Jeddah, Saudi Arabia",
         "syncStatus":{"protocolVersion":2,"lastAppliedSequence":5,"lastSuccessfulCatchUpAt":null},
         "online":true,"sessionCount":3,"legacy":true,"signInMethod":"github"}]}
        """#
        let decoded = try JSONDecoder().decode(CloudDeviceListResponse.self, from: Data(json.utf8)).devices[0]
        XCTAssertTrue(decoded.online)
        XCTAssertEqual(decoded.sessionCount, 3)
        XCTAssertTrue(decoded.legacy)
        XCTAssertEqual(decoded.signInMethod, "github")
        XCTAssertTrue(decoded.isPendingReview)
        XCTAssertTrue(decoded.isLegacySignIn)
        XCTAssertNotNil(decoded.lastActiveDate)
    }
}
