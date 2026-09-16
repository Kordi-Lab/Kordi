import EventKit
import Foundation
import Testing
@testable import Kordi

private let now = DigestDate.parse("2026-09-16T12:00:00Z")!
private func device(_ overrides: (inout DigestDeviceEvent) -> Void = { _ in }) -> DigestDeviceEvent {
    var item = DigestDeviceEvent(
        event: DigestCalendarEvent(id: "calendar-a", title: "Standup", startAt: "2026-09-17T09:00:00Z", endAt: "2026-09-17T09:30:00Z", allDay: false, externalUid: "device:a"),
        deviceId: "ek-a", calendarId: "work", modifiedAt: DigestDate.parse("2026-09-16T11:00:00Z"))
    overrides(&item)
    return item
}
private func server(_ overrides: (inout DigestCalendarEvent) -> Void = { _ in }) -> DigestCalendarEvent {
    var event = DigestCalendarEvent(id: "calendar-a", title: "Standup", startAt: "2026-09-17T09:00:00+00:00", endAt: "2026-09-17T09:30:00+00:00", reminderAt: "2026-09-17T08:50:00+00:00", allDay: false, externalUid: "device:a", revision: 3, updatedAt: "2026-09-15T10:00:00Z")
    overrides(&event)
    return event
}
private func settled(_ event: DigestCalendarEvent, calendarId: String = "work") -> DigestSyncBaseline {
    [event.externalUid!: DigestSyncBaselineEntry(serverId: event.id, fingerprint: DigestCalendarSync.fingerprint(event), revision: event.revision, calendarId: calendarId)]
}

struct DigestCalendarSyncPlanTests {
    @Test func fingerprintsIgnoreInstantFormattingAndKordiOnlyFields() {
        #expect(DigestCalendarSync.fingerprint(device().event) == DigestCalendarSync.fingerprint(server()))
        #expect(DigestCalendarSync.fingerprint(device { $0.event.title = "Moved" }.event) != DigestCalendarSync.fingerprint(server()))
        let range = DigestCalendarSync.window(now: now)
        #expect(range.from < now && range.to > now)
    }

    @Test func newDeviceEventsArePushedOnceAndUnchangedPairsAreSettled() {
        let fresh = DigestCalendarSync.plan(device: [device()], server: [], baseline: [:], now: now)
        #expect(fresh.upserts.count == 1)
        #expect(fresh.upserts[0].revision == 0 && fresh.upserts[0].externalUid == "device:a" && fresh.upserts[0].reminderAt == nil)
        #expect(fresh.deletes.isEmpty && fresh.deviceWrites.isEmpty && fresh.deviceDeletes.isEmpty)
        let unchanged = DigestCalendarSync.plan(device: [device()], server: [server()], baseline: [:], now: now)
        #expect(unchanged.upserts.isEmpty && unchanged.deviceWrites.isEmpty)
        #expect(unchanged.baseline["device:a"]?.revision == 3)
        #expect(unchanged.baseline["device:a"]?.calendarId == "work")
    }

    @Test func editsFlowTowardTheSideThatDidNotChange() {
        let current = server()
        let renamedOnDevice = DigestCalendarSync.plan(device: [device { $0.event.title = "Standup (moved)"; $0.event.startAt = "2026-09-17T10:00:00Z"; $0.event.endAt = "2026-09-17T10:30:00Z" }], server: [current], baseline: settled(current), now: now)
        #expect(renamedOnDevice.upserts.count == 1)
        #expect(renamedOnDevice.upserts[0].title == "Standup (moved)")
        #expect(renamedOnDevice.upserts[0].revision == 3)
        #expect(renamedOnDevice.upserts[0].reminderAt == current.reminderAt)
        let renamedInKordi = server { $0.title = "Standup with design"; $0.revision = 4 }
        let toDevice = DigestCalendarSync.plan(device: [device()], server: [renamedInKordi], baseline: settled(current), now: now)
        #expect(toDevice.upserts.isEmpty)
        #expect(toDevice.deviceWrites.first?.deviceId == "ek-a")
        #expect(toDevice.deviceWrites.first?.event.title == "Standup with design")
        let reminderOnly = server { $0.revision = 4 }
        let quiet = DigestCalendarSync.plan(device: [device()], server: [reminderOnly], baseline: settled(current), now: now)
        #expect(quiet.upserts.isEmpty && quiet.deviceWrites.isEmpty)
        #expect(quiet.baseline["device:a"]?.revision == 4)
    }

