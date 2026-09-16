import EventKit
import Foundation

struct DigestCalendarSyncDependencies {
    var accessStatus: (_ request: Bool) async -> EKAuthorizationStatus
    var readDevice: (_ from: Date, _ to: Date) throws -> (calendars: [DigestDeviceCalendar], events: [DigestDeviceEvent])
    var writeDevice: (_ write: DigestDeviceWrite) throws -> (deviceId: String, externalUid: String)
    var deleteDevice: (_ target: DigestDeviceDelete) throws -> Void
    var serverEvents: () async throws -> [DigestCalendarEvent]
    var serverSync: (_ upserts: [DigestCalendarEvent], _ deletes: [DigestCalendarEvent]) async throws -> DigestCalendarSyncResult
    var preferences: () -> DigestCalendarSyncPreferences
    var installationId: () -> String
    var readBaseline: () -> DigestSyncBaseline
    var writeBaseline: (DigestSyncBaseline) -> Void
    var afterServerChange: () async -> Void
    var now: () -> Date = Date.init
}
struct DigestCalendarSyncOutcome: Equatable {
    var permission: EKAuthorizationStatus
    var calendars: [DigestDeviceCalendar]
    var syncedCount: Int
    var changed: Bool
}
struct DigestCalendarPermissionError: LocalizedError, Equatable {
    let status: EKAuthorizationStatus
    var errorDescription: String? { "Calendar access is off." }
}

enum DigestCalendarSyncEngine {
    static let maximumCalendars = 50

    /// One full reconciliation. Device writes happen first so their identities can be recorded server-side in the same batch.
    static func syncOnce(_ deps: DigestCalendarSyncDependencies) async throws -> DigestCalendarSyncOutcome {
        var permission = await deps.accessStatus(false)
        if permission == .notDetermined { permission = await deps.accessStatus(true) }
        guard permission == .fullAccess else { throw DigestCalendarPermissionError(status: permission) }
        let preferences = deps.preferences()
        let now = deps.now()
        let range = DigestCalendarSync.window(now: now)
        let device = try deps.readDevice(range.from, range.to)
        let calendars = Array(device.calendars.prefix(maximumCalendars))
        let allowed = Set(calendars.map(\.id))
        let events = device.events.filter { allowed.contains($0.calendarId) }
        let server = try await deps.serverEvents()
        let baseline = deps.readBaseline()
        let installationId = deps.installationId()
        let plan = DigestCalendarSync.plan(device: events, server: server, baseline: baseline, excludedCalendarIds: Set(preferences.excludedCalendarIds), readOnlyCalendarIds: Set(calendars.filter { !$0.allowsModifications }.map(\.id)), outboundEnabled: preferences.outbound, outboundCalendarId: preferences.targetCalendarId, installationId: installationId, now: now)
        let deviceByUid = Dictionary(events.map { ($0.externalUid, $0) }, uniquingKeysWith: { first, _ in first })
        var next = plan.baseline
        var deviceUidByServerId = plan.deviceUidByServerId
        func settle(_ event: DigestCalendarEvent, calendarId: String? = nil) {
            guard let uid = deviceUidByServerId[event.id] ?? event.externalUid, uid.hasPrefix(DigestCalendarSync.devicePrefix) else { return }
            next[uid] = DigestSyncBaselineEntry(serverId: event.id, fingerprint: DigestCalendarSync.fingerprint(event), revision: event.revision, calendarId: calendarId ?? deviceByUid[uid]?.calendarId ?? next[uid]?.calendarId)
        }
        var problems: [String] = []
        for removal in plan.deviceDeletes {
            do { try deps.deleteDevice(removal) } catch { problems.append(error.localizedDescription) }
        }
        var changed = false
        var writes = plan.deviceWrites
        if !plan.claims.isEmpty {
            // Only the device whose claim lands (the revision check) copies the event, so two devices never both write it.
            let claims = plan.claims.map { event -> DigestCalendarEvent in var claimed = event; claimed.externalUid = DigestCalendarSync.claimPrefix + installationId; claimed.updatedAt = nil; return claimed }
            let claimed = try await deps.serverSync(claims, [])
            writes += claimed.saved.map { DigestDeviceWrite(event: $0, deviceId: nil, calendarId: preferences.targetCalendarId) }
            changed = !claimed.saved.isEmpty
        }
        var upserts = plan.upserts
        for write in writes {
            do {
                let written = try deps.writeDevice(write)
                if write.event.externalUid == written.externalUid { settle(write.event, calendarId: write.calendarId) }
                else {
                    // Record the device identity before anything else can create a second copy.
                    next[written.externalUid] = DigestSyncBaselineEntry(serverId: write.event.id, fingerprint: DigestCalendarSync.fingerprint(write.event), revision: write.event.revision, calendarId: write.calendarId)
                    deviceUidByServerId[write.event.id] = written.externalUid
                    var adopted = write.event; adopted.externalUid = written.externalUid; adopted.updatedAt = nil
                    upserts.append(adopted)
                }
            } catch { problems.append(error.localizedDescription) }
        }
        // Persist device-side effects before the server call, so a failed request never turns a new device copy into a duplicate.
        deps.writeBaseline(next)
        // One row per id per batch: a later upsert for the same id wins, and an id being written is never also deleted.
        var seenIds = Set<String>()
        let uniqueUpserts = upserts.reversed().filter { seenIds.insert($0.id).inserted }.reversed()
        var seenDeletes = Set<String>()
        let deletes = plan.deletes.filter { !seenIds.contains($0.id) && seenDeletes.insert($0.id).inserted }
        if !uniqueUpserts.isEmpty || !deletes.isEmpty {
            let result = try await deps.serverSync(Array(uniqueUpserts), deletes)
            for saved in result.saved { settle(saved) }
            for event in deletes where result.deleted.contains(event.id) {
                if let uid = deviceUidByServerId[event.id] ?? event.externalUid { next[uid] = nil }
                else { for (uid, entry) in next where entry.serverId == event.id { next[uid] = nil } }
            }
            changed = changed || !result.saved.isEmpty || !result.deleted.isEmpty
            if !result.skipped.isEmpty { problems.append("Your Kordi calendar is full. Older events were not synced.") }
        }
        deps.writeBaseline(next)
        if changed { await deps.afterServerChange() }
        if let problem = problems.first { throw DigestCalendarError(message: problem) }
        return DigestCalendarSyncOutcome(permission: permission, calendars: calendars, syncedCount: next.count, changed: changed)
    }
}

