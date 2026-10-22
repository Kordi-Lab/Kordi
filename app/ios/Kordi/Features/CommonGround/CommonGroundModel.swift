import Foundation
import SwiftUI

/// Common ground state for the signed-in account: the owner's card, rooms,
/// results, matches and people. Screens drive polling
/// through the wait and refresh calls; every failure becomes `notice`.
@MainActor
final class CommonGroundModel: ObservableObject {
    typealias Context = @MainActor () throws -> (CloudAPIClient, String)

    nonisolated static let buildPollInterval: Duration = .seconds(3)
    nonisolated static let lobbyPollInterval: Duration = .seconds(2)
    nonisolated static let matchPollInterval: Duration = .seconds(3)
    /// Typed tags stay short enough to read at a glance.
    static let tagMax = 40

    let me: CommonGroundPerson
    private let context: Context
    /// `commonGroundVersion` 2: profiles. Off, every call acts as before.
    let profilesEnabled: Bool
    let defaults: UserDefaults

    @Published private(set) var owner: CommonGroundOwnerView?
    @Published private(set) var loaded = false
    @Published private(set) var recent: [CommonGroundRecentEntry] = []
    @Published private(set) var rooms: [String: CommonGroundRoom] = [:]
    /// Rooms to come back to; nil while unknown or when the server has no list.
    @Published private(set) var roomList: [CommonGroundRoomSummary]?
    @Published private(set) var results: [String: CommonGroundResults] = [:]
    /// Set here and in CommonGroundModel+People.swift.
    @Published var matches: [String: CommonGroundMatch] = [:]
    @Published var people: [String: CommonGroundPersonCard] = [:]
    /// Relationship updates after an action, newer than any loaded view.
    @Published var relationships: [String: CommonGroundRelationship] = [:]
    @Published var busy: String?
    /// One line shown as a toast over every screen.
    @Published var notice: String?
    /// Set in CommonGroundModel+Profiles.swift.
    @Published var profiles: [CommonGroundProfileSummary] = []
    @Published var currentProfileID: String?
    /// Each profile's shared topics for the wallet, set in CommonGroundModel+Wallet.swift.
    @Published var walletTopics: [String: [String]] = [:]
    /// Rooms looked up by code before joining.
    @Published var roomPreviews: [String: CommonGroundRoomPreview] = [:]
    /// The viewer's profile to see each person through, from Recent or a room.
    var viewerProfiles: [String: String] = [:]

    init(me: CommonGroundPerson, profilesEnabled: Bool = false, defaults: UserDefaults = .standard, context: @escaping Context) {
        self.me = me
        self.context = context
        self.profilesEnabled = profilesEnabled
        self.defaults = defaults
    }

    /// The profile card calls act on; nil before profiles.
    var activeProfileID: String? { profilesEnabled ? currentProfileID : nil }

    var card: CommonGroundOwnCard? { owner?.card }
    var hasCard: Bool { owner?.card != nil }
    var isBuilding: Bool { owner?.build.status == "building" }
    var buildFailed: Bool { owner?.build.status == "failed" }
    var sharing: Bool { owner?.sharing ?? true }

    /// The topics others see: the card minus hidden ones.
    var myTopics: [String] {
        guard let card else { return [] }
        let hidden = Set(card.hidden)
        return card.topics.all.filter { !hidden.contains($0) }
    }

    func isHidden(_ topic: String) -> Bool { card?.hidden.contains(topic) ?? false }

    // MARK: Errors

    static let messages: [String: String] = [
        "common_ground_no_sources": "Turn on a source first.",
        "common_ground_build_in_progress": "Your card is already being built.",
        "common_ground_room_not_found": "Room not found.",
        "common_ground_code_not_found": "Code not found.",
        "common_ground_sharing_off": "Turn on sharing first.",
        "common_ground_no_card": "Build your profile first.",
        "common_ground_profile_exists": "You already have this profile.",
        "common_ground_too_many_profiles": "You can have up to 5 profiles.",
        "common_ground_room_closed": "This room is closed.",
    ]

    /// One line for a failed call; nil for a cancelled one.
    static func message(for error: Error) -> String? {
        if error is CancellationError { return nil }
        guard let error = error as? CloudAPIError else { return "Something went wrong. Try again." }
        if error.statusCode == 429 || error.code == "rate_limited" {
            let seconds = Double(error.retryAfterSeconds ?? 60)
            return "Try again in \(max(1, Int((seconds / 60).rounded(.up)))) min."
        }
        return messages[error.code] ?? error.message
    }

    func report(_ error: Error) {
        if let message = Self.message(for: error) { notice = message }
    }