    @Test func whenBothSidesChangedTheMostRecentEditWins() {
        let current = server()
        let deviceWins = DigestCalendarSync.plan(device: [device { $0.event.title = "Device title" }], server: [server { $0.title = "Kordi title"; $0.revision = 4; $0.updatedAt = "2026-09-16T10:00:00Z" }], baseline: settled(current), now: now)
        #expect(deviceWins.upserts.first?.title == "Device title")
        let serverWins = DigestCalendarSync.plan(device: [device { $0.event.title = "Device title"; $0.modifiedAt = DigestDate.parse("2026-09-16T09:00:00Z") }], server: [server { $0.title = "Kordi title"; $0.revision = 4; $0.updatedAt = "2026-09-16T10:00:00Z" }], baseline: settled(current), now: now)
        #expect(serverWins.upserts.isEmpty)
        #expect(serverWins.deviceWrites.first?.event.title == "Kordi title")
    }

    @Test func deletionsPropagateOnlyForEventsThisDeviceSettledBefore() {
        let current = server()
        let removedOnDevice = DigestCalendarSync.plan(device: [], server: [current], baseline: settled(current), now: now)
        #expect(removedOnDevice.deletes.map(\.id) == ["calendar-a"])
        let otherDevice = DigestCalendarSync.plan(device: [], server: [server { $0.id = "calendar-phone"; $0.externalUid = "device:phone-only" }], baseline: [:], now: now)
        #expect(otherDevice.deletes.isEmpty && otherDevice.deviceWrites.isEmpty)
        let removedInKordi = DigestCalendarSync.plan(device: [device()], server: [], baseline: settled(current), now: now)
        #expect(removedInKordi.deviceDeletes == [DigestDeviceDelete(deviceId: "ek-a", externalUid: "device:a", startAt: "2026-09-17T09:00:00Z")])
        #expect(removedInKordi.upserts.isEmpty)
        let ics = DigestCalendarSync.plan(device: [], server: [server { $0.id = "ics-1"; $0.externalUid = "feed-uid" }], baseline: [:], now: now)
        #expect(ics.deletes.isEmpty && ics.deviceWrites.isEmpty)
    }