/// Keeps the device calendar and the Kordi calendar converged for as long as the account is signed in.
@MainActor
final class DigestCalendarSyncCoordinator: ObservableObject {
    struct Status: Equatable {
        enum Phase: Equatable { case idle, syncing, synced, error, permission }
        var phase = Phase.idle
        var permission: EKAuthorizationStatus = .notDetermined
        var calendars: [DigestDeviceCalendar] = []
        var lastSyncedAt: Date?
        var error: String?
        var syncedCount = 0
    }
    static let debounce: Duration = .milliseconds(1500)
    static let interval: Duration = .seconds(15 * 60)

    @Published private(set) var status = Status()
    private(set) var scope: [String]?
    private var dependencies: DigestCalendarSyncDependencies?
    private var running = false
    private var queued = false
    private var debounceTask: Task<Void, Never>?
    private var intervalTask: Task<Void, Never>?
    private var observer: NSObjectProtocol?
    /// A live store is what makes the process receive change notifications at all.
    private var store: EKEventStore?

    func start(scope: [String], dependencies: DigestCalendarSyncDependencies, debounce: Duration = DigestCalendarSyncCoordinator.debounce) {
        if self.scope == scope { requestSync(debounce: debounce); return }
        stop()
        self.scope = scope
        self.dependencies = dependencies
        store = EKEventStore()
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.requestSync() }
        }
        intervalTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.interval)
                guard !Task.isCancelled else { return }
                self?.requestSync()
            }
        }
        requestSync(debounce: debounce)
    }
    func stop() {
        debounceTask?.cancel(); debounceTask = nil
        intervalTask?.cancel(); intervalTask = nil
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        store = nil
        scope = nil
        dependencies = nil
        queued = false
        status = Status()
    }
    func requestSync(debounce: Duration = DigestCalendarSyncCoordinator.debounce) {
        guard dependencies != nil else { return }
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            await self?.run()
        }
    }
    func run() async {
        guard let deps = dependencies, let scope else { return }
        if running { queued = true; return }
        running = true
        status.phase = .syncing; status.error = nil
        do {
            let outcome = try await DigestCalendarSyncEngine.syncOnce(deps)
            if self.scope == scope {
                status = Status(phase: .synced, permission: outcome.permission, calendars: outcome.calendars, lastSyncedAt: deps.now(), error: nil, syncedCount: outcome.syncedCount)
            }
        } catch let error as DigestCalendarPermissionError {
            if self.scope == scope { status.phase = .permission; status.permission = error.status; status.error = nil }
        } catch {
            if self.scope == scope { status.phase = .error; status.error = error.localizedDescription }
        }
        running = false
        if queued, self.scope == scope { queued = false; await run() }
    }
}

extension AppModel {
    /// Starts (or nudges) automatic device calendar sync for the signed-in account. Safe to call repeatedly.
    func startDigestCalendarSync() {
        guard phase == .signedIn, !isPreviewMode, let (api, token, accountId) = try? digestContext() else { return }
        let dependencies = DigestCalendarSyncDependencies(
            accessStatus: { request in await DigestCalendarService.accessStatus(request: request) },
            readDevice: { from, to in try DigestCalendarService.readDevice(from: from, to: to) },
            writeDevice: { write in try DigestCalendarService.write(write.event, deviceId: write.deviceId, calendarId: write.calendarId, deviceStartAt: write.deviceStartAt) },
            deleteDevice: { target in try DigestCalendarService.delete(deviceId: target.deviceId, externalUid: target.externalUid, startAt: target.startAt) },
            serverEvents: { try await api.digestCalendar(token: token).events },
            serverSync: { upserts, deletes in try await api.syncDigestCalendar(token: token, upserts: upserts, deletes: deletes) },
            preferences: { DigestCalendarSyncStorage.preferences(accountId: accountId) },
            installationId: { DigestCalendarSyncStorage.installationId(accountId: accountId) },
            readBaseline: { DigestCalendarSyncStorage.baseline(accountId: accountId) },
            writeBaseline: { DigestCalendarSyncStorage.save(baseline: $0, accountId: accountId) },
            afterServerChange: { [weak self] in
                guard let self, self.account?.accountId == accountId else { return }
                self.invalidateDigestReads(accountId: accountId)
                _ = try? await self.loadDigestCalendar()
            }
        )
        digestCalendarSync.start(scope: [accountId, token], dependencies: dependencies)
    }
    func requestDigestCalendarSync() { digestCalendarSync.requestSync() }
    func digestCalendarSyncPreferences() -> DigestCalendarSyncPreferences {
        guard let accountId = account?.accountId else { return DigestCalendarSyncPreferences() }
        return DigestCalendarSyncStorage.preferences(accountId: accountId)
    }
    func updateDigestCalendarSyncPreferences(_ preferences: DigestCalendarSyncPreferences) {
        guard let accountId = account?.accountId else { return }
        DigestCalendarSyncStorage.save(preferences, accountId: accountId)
        digestCalendarSync.requestSync()
    }
}