    func call<T>(_ work: (CloudAPIClient, String) async throws -> T) async throws -> T {
        let (api, token) = try context()
        return try await work(api, token)
    }

    /// Runs one user action: marks it busy, clears the notice, reports failures.
    func run<T>(_ key: String, _ work: (CloudAPIClient, String) async throws -> T) async -> T? {
        busy = key
        notice = nil
        defer { if busy == key { busy = nil } }
        do {
            return try await call(work)
        } catch {
            report(error)
            return nil
        }
    }

    // MARK: Home

    func loadHome() async {
        if profilesEnabled { await loadProfiles() }
        do {
            let profileId = activeProfileID
            apply(try await call { try await $0.commonGroundCard(token: $1, profileId: profileId) })
        } catch {
            loaded = true
            report(error)
            return
        }
        guard hasCard || anyProfileHasCard else { return }
        if let response = try? await call({ try await $0.commonGroundRecent(token: $1) }) {
            recent = response.people
        }
        await loadRooms()
    }

    func apply(_ view: CommonGroundOwnerView) {
        // A late answer for a profile that is no longer current is dropped.
        if let id = view.profile?.profileId, let current = activeProfileID, id != current { return }
        if profilesEnabled, currentProfileID == nil, let id = view.profile?.profileId { currentProfileID = id }
        let wasBuilding = isBuilding
        let revision = owner?.card?.revision
        owner = view
        loaded = true
        if let id = view.profile?.profileId { walletTopics[id] = Self.visibleTopics(view.card) }
        if (wasBuilding && !isBuilding) || revision != view.card?.revision {
            matches = [:]
            results = [:]
            if profilesEnabled { Task { await loadProfiles() } }
        }
    }

    /// Forgets the shown card while another profile's card loads.
    func resetOwner() {
        owner = nil
        loaded = false
    }

    /// One line for a failed build, from the last build state.
    var buildFailureMessage: String? {
        guard buildFailed else { return nil }
        return owner?.build.errorCode.flatMap { Self.messages[$0] } ?? "Could not build your card."
    }

    // MARK: Card

    func build(_ request: CommonGroundBuildRequest) async {
        var request = request
        request.profileId = activeProfileID
        if let view = await run("build", { try await $0.buildCommonGroundCard(token: $1, request: request) }) {
            apply(view)
        }
    }

    func refreshCard() async {
        do {
            let profileId = activeProfileID
            apply(try await call { try await $0.commonGroundCard(token: $1, profileId: profileId) })
        } catch {
            report(error)
        }
    }

    /// Polls `GET card` until the build ends or the caller is cancelled.
    func waitForBuild(every interval: Duration = buildPollInterval) async {
        while isBuilding, !Task.isCancelled {
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            await refreshCard()
        }
    }

    func saveTopics(_ topics: CommonGroundTopics) async {
        guard let previous = owner, var next = previous.card else { return }
        next.topics = topics
        owner?.card = next
        let profileId = activeProfileID
        if let saved = await run("topics", { try await $0.saveCommonGroundTopics(token: $1, topics: topics, profileId: profileId) }) {
            apply(saved)
        } else {
            owner = previous
        }
    }

    /// Adds a typed topic to one section; ignores blanks and duplicates.
    func addTopic(_ text: String, to key: WritableKeyPath<CommonGroundTopics, [String]>) async {
        let clean = String(text.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(Self.tagMax))
        guard !clean.isEmpty, var topics = card?.topics,
              !topics[keyPath: key].contains(where: { $0.caseInsensitiveCompare(clean) == .orderedSame }) else { return }
        topics[keyPath: key].append(clean)
        await saveTopics(topics)
    }

    func removeTopic(_ topic: String, from key: WritableKeyPath<CommonGroundTopics, [String]>) async {
        guard var topics = card?.topics else { return }
        topics[keyPath: key].removeAll { $0 == topic }
        await saveTopics(topics)
    }

    func toggleHidden(_ topic: String) async {
        guard let card else { return }
        let hidden = card.hidden.contains(topic) ? card.hidden.filter { $0 != topic } : card.hidden + [topic]
        let profileId = activeProfileID
        if let saved = await run("hidden", { try await $0.setCommonGroundHidden(token: $1, hidden: hidden, profileId: profileId) }) {
            apply(saved)
        }
    }

    func setSharing(_ sharing: Bool) async {
        let profileId = activeProfileID
        guard let saved = await run("sharing", {
            try await $0.setCommonGroundSharing(token: $1, sharing: sharing, profileId: profileId)
        }) else { return }
        apply(saved)
    }