    @Test func kordiCreatedEventsAreClaimedBeforeTheyAreCopiedAndFollowLaterRemovals() {
        let created = server { $0.id = "digest-1"; $0.externalUid = nil; $0.revision = 1; $0.sourceIds = ["m1"] }
        let plan = DigestCalendarSync.plan(device: [], server: [created], baseline: [:], outboundEnabled: true, outboundCalendarId: "personal", installationId: "phone-1", now: now)
        #expect(plan.claims.map(\.id) == ["digest-1"] && plan.deviceWrites.isEmpty)
        #expect(DigestCalendarSync.plan(device: [], server: [created], baseline: [:], now: now).claims.isEmpty)
        #expect(DigestCalendarSync.plan(device: [], server: [created], baseline: [:], outboundEnabled: false, installationId: "phone-1", now: now).claims.isEmpty)
        #expect(DigestCalendarSync.plan(device: [], server: [server { $0.id = "digest-2"; $0.externalUid = nil; $0.revision = 1; $0.startAt = "2028-01-01T09:00:00Z"; $0.endAt = "2028-01-01T09:30:00Z" }], baseline: [:], installationId: "phone-1", now: now).claims.isEmpty)
        #expect(DigestCalendarSync.plan(device: [], server: [server { $0.id = "digest-3"; $0.externalUid = nil; $0.revision = 0 }], baseline: [:], installationId: "phone-1", now: now).claims.isEmpty)
        var ownClaim = created; ownClaim.externalUid = "claim:phone-1"; ownClaim.revision = 2
        #expect(DigestCalendarSync.plan(device: [], server: [ownClaim], baseline: [:], outboundCalendarId: "personal", installationId: "phone-1", now: now).deviceWrites == [DigestDeviceWrite(event: ownClaim, deviceId: nil, calendarId: "personal")])
        var otherClaim = created; otherClaim.externalUid = "claim:mac-1"; otherClaim.revision = 2
        let other = DigestCalendarSync.plan(device: [], server: [otherClaim], baseline: [:], installationId: "phone-1", now: now)
        #expect(other.claims.isEmpty && other.deviceWrites.isEmpty && other.deletes.isEmpty)
        let written: DigestSyncBaseline = ["device:new": DigestSyncBaselineEntry(serverId: "digest-1", fingerprint: DigestCalendarSync.fingerprint(created), revision: 1, calendarId: "personal")]
        let gone = DigestCalendarSync.plan(device: [], server: [created], baseline: written, installationId: "phone-1", now: now)
        #expect(gone.deletes.map(\.id) == ["digest-1"] && gone.deviceWrites.isEmpty && gone.claims.isEmpty)
        let adoption = DigestCalendarSync.plan(device: [device { $0.event.id = "calendar-new"; $0.event.externalUid = "device:new"; $0.deviceId = "ek-new"; $0.calendarId = "personal"; $0.event.startAt = created.startAt; $0.event.endAt = created.endAt }], server: [created], baseline: written, now: now)
        #expect(adoption.upserts.count == 1)
        #expect(adoption.upserts.first?.id == "digest-1" && adoption.upserts.first?.externalUid == "device:new" && adoption.upserts.first?.revision == 1)
    }

    @Test func aRowOwnedByAnotherDeviceKeepsItsIdentity() {
        let owned = server { $0.id = "digest-1"; $0.externalUid = "device:mac-copy"; $0.revision = 5 }
        let mine: DigestSyncBaseline = ["device:phone-copy": DigestSyncBaselineEntry(serverId: "digest-1", fingerprint: DigestCalendarSync.fingerprint(owned), revision: 4, calendarId: "work")]
        let copy = device { $0.event.id = "calendar-phone"; $0.event.externalUid = "device:phone-copy"; $0.deviceId = "ek-phone"; $0.event.startAt = owned.startAt; $0.event.endAt = owned.endAt }
        let same = DigestCalendarSync.plan(device: [copy], server: [owned], baseline: mine, installationId: "phone-1", now: now)
        #expect(same.upserts.isEmpty && same.baseline["device:phone-copy"]?.serverId == "digest-1")
        let edited = DigestCalendarSync.plan(device: [device { $0.event.id = "calendar-phone"; $0.event.externalUid = "device:phone-copy"; $0.deviceId = "ek-phone"; $0.event.title = "Renamed on the phone"; $0.event.startAt = owned.startAt; $0.event.endAt = owned.endAt }], server: [owned], baseline: mine, installationId: "phone-1", now: now)
        #expect(edited.upserts.first?.externalUid == "device:mac-copy")
        #expect(edited.deviceUidByServerId["digest-1"] == "device:phone-copy")
    }

