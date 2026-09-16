import Foundation

/// An event read from the device calendar store. `event.externalUid` is the stable device identity.
struct DigestDeviceEvent: Equatable, Sendable {
    var event: DigestCalendarEvent
    var deviceId: String
    var calendarId: String
    var modifiedAt: Date?
    var externalUid: String { event.externalUid ?? "" }
}
/// What this device last settled for one device identity. It tells "changed here" from "changed there".
struct DigestSyncBaselineEntry: Codable, Equatable, Sendable {
    var serverId: String
    var fingerprint: String
    var revision: Int64
    var calendarId: String?
    /// Removed in Kordi while the device copy could not (yet) be removed. Ignored until the device copy disappears.
    var suppressed: Bool? = nil
}
typealias DigestSyncBaseline = [String: DigestSyncBaselineEntry]
struct DigestCalendarSyncPreferences: Codable, Equatable, Sendable {
    /// Device calendars the user opted out of. Everything else syncs.
    var excludedCalendarIds: [String] = []
    /// Device calendar that receives Kordi-created events. `nil` means the system default.
    var targetCalendarId: String? = nil
    /// Whether Kordi-created events are written to the device calendar.
    var outbound = true
}
/// `deviceStartAt`: where the existing device copy starts now, so one occurrence of a repeating event can be found.
struct DigestDeviceWrite: Equatable, Sendable { var event: DigestCalendarEvent; var deviceId: String?; var calendarId: String?; var deviceStartAt: String? = nil }
struct DigestDeviceDelete: Equatable, Sendable { var deviceId: String; var externalUid: String; var startAt: String }
struct DigestCalendarSyncPlan: Equatable, Sendable {
    var upserts: [DigestCalendarEvent] = []
    var deletes: [DigestCalendarEvent] = []
    var deviceWrites: [DigestDeviceWrite] = []
    var deviceDeletes: [DigestDeviceDelete] = []
    /// Kordi-created events this device should claim on the server before copying them to its calendar.
    var claims: [DigestCalendarEvent] = []
    /// Which device identity each upserted server row belongs to on this device, for the baseline.
    var deviceUidByServerId: [String: String] = [:]
    var baseline: DigestSyncBaseline = [:]
}
struct DigestCalendarSyncResult: Decodable, Equatable, Sendable {
    var saved: [DigestCalendarEvent]
    var conflicts: [String]
    var skipped: [String]
    var deleted: [String]
    var deleteConflicts: [String]
    var capacity: Int
}

/// Pure reconciliation between the device calendar store and the account's Kordi calendar.
enum DigestCalendarSync {
    static let pastDays = 30
    static let futureDays = 180
    static let devicePrefix = "device:"
    /// A device about to copy a Kordi-created event into its calendar first claims the row with `claim:<installation>`.
    static let claimPrefix = "claim:"