    func deleteCard() async -> Bool {
        let profileId = activeProfileID
        guard let view = await run("delete", { try await $0.deleteCommonGroundCard(token: $1, profileId: profileId) }) else { return false }
        apply(view)
        rooms = [:]
        people = [:]
        if profilesEnabled {
            await loadProfiles()
            if let response = try? await call({ try await $0.commonGroundRecent(token: $1) }) { recent = response.people }
        } else {
            recent = []
        }
        return true
    }

    // MARK: Rooms

    /// Loads the rooms list. A 404 without a Common ground code means the
    /// server has no list yet, so the section stays hidden.
    func loadRooms() async {
        do {
            roomList = try await call { try await $0.commonGroundRooms(token: $1) }.rooms
        } catch let error as CloudAPIError where error.statusCode == 404 && !error.code.hasPrefix("common_ground") {
            roomList = nil
        } catch {}
    }

    /// Whether a room is closed, from the room or the rooms list.
    func isClosed(_ code: String) -> Bool {
        if let room = rooms[code] { return !room.open }
        return roomList?.first { $0.code == code }?.open == false
    }

    func roomTitle(_ code: String) -> String {
        rooms[code]?.title ?? roomList?.first { $0.code == code }?.title ?? roomPreviews[code]?.title ?? "Room \(code)"
    }

    func joinRoom(_ code: String, request: CommonGroundJoinRequest = .init()) async -> Bool {
        guard let room = await run("join", { try await $0.joinCommonGroundRoom(token: $1, code: code, request: request) }) else { return false }
        setRoom(room, code: code)
        Task { await loadRooms() }
        return true
    }

    /// Moves a room to the top of Rooms, after a join or a new code.
    func raiseRoom(_ code: String) {
        guard let index = roomList?.firstIndex(where: { $0.code == code }), index > 0 else { return }
        withAnimation(.snappy) {
            if let room = roomList?.remove(at: index) { roomList?.insert(room, at: 0) }
        }
    }

    /// A room as just joined or switched: its results are matched again.
    func setRoom(_ room: CommonGroundRoom, code: String) {
        rooms[code] = room
        results[code] = nil
    }

    /// Reloads a room; false when it is gone.
    @discardableResult
    func refreshRoom(_ code: String) async -> Bool {
        do {
            let room = try await call { try await $0.commonGroundRoom(token: $1, code: code) }
            if rooms[code] != room { withAnimation(.snappy) { rooms[code] = room } }
            return true
        } catch let error as CloudAPIError where error.code == "common_ground_room_not_found" {
            report(error)
            return false
        } catch {
            return true
        }
    }

    func leaveRoom(_ code: String) async {
        _ = try? await call { try await $0.leaveCommonGroundRoom(token: $1, code: code) }
        withAnimation(.snappy) { roomList?.removeAll { $0.code == code } }
        rooms[code] = nil
        results[code] = nil
    }

    @discardableResult
    func loadResults(_ code: String, quiet: Bool = false) async -> Bool {
        do {
            if !quiet { busy = "find" }
            defer { if busy == "find" { busy = nil } }
            results[code] = try await call { try await $0.commonGroundResults(token: $1, code: code) }
            return true
        } catch {
            if !quiet { report(error) }
            return false
        }
    }

    /// Polls results while the server is still matching; a closed room's
    /// results are stored, so they are never polled.
    func waitForResults(_ code: String, every interval: Duration = matchPollInterval) async {
        while results[code]?.isMatching == true, !isClosed(code), !Task.isCancelled {
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            await loadResults(code, quiet: true)
        }
    }

    func createGroup(code: String, name: String, memberIds: [String], topic: String? = nil) async -> CommonGroundCreatedGroup? {
        guard let created = await run("group", {
            try await $0.createCommonGroundGroup(token: $1, code: code, name: name, memberIds: memberIds, topic: topic)
        }) else { return nil }
        var group = created.group
        group.joined = true
        if group.topic == nil { group.topic = topic }
        results[code]?.groups.removeAll { $0.groupSpaceId == group.groupSpaceId }
        results[code]?.groups.append(group)
        return created
    }

    func joinInvitation(code: String, invitationRef: String) async -> CommonGroundJoinedGroup? {
        guard let joined = await run("invite:\(invitationRef)", {
            try await $0.joinCommonGroundInvitation(token: $1, code: code, invitationRef: invitationRef)
        }) else { return nil }
        let group = CommonGroundGroup(
            groupSpaceId: joined.groupSpaceId, conversationId: joined.conversationId,
            name: joined.name ?? "", memberCount: 0, joined: true
        )
        results[code]?.invitations.removeAll { $0.invitationRef == invitationRef }
        results[code]?.groups.removeAll { $0.groupSpaceId == group.groupSpaceId }
        results[code]?.groups.append(group)
        rooms[code]?.invitations.removeAll { $0.invitationRef == invitationRef }
        return joined
    }
}