    @Test func legacyImportsAreAdoptedInsteadOfDuplicated() {
        let legacy = server { $0.externalUid = "device:a:2026-09-17T09:00:00Z" }
        let plan = DigestCalendarSync.plan(device: [device()], server: [legacy], baseline: [:], now: now)
        #expect(plan.upserts.count == 1 && plan.deletes.isEmpty)
        #expect(plan.upserts.first?.id == "calendar-a" && plan.upserts.first?.externalUid == "device:a" && plan.upserts.first?.revision == 3)
        let recurring = server { $0.id = "calendar-r"; $0.externalUid = "device:r:2026-09-17T09:00:00Z" }
        let occurrence = DigestCalendarSync.plan(device: [device { $0.event.id = "calendar-r-occ"; $0.event.externalUid = "device:r:occurrence:1789030800"; $0.deviceId = "ek-r" }], server: [recurring], baseline: [:], now: now)
        #expect(occurrence.upserts.first?.id == "calendar-r" && occurrence.upserts.first?.externalUid == "device:r:occurrence:1789030800")
    }

    @Test func excludingACalendarRemovesOnlyCopiesThisDeviceSynced() {
        let current = server()
        let excluded = DigestCalendarSync.plan(device: [device()], server: [current], baseline: settled(current), excludedCalendarIds: ["work"], now: now)
        #expect(excluded.deletes.map(\.id) == ["calendar-a"] && excluded.deviceDeletes.isEmpty)
        #expect(excluded.baseline["device:a"] == nil)
        let neverSynced = DigestCalendarSync.plan(device: [device()], server: [current], baseline: [:], excludedCalendarIds: ["work"], now: now)
        #expect(neverSynced.deletes.isEmpty && neverSynced.upserts.isEmpty)
        #expect(DigestCalendarSync.plan(device: [device()], server: [], baseline: [:], excludedCalendarIds: ["work"], now: now).upserts.isEmpty)
    }

    @Test func preferencesAndBaselinesArePerAccount() throws {
        let defaults = try #require(UserDefaults(suiteName: "digest-calendar-sync-tests-\(UUID().uuidString)"))
        #expect(DigestCalendarSyncStorage.preferences(accountId: "viewer", defaults: defaults) == DigestCalendarSyncPreferences())
        DigestCalendarSyncStorage.save(DigestCalendarSyncPreferences(excludedCalendarIds: ["holidays"], targetCalendarId: "work", outbound: false), accountId: "viewer", defaults: defaults)
        #expect(DigestCalendarSyncStorage.preferences(accountId: "viewer", defaults: defaults) == DigestCalendarSyncPreferences(excludedCalendarIds: ["holidays"], targetCalendarId: "work", outbound: false))
        #expect(DigestCalendarSyncStorage.preferences(accountId: "other", defaults: defaults) == DigestCalendarSyncPreferences())
        defaults.set(Data("not json".utf8), forKey: DigestCalendarSyncStorage.baselineKey("broken"))
        #expect(DigestCalendarSyncStorage.baseline(accountId: "broken", defaults: defaults).isEmpty)
        DigestCalendarSyncStorage.save(baseline: ["device:a": DigestSyncBaselineEntry(serverId: "calendar-a", fingerprint: "fp", revision: 1, calendarId: nil)], accountId: "viewer", defaults: defaults)
        #expect(DigestCalendarSyncStorage.baseline(accountId: "viewer", defaults: defaults)["device:a"]?.serverId == "calendar-a")
    }
}