    /// Device notes often carry HTML from meeting invitations. Show them as readable plain text.
    static func plainNotes(_ text: String) -> String {
        guard text.range(of: #"</?[a-zA-Z][^>]*>"#, options: .regularExpression) != nil else { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        var value = text
        for (pattern, replacement) in [(#"(?i)<br\s*/?>"#, "\n"), (#"(?i)</(p|div|li|tr|h[1-6])\s*>"#, "\n"), (#"(?i)<li[^>]*>"#, "• "), (#"<[^>]+>"#, "")] {
            value = value.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        for (entity, character) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&")] {
            value = value.replacingOccurrences(of: entity, with: character)
        }
        value = value.replacingOccurrences(of: #"[ \t]+\n"#, with: "\n", options: .regularExpression)
        value = value.replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func window(now: Date = Date(), calendar: Calendar = .current) -> (from: Date, to: Date) {
        let today = calendar.startOfDay(for: now)
        let from = calendar.date(byAdding: .day, value: -pastDays, to: today) ?? today
        let to = calendar.date(byAdding: .day, value: futureDays, to: today) ?? today
        return (from, to)
    }
    private static func instant(_ value: String?, allDay: Bool) -> String {
        guard let value, !value.isEmpty else { return "" }
        if allDay { return String(value.prefix(10)) }
        guard let date = DigestDate.parse(value) else { return value }
        return ISO8601DateFormatter().string(from: date)
    }
    /// Content both stores hold. Reminders, sources and links are Kordi-only and never conflict.
    static func fingerprint(_ event: DigestCalendarEvent) -> String {
        let parts = [event.title.trimmingCharacters(in: .whitespacesAndNewlines), instant(event.startAt, allDay: event.allDay), instant(event.endAt, allDay: event.allDay), event.allDay ? "1" : "0", event.description.trimmingCharacters(in: .whitespacesAndNewlines)]
        return parts.joined(separator: "\u{1F}")
    }
    static func merged(_ base: DigestCalendarEvent, content: DigestCalendarEvent) -> DigestCalendarEvent {
        var next = base
        next.title = content.title; next.startAt = content.startAt; next.allDay = content.allDay; next.description = content.description
        next.endAt = content.endAt.flatMap { end in DigestDate.parse(end) == DigestDate.parse(content.startAt) ? nil : end }
        return next
    }
    private static func deviceIsNewer(_ device: DigestDeviceEvent, than server: DigestCalendarEvent) -> Bool {
        // Unknown timestamps favour the device: it is the store the user just touched.
        guard let deviceAt = device.modifiedAt, let serverAt = DigestDate.parse(server.updatedAt) else { return true }
        return deviceAt >= serverAt
    }
    private static func withinWindow(_ event: DigestCalendarEvent, now: Date) -> Bool {
        guard let start = DigestDate.parse(event.startAt) else { return false }
        let range = window(now: now)
        return start >= range.from && start < range.to
    }
    private static func legacyIdentity(_ uid: String, startAt: String) -> String {
        // Earlier imports keyed the identity on the start time as well and did not separate occurrences.
        var base = uid
        if let marker = base.range(of: ":occurrence:") { base = String(base[..<marker.lowerBound]) }
        return "\(base):\(startAt)"
    }

    /// The device store can hand back one identity more than once (the same invitation in two
    /// calendars, or a delegated copy). Keep one copy per identity, preferring a calendar that is
    /// still synced and then the most recently modified copy.
    static func dedupe(_ device: [DigestDeviceEvent], excludedCalendarIds: Set<String>) -> [DigestDeviceEvent] {
        var order: [String] = []
        var byUid: [String: DigestDeviceEvent] = [:]
        for item in device where !item.externalUid.isEmpty {
            guard let current = byUid[item.externalUid] else { byUid[item.externalUid] = item; order.append(item.externalUid); continue }
            let currentExcluded = excludedCalendarIds.contains(current.calendarId), itemExcluded = excludedCalendarIds.contains(item.calendarId)
            if currentExcluded != itemExcluded { if currentExcluded { byUid[item.externalUid] = item }; continue }
            if let a = item.modifiedAt, a > (current.modifiedAt ?? .distantPast) { byUid[item.externalUid] = item }
        }
        return order.compactMap { byUid[$0] }
    }

    static func plan(device rawDevice: [DigestDeviceEvent], server: [DigestCalendarEvent], baseline: DigestSyncBaseline,
                     excludedCalendarIds: Set<String> = [], readOnlyCalendarIds: Set<String> = [], outboundEnabled: Bool = true, outboundCalendarId: String? = nil,
                     installationId: String? = nil, now: Date = Date()) -> DigestCalendarSyncPlan {
        let device = dedupe(rawDevice, excludedCalendarIds: excludedCalendarIds)
        var serverByUid: [String: DigestCalendarEvent] = [:], serverById: [String: DigestCalendarEvent] = [:]
        for event in server { serverById[event.id] = event; if let uid = event.externalUid { serverByUid[uid] = event } }
        var plan = DigestCalendarSyncPlan()
        var seen = Set<String>()
        func settle(_ uid: String, _ current: DigestCalendarEvent, _ calendarId: String) {
            plan.baseline[uid] = DigestSyncBaselineEntry(serverId: current.id, fingerprint: fingerprint(current), revision: current.revision, calendarId: calendarId)
        }
        for item in device {
            let uid = item.externalUid
            guard !uid.isEmpty else { continue }
            let prior = baseline[uid]
            let legacyUid = legacyIdentity(uid, startAt: item.event.startAt)
            let current = serverByUid[uid] ?? prior.flatMap { serverById[$0.serverId] } ?? serverByUid[legacyUid]
            if excludedCalendarIds.contains(item.calendarId) {
                if let current { seen.insert(current.id); if prior != nil { plan.deletes.append(current) } }
                continue
            }
            guard let current else {
                if let prior {
                    // Removed in Kordi. Try to remove the device copy, and keep ignoring this identity while any copy
                    // remains (a read-only subscribed calendar, or the same invitation in a second calendar).
                    if prior.suppressed != true && !readOnlyCalendarIds.contains(item.calendarId) { plan.deviceDeletes.append(DigestDeviceDelete(deviceId: item.deviceId, externalUid: uid, startAt: item.event.startAt)) }
                    var kept = prior; kept.suppressed = true; plan.baseline[uid] = kept
                } else {
                    var fresh = merged(item.event, content: item.event)
                    fresh.sourceIds = []; fresh.reminderAt = nil; fresh.revision = 0; fresh.externalUid = uid; fresh.updatedAt = nil
                    plan.deviceUidByServerId[fresh.id] = uid
                    plan.upserts.append(fresh)
                }
                continue
            }
            seen.insert(current.id)
            let deviceFingerprint = fingerprint(item.event), serverFingerprint = fingerprint(current)
            // A row already owned by another device's copy keeps that identity, so two devices never trade it back and forth.
            let ownedElsewhere = current.externalUid.map { $0.hasPrefix(devicePrefix) && $0 != uid && $0 != legacyUid } ?? false
            let adopt = !ownedElsewhere && current.externalUid != uid
            func upsert(_ event: DigestCalendarEvent) { plan.deviceUidByServerId[event.id] = uid; plan.upserts.append(event) }
            func pushDevice() { var next = merged(current, content: item.event); next.externalUid = ownedElsewhere ? current.externalUid : uid; upsert(next) }
            func pushServer() {
                // Read-only calendars (birthdays, subscribed holidays) keep Kordi edits Kordi-only.
                guard !readOnlyCalendarIds.contains(item.calendarId) else { return }
                var target = current; target.externalUid = uid
                plan.deviceWrites.append(DigestDeviceWrite(event: target, deviceId: item.deviceId, calendarId: item.calendarId, deviceStartAt: item.event.startAt))
            }
            if deviceFingerprint == serverFingerprint {
                if adopt { var next = current; next.externalUid = uid; upsert(next) } else { settle(uid, current, item.calendarId) }
                continue
            }
            guard let prior else { if deviceIsNewer(item, than: current) { pushDevice() } else { pushServer() }; continue }
            let deviceChanged = deviceFingerprint != prior.fingerprint, serverChanged = serverFingerprint != prior.fingerprint
            if deviceChanged && !serverChanged { pushDevice() }
            else if serverChanged && !deviceChanged { pushServer() }
            else if deviceIsNewer(item, than: current) { pushDevice() }
            else { pushServer() }
        }
        let priorServerIds = Set(baseline.values.map(\.serverId))
        for event in server where !seen.contains(event.id) {
            if let uid = event.externalUid, uid.hasPrefix(claimPrefix) {
                // Claimed by this installation in an earlier pass that did not finish: finish the copy. Other claims belong to other devices.
                if let installationId, uid == claimPrefix + installationId, outboundEnabled, withinWindow(event, now: now) {
                    plan.deviceWrites.append(DigestDeviceWrite(event: event, deviceId: nil, calendarId: outboundCalendarId))
                }
                continue
            }
            if let uid = event.externalUid, uid.hasPrefix(devicePrefix) {
                // Missing here but settled before: removed from the device calendar.
                // Never settled here: another device's calendar. Leave it alone.
                if baseline[uid] != nil { plan.deletes.append(event) }
                continue
            }
            if event.externalUid != nil || event.revision == 0 { continue }
            if priorServerIds.contains(event.id) { plan.deletes.append(event); continue }
            if installationId != nil && outboundEnabled && withinWindow(event, now: now) { plan.claims.append(event) }
        }
        return plan
    }
}

/// Per-account preferences and baseline, kept on this device only.
enum DigestCalendarSyncStorage {
    static func preferencesKey(_ accountId: String) -> String { "kordi.digest.calendarSync.preferences:\(accountId)" }
    static func baselineKey(_ accountId: String) -> String { "kordi.digest.calendarSync.baseline:\(accountId)" }
    static func preferences(accountId: String, defaults: UserDefaults = .standard) -> DigestCalendarSyncPreferences {
        guard let data = defaults.data(forKey: preferencesKey(accountId)), let stored = try? JSONDecoder().decode(DigestCalendarSyncPreferences.self, from: data) else { return DigestCalendarSyncPreferences() }
        return stored
    }
    static func save(_ preferences: DigestCalendarSyncPreferences, accountId: String, defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(preferences) { defaults.set(data, forKey: preferencesKey(accountId)) }
    }
    static func baseline(accountId: String, defaults: UserDefaults = .standard) -> DigestSyncBaseline {
        guard let data = defaults.data(forKey: baselineKey(accountId)), let stored = try? JSONDecoder().decode(DigestSyncBaseline.self, from: data) else { return [:] }
        return stored
    }
    /// Stable id for this app installation, used to claim Kordi-created events before copying them to the device.
    static func installationId(accountId: String, defaults: UserDefaults = .standard) -> String {
        let key = "kordi.digest.calendarSync.installation:\(accountId)"
        if let stored = defaults.string(forKey: key), !stored.isEmpty { return stored }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: key)
        return id
    }
    static func save(baseline: DigestSyncBaseline, accountId: String, defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(baseline) { defaults.set(data, forKey: baselineKey(accountId)) }
    }
}
