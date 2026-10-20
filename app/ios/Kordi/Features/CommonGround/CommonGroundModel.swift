import Foundation
import SwiftUI

/// Common ground state for the signed-in account: the owner's card, the
/// pairing code, rooms, results, matches and people. Screens drive polling
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

    @Published private(set) var owner: CommonGroundOwnerView?
    @Published private(set) var loaded = false
    @Published private(set) var recent: [CommonGroundRecentEntry] = []
    @Published private(set) var pairCode: CommonGroundPairCode?
    @Published private(set) var rooms: [String: CommonGroundRoom] = [:]
    @Published private(set) var results: [String: CommonGroundResults] = [:]
    @Published private(set) var matches: [String: CommonGroundMatch] = [:]
    @Published private(set) var people: [String: CommonGroundPersonCard] = [:]
    /// Relationship updates after an action, newer than any loaded view.
    @Published private(set) var relationships: [String: CommonGroundRelationship] = [:]
    @Published private(set) var busy: String?
    /// One line shown as a toast over every screen.
    @Published var notice: String?

    init(me: CommonGroundPerson, context: @escaping Context) {
        self.me = me
        self.context = context
    }

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
        "common_ground_no_card": "Build your card first.",
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

    private func call<T>(_ work: (CloudAPIClient, String) async throws -> T) async throws -> T {
        let (api, token) = try context()
        return try await work(api, token)
    }

    /// Runs one user action: marks it busy, clears the notice, reports failures.
    private func run<T>(_ key: String, _ work: (CloudAPIClient, String) async throws -> T) async -> T? {
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
        do {
            apply(try await call { try await $0.commonGroundCard(token: $1) })
        } catch {
            loaded = true
            report(error)
            return
        }
        guard hasCard else { return }
        if let response = try? await call({ try await $0.commonGroundRecent(token: $1) }) {
            recent = response.people
        }
        if sharing, isPairCodeExpired() { await newPairCode(quiet: true) }
    }

    private func apply(_ view: CommonGroundOwnerView) {
        let wasBuilding = isBuilding
        let revision = owner?.card?.revision
        owner = view
        loaded = true
        if (wasBuilding && !isBuilding) || revision != view.card?.revision {
            matches = [:]
            results = [:]
        }
    }

    /// One line for a failed build, from the last build state.
    var buildFailureMessage: String? {
        guard buildFailed else { return nil }
        return owner?.build.errorCode.flatMap { Self.messages[$0] } ?? "Could not build your card."
    }

    // MARK: Card

    func build(_ request: CommonGroundBuildRequest) async {
        if let view = await run("build", { try await $0.buildCommonGroundCard(token: $1, request: request) }) {
            apply(view)
        }
    }

    func refreshCard() async {
        do {
            apply(try await call { try await $0.commonGroundCard(token: $1) })
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
        if !isBuilding, hasCard, sharing, isPairCodeExpired() { await newPairCode(quiet: true) }
    }

    func saveTopics(_ topics: CommonGroundTopics) async {
        guard let previous = owner, var next = previous.card else { return }
        next.topics = topics
        owner?.card = next
        if let saved = await run("topics", { try await $0.saveCommonGroundTopics(token: $1, topics: topics) }) {
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
        if let saved = await run("hidden", { try await $0.setCommonGroundHidden(token: $1, hidden: hidden) }) {
            apply(saved)
        }
    }

    func setSharing(_ sharing: Bool) async {
        guard let saved = await run("sharing", { try await $0.setCommonGroundSharing(token: $1, sharing: sharing) }) else { return }
        apply(saved)
        if sharing {
            await newPairCode(quiet: true)
        } else {
            pairCode = nil
        }
    }

    func deleteCard() async -> Bool {
        guard let view = await run("delete", { try await $0.deleteCommonGroundCard(token: $1) }) else { return false }
        apply(view)
        recent = []
        pairCode = nil
        rooms = [:]
        people = [:]
        return true
    }

    // MARK: Pairing

    func isPairCodeExpired(now: Date = .now) -> Bool {
        guard let expiry = pairCode?.expiry else { return true }
        return expiry <= now
    }

    func newPairCode(quiet: Bool = false) async {
        do {
            pairCode = try await call { try await $0.newCommonGroundPairCode(token: $1) }
        } catch {
            if !quiet { report(error) }
        }
    }

    /// Pairs with someone's code; returns their account id.
    func redeem(_ code: String) async -> String? {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let result = await run("redeem", { try await $0.redeemCommonGroundPairCode(token: $1, code: trimmed) }) else { return nil }
        people[result.person.accountId] = result
        return result.person.accountId
    }

    // MARK: Rooms

    func joinRoom(_ code: String) async -> Bool {
        guard let room = await run("join", { try await $0.joinCommonGroundRoom(token: $1, code: code) }) else { return false }
        rooms[code] = room
        results[code] = nil
        return true
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

    /// Polls results while the server is still matching.
    func waitForResults(_ code: String, every interval: Duration = matchPollInterval) async {
        while results[code]?.isMatching == true, !Task.isCancelled {
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            await loadResults(code, quiet: true)
        }
    }

    func createGroup(code: String, name: String, memberIds: [String]) async -> CommonGroundCreatedGroup? {
        guard let created = await run("group", {
            try await $0.createCommonGroundGroup(token: $1, code: code, name: name, memberIds: memberIds)
        }) else { return nil }
        var group = created.group
        group.joined = true
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

    // MARK: People

    func loadPerson(_ accountId: String) async {
        do {
            people[accountId] = try await call { try await $0.commonGroundPerson(token: $1, accountId: accountId) }
        } catch {
            report(error)
        }
    }

    func loadMatch(_ accountId: String) async {
        do {
            matches[accountId] = try await call { try await $0.commonGroundMatch(token: $1, accountId: accountId) }
        } catch {
            report(error)
        }
    }

    /// Polls a match while the server is still finding it.
    func waitForMatch(_ accountId: String, every interval: Duration = matchPollInterval) async {
        while matches[accountId]?.isMatching == true, !Task.isCancelled {
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            await loadMatch(accountId)
        }
    }

    /// The person as last seen in any loaded view.
    func person(_ accountId: String) -> CommonGroundPerson? {
        matches[accountId]?.person
            ?? people[accountId]?.person
            ?? recent.first { $0.person.accountId == accountId }?.person
            ?? results.values.lazy.flatMap(\.people).first { $0.person.accountId == accountId }?.person
            ?? rooms.values.lazy.flatMap(\.members).first { $0.accountId == accountId }
    }

    /// The newest relationship known for a person, from any view that carries one.
    func relationship(for accountId: String) -> CommonGroundRelationship? {
        if let local = relationships[accountId] { return local }
        if let match = matches[accountId], let relationship = match.relationship ?? match.person.relationship { return relationship }
        if let card = people[accountId], let relationship = card.relationship ?? card.person.relationship { return relationship }
        if let entry = recent.first(where: { $0.person.accountId == accountId }), let relationship = entry.relationship { return relationship }
        for result in results.values {
            if let entry = result.people.first(where: { $0.person.accountId == accountId }), let relationship = entry.relationship {
                return relationship
            }
        }
        return rooms.values.lazy.flatMap(\.members).first { $0.accountId == accountId }?.relationship
    }

    func setRelationship(_ accountId: String, _ relationship: CommonGroundRelationship) {
        relationships[accountId] = relationship
    }

    func markContact(_ accountId: String) {
        var next = relationship(for: accountId) ?? CommonGroundRelationship()
        next.contact = true
        next.request = nil
        next.requestId = nil
        relationships[accountId] = next
    }

    /// Add: sends a contact request, or accepts theirs when they asked first.
    func addContact(_ accountId: String) async {
        do {
            busy = "contact"
            defer { busy = nil }
            let response = try await call { try await $0.addCommonGroundContact(token: $1, accountId: accountId) }
            relationships[accountId] = response.relationship
        } catch let error as CloudAPIError where error.code == "already_contact" {
            markContact(accountId)
        } catch {
            report(error)
        }
    }

    /// Finds or creates the direct conversation with a contact.
    func openChat(_ accountId: String) async -> CommonGroundChatResponse? {
        guard let response = await run("chat", { try await $0.openCommonGroundChat(token: $1, accountId: accountId) }) else {
            return nil
        }
        if let relationship = response.relationship { relationships[accountId] = relationship }
        return response
    }

    func meet(_ accountId: String, input: CommonGroundMeetInput) async -> CommonGroundMeetResponse? {
        guard let response = await run("meet", { try await $0.proposeCommonGroundMeeting(token: $1, accountId: accountId, input: input) }) else {
            return nil
        }
        if let relationship = response.relationship { relationships[accountId] = relationship }
        return response
    }
}