@MainActor
private final class Recorder {
    var access: [Bool] = []
    var writes: [(id: String, deviceId: String?, calendarId: String?)] = []
    var deletes: [String] = []
    var syncs: [(upserts: [DigestCalendarEvent], deletes: [DigestCalendarEvent])] = []
    var refreshed = 0
    var baseline: DigestSyncBaseline = [:]
    var permissions: [EKAuthorizationStatus]
    init(permissions: [EKAuthorizationStatus] = [.fullAccess], baseline: DigestSyncBaseline = [:]) { self.permissions = permissions; self.baseline = baseline }
    func dependencies(device: [DigestDeviceEvent], server: [DigestCalendarEvent], preferences: DigestCalendarSyncPreferences = DigestCalendarSyncPreferences(targetCalendarId: "work")) -> DigestCalendarSyncDependencies {
        DigestCalendarSyncDependencies(
            accessStatus: { [self] request in self.access.append(request); return self.permissions.count > 1 ? self.permissions.removeFirst() : self.permissions[0] },
            readDevice: { _, _ in ([DigestDeviceCalendar(id: "work", title: "Work"), DigestDeviceCalendar(id: "holidays", title: "Holidays", allowsModifications: false)], device) },
            writeDevice: { [self] write in self.writes.append((write.event.id, write.deviceId, write.calendarId)); return (write.deviceId ?? "ek-\(write.event.id)", write.event.externalUid.flatMap { $0.hasPrefix("device:") ? $0 : nil } ?? "device:new-\(write.event.id)") },
            deleteDevice: { [self] in self.deletes.append($0.deviceId) },
            serverEvents: { server },
            serverSync: { [self] upserts, deletes in
                self.syncs.append((upserts, deletes))
                let saved = upserts.map { event in var next = event; next.revision += 1; next.updatedAt = "2026-09-16T12:00:00Z"; return next }
                return DigestCalendarSyncResult(saved: saved, conflicts: [], skipped: [], deleted: deletes.map(\.id), deleteConflicts: [], capacity: 900)
            },
            preferences: { preferences },
            installationId: { "phone-1" },
            readBaseline: { [self] in self.baseline },
            writeBaseline: { [self] in self.baseline = $0 },
            afterServerChange: { [self] in self.refreshed += 1 },
            now: { now }
        )
    }
}

@MainActor
struct DigestCalendarSyncEngineTests {
    @Test func onePassWritesDeviceChangesFirstAndSettlesTheBaseline() async throws {
        let kordi = server { $0.id = "digest-1"; $0.externalUid = nil; $0.revision = 2; $0.sourceIds = ["m1"] }
        let recorder = Recorder(permissions: [.notDetermined, .fullAccess])
        let outcome = try await DigestCalendarSyncEngine.syncOnce(recorder.dependencies(device: [device()], server: [kordi]))
        #expect(recorder.access == [false, true])
        #expect(recorder.writes.count == 1 && recorder.writes[0].id == "digest-1" && recorder.writes[0].calendarId == "work")
        #expect(recorder.syncs.count == 2)
        #expect(recorder.syncs[0].upserts.map(\.id) == ["digest-1"] && recorder.syncs[0].upserts[0].externalUid == "claim:phone-1")
        #expect(recorder.syncs[1].upserts.map(\.id) == ["calendar-a", "digest-1"])
        #expect(recorder.syncs[1].upserts[1].externalUid == "device:new-digest-1" && recorder.syncs[1].upserts[1].revision == 3)
        #expect(recorder.refreshed == 1)
        #expect(outcome.permission == .fullAccess && outcome.calendars.count == 2 && outcome.syncedCount == 2 && outcome.changed)
        #expect(recorder.baseline["device:a"]?.revision == 1 && recorder.baseline["device:a"]?.calendarId == "work")
        #expect(recorder.baseline["device:new-digest-1"]?.serverId == "digest-1" && recorder.baseline["device:new-digest-1"]?.revision == 4)
    }

    @Test func quietPassesDoNothingAndDeviceRemovalsClearTheBaselineAndKordiRemovalsSuppressIt() async throws {
        var synced = device().event; synced.revision = 1; synced.updatedAt = "2026-09-16T12:00:00Z"
        let baseline: DigestSyncBaseline = ["device:a": DigestSyncBaselineEntry(serverId: "calendar-a", fingerprint: DigestCalendarSync.fingerprint(synced), revision: 1, calendarId: "work")]
        let quiet = Recorder(baseline: baseline)
        let outcome = try await DigestCalendarSyncEngine.syncOnce(quiet.dependencies(device: [device()], server: [synced]))
        #expect(quiet.writes.isEmpty && quiet.deletes.isEmpty && quiet.syncs.isEmpty && quiet.refreshed == 0 && !outcome.changed)
        let removed = Recorder(baseline: baseline)
        _ = try await DigestCalendarSyncEngine.syncOnce(removed.dependencies(device: [], server: [synced]))
        #expect(removed.syncs.first?.deletes.map(\.id) == ["calendar-a"])
        #expect(removed.baseline.isEmpty)
        let removedInKordi = Recorder(baseline: baseline)
        _ = try await DigestCalendarSyncEngine.syncOnce(removedInKordi.dependencies(device: [device()], server: []))
        #expect(removedInKordi.deletes == ["ek-a"] && removedInKordi.syncs.isEmpty)
        #expect(removedInKordi.baseline["device:a"]?.serverId == "calendar-a" && removedInKordi.baseline["device:a"]?.suppressed == true)
    }

    @Test func aLostClaimNeverWritesAndAFailedServerCallCannotDuplicateANewDeviceCopy() async throws {
        let kordi = server { $0.id = "digest-1"; $0.externalUid = nil; $0.revision = 2; $0.sourceIds = ["m1"] }
        let lost = Recorder()
        var lostDeps = lost.dependencies(device: [], server: [kordi])
        lostDeps.serverSync = { upserts, _ in DigestCalendarSyncResult(saved: [], conflicts: upserts.map(\.id), skipped: [], deleted: [], deleteConflicts: [], capacity: 900) }
        _ = try await DigestCalendarSyncEngine.syncOnce(lostDeps)
        #expect(lost.writes.isEmpty)

        let failing = Recorder()
        var failingDeps = failing.dependencies(device: [], server: [kordi])
        let original = failingDeps.serverSync
        var calls = 0
        failingDeps.serverSync = { upserts, deletes in
            calls += 1
            if calls == 2 { throw DigestCalendarError(message: "Network unavailable") }
            return try await original(upserts, deletes)
        }
        await #expect(throws: DigestCalendarError.self) { try await DigestCalendarSyncEngine.syncOnce(failingDeps) }
        #expect(failing.writes.count == 1)
        #expect(failing.baseline["device:new-digest-1"]?.serverId == "digest-1")

        var claimedRow = kordi; claimedRow.externalUid = "claim:phone-1"; claimedRow.revision = 3
        let copy = device { $0.event.id = "calendar-copy"; $0.event.externalUid = "device:new-digest-1"; $0.deviceId = "ek-digest-1"; $0.event.title = kordi.title; $0.event.startAt = kordi.startAt; $0.event.endAt = kordi.endAt }
        let retry = Recorder(baseline: failing.baseline)
        _ = try await DigestCalendarSyncEngine.syncOnce(retry.dependencies(device: [copy], server: [claimedRow]))
        #expect(retry.writes.isEmpty)
        #expect(retry.syncs.map { $0.upserts.map { [$0.id, $0.externalUid ?? ""] } } == [[["digest-1", "device:new-digest-1"]]])
    }

    @Test func deniedPermissionStopsBeforeAnyRead() async {
        let recorder = Recorder(permissions: [.denied])
        await #expect(throws: DigestCalendarPermissionError(status: .denied)) {
            try await DigestCalendarSyncEngine.syncOnce(recorder.dependencies(device: [], server: []))
        }
        #expect(recorder.syncs.isEmpty)
    }

    @Test func coordinatorPublishesStatusAndSerializesRuns() async throws {
        let recorder = Recorder()
        let coordinator = DigestCalendarSyncCoordinator()
        var deps = recorder.dependencies(device: [device()], server: [])
        var reads = 0
        deps.serverEvents = { reads += 1; return [] }
        coordinator.start(scope: ["viewer", "token"], dependencies: deps, debounce: .milliseconds(1))
        try await Task.sleep(for: .milliseconds(200))
        #expect(coordinator.status.phase == .synced)
        #expect(coordinator.status.calendars.count == 2 && coordinator.status.lastSyncedAt == now)
        #expect(reads == 1)
        coordinator.start(scope: ["viewer", "token"], dependencies: deps, debounce: .milliseconds(1))
        coordinator.requestSync(debounce: .milliseconds(1))
        try await Task.sleep(for: .milliseconds(200))
        #expect(reads == 2, "repeated nudges collapse into one follow-up pass")
        coordinator.stop()
        #expect(coordinator.status == DigestCalendarSyncCoordinator.Status())
        let denied = DigestCalendarSyncCoordinator()
        denied.start(scope: ["viewer", "token"], dependencies: Recorder(permissions: [.denied]).dependencies(device: [], server: []), debounce: .milliseconds(1))
        try await Task.sleep(for: .milliseconds(200))
        #expect(denied.status.phase == .permission && denied.status.permission == .denied)
        denied.stop()
    }

    @Test func statusLineDescribesEachPhaseWithoutAskingForAction() {
        var status = DigestCalendarSyncCoordinator.Status()
        #expect(DigestCalendarSyncLine.label(for: status) == "Preparing calendar sync…")
        status.phase = .synced; status.calendars = [DigestDeviceCalendar(id: "work", title: "Work")]; status.lastSyncedAt = now
        #expect(DigestCalendarSyncLine.label(for: status, now: now.addingTimeInterval(20)) == "Synced · 1 calendar · just now")
        #expect(DigestCalendarSyncLine.label(for: status, now: now.addingTimeInterval(300)) == "Synced · 1 calendar · 5 min ago")
        status.phase = .permission
        #expect(DigestCalendarSyncLine.label(for: status) == "Calendar access is off.")
        status.phase = .error; status.error = "Network unavailable"
        #expect(DigestCalendarSyncLine.label(for: status) == "Calendar sync paused: Network unavailable")
        let source = try? String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Kordi/Features/Digest/DigestView.swift"), encoding: .utf8)
        #expect(source?.contains("Connect calendars") == false, "the manual connect flow is gone")
        #expect(source?.contains("DigestCalendarSyncLine(sync: model.digestCalendarSync)") == true)
    }
}

struct DigestCalendarSyncDedupeTests {
    @Test func oneDeviceIdentityReportedTwiceCollapsesToASingleUpsert() {
        let inWork = device { $0.deviceId = "ek-work"; $0.modifiedAt = DigestDate.parse("2026-09-16T09:00:00Z") }
        let inShared = device { $0.deviceId = "ek-shared"; $0.calendarId = "shared"; $0.event.title = "Standup (shared copy)"; $0.modifiedAt = DigestDate.parse("2026-09-16T11:00:00Z") }
        let plan = DigestCalendarSync.plan(device: [inWork, inShared], server: [], baseline: [:], now: now)
        #expect(plan.upserts.count == 1 && plan.upserts.first?.title == "Standup (shared copy)")
        let excluded = DigestCalendarSync.plan(device: [inShared, inWork], server: [], baseline: [:], excludedCalendarIds: ["shared"], now: now)
        #expect(excluded.upserts.count == 1 && excluded.upserts.first?.title == "Standup")
        #expect(Set(plan.upserts.map(\.id)).count == plan.upserts.count)
    }
}

struct DigestCalendarSyncSuppressionTests {
    @Test func removedInKordiStaysRemovedWhileTheDeviceCopyRemains() {
        let current = server()
        let first = DigestCalendarSync.plan(device: [device()], server: [], baseline: settled(current), now: now)
        #expect(first.deviceDeletes == [DigestDeviceDelete(deviceId: "ek-a", externalUid: "device:a", startAt: "2026-09-17T09:00:00Z")])
        #expect(first.upserts.isEmpty && first.baseline["device:a"]?.suppressed == true)
        let second = DigestCalendarSync.plan(device: [device { $0.deviceId = "ek-other" }], server: [], baseline: first.baseline, now: now)
        #expect(second.upserts.isEmpty && second.deviceDeletes.isEmpty && second.baseline["device:a"]?.suppressed == true)
        let third = DigestCalendarSync.plan(device: [], server: [], baseline: second.baseline, now: now)
        #expect(third.baseline["device:a"] == nil)
        let readded = DigestCalendarSync.plan(device: [device()], server: [current], baseline: second.baseline, now: now)
        #expect(readded.baseline["device:a"]?.suppressed == nil)
    }
}

struct DigestCalendarSyncOccurrenceTests {
    @Test func repeatingOccurrencesCarryTheirDeviceStartAndReadOnlyCalendarsAreNeverWritten() {
        let occurrence = device { $0.event.id = "calendar-r"; $0.event.externalUid = "device:r:occurrence:1789030800"; $0.deviceId = "ek-r"; $0.event.startAt = "2026-09-17T11:00:00Z"; $0.event.endAt = "2026-09-17T11:30:00Z" }
        var saved = occurrence.event; saved.revision = 2
        let baseline = settled(saved)
        var moved = saved; moved.startAt = "2026-09-17T12:00:00Z"; moved.endAt = "2026-09-17T12:30:00Z"
        let edit = DigestCalendarSync.plan(device: [occurrence], server: [moved], baseline: baseline, now: now)
        #expect(edit.deviceWrites.first?.deviceStartAt == "2026-09-17T11:00:00Z")
        #expect(edit.deviceWrites.first?.event.externalUid == "device:r:occurrence:1789030800")
        let removed = DigestCalendarSync.plan(device: [occurrence], server: [], baseline: baseline, now: now)
        #expect(removed.deviceDeletes == [DigestDeviceDelete(deviceId: "ek-r", externalUid: "device:r:occurrence:1789030800", startAt: "2026-09-17T11:00:00Z")])
        let birthday = device { $0.event.id = "calendar-b"; $0.event.externalUid = "device:b"; $0.deviceId = "ek-b"; $0.calendarId = "birthdays"; $0.event.title = "Birthday" }
        var birthdaySaved = birthday.event; birthdaySaved.revision = 1
        let birthdayBaseline = settled(birthdaySaved, calendarId: "birthdays")
        let readOnlyRemoval = DigestCalendarSync.plan(device: [birthday], server: [], baseline: birthdayBaseline, readOnlyCalendarIds: ["birthdays"], now: now)
        #expect(readOnlyRemoval.deviceDeletes.isEmpty && readOnlyRemoval.upserts.isEmpty && readOnlyRemoval.baseline["device:b"]?.suppressed == true)
        var renamed = birthdaySaved; renamed.title = "Birthday (renamed in Kordi)"; renamed.revision = 2
        let readOnlyEdit = DigestCalendarSync.plan(device: [birthday], server: [renamed], baseline: birthdayBaseline, readOnlyCalendarIds: ["birthdays"], now: now)
        #expect(readOnlyEdit.deviceWrites.isEmpty && readOnlyEdit.upserts.isEmpty)
        #expect(DigestCalendarService.occurrenceTimestamp("device:r:occurrence:1789030800") == 1789030800)
        #expect(DigestCalendarService.occurrenceTimestamp("device:plain") == nil)
    }

    @Test func meetingNotesWithHTMLAreShownAsPlainText() {
        #expect(DigestCalendarSync.plainNotes("Plain note\nsecond line") == "Plain note\nsecond line")
        #expect(DigestCalendarSync.plainNotes("<p>Join Zoom<br/>64.211.144.160 (Brazil)<br>Meeting ID: 929&nbsp;2747</p><br>———</p>") == "Join Zoom\n64.211.144.160 (Brazil)\nMeeting ID: 929 2747\n\n———")
    }
}
