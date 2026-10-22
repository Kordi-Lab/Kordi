import Foundation
import SwiftUI

/// `POST rooms`: opens a room under a new code, shared with one profile.
struct CommonGroundCreateRoomRequest: Encodable, Hashable {
    var name: String
    var kind: String?
    var profileId: String?
}

/// One card in Home's wallet.
struct CommonGroundWalletCard: Identifiable, Hashable {
    /// The profile id; `default` before profiles, `suggested` for the first-run card.
    let id: String
    let design: CommonGroundCardDesign
    let name: String
    var focus: String?
    var topics: [String] = []
    var hasCard = false

    static let suggestedID = "suggested"
    static let defaultID = "default"

    var isSuggested: Bool { id == Self.suggestedID }

    /// The empty wallet's single card: Work, ready to build.
    static let suggestedWork = CommonGroundWalletCard(id: suggestedID, design: .work, name: "Work", focus: "Suggested")
}

/// The wallet on Home: cards per profile with their topics, the card that
/// is shared, a new card per design, and creating a code for a meetup.
extension CommonGroundModel {
    static func visibleTopics(_ card: CommonGroundOwnCard?) -> [String] {
        guard let card else { return [] }
        let hidden = Set(card.hidden)
        return card.topics.all.filter { !hidden.contains($0) }
    }

    func design(of profile: CommonGroundProfileSummary) -> CommonGroundCardDesign {
        CommonGroundCardDesign.of(
            kind: profile.kind, name: profile.name,
            saved: CommonGroundCardDesignStore.saved(profile.profileId, defaults: defaults)
        )
    }

    func design(ofProfile profileId: String?) -> CommonGroundCardDesign {
        profile(profileId).map(design(of:)) ?? .work
    }

    /// Cards in profile order, or one Work card before profiles; the
    /// suggested Work card when there is nothing yet.
    var walletCards: [CommonGroundWalletCard] {
        guard loaded || !profiles.isEmpty else { return [] }
        guard profilesEnabled else {
            guard hasCard || isBuilding else { return [.suggestedWork] }
            return [CommonGroundWalletCard(id: CommonGroundWalletCard.defaultID, design: .work, name: "Work", topics: myTopics, hasCard: hasCard)]
        }
        if profiles.isEmpty { return [.suggestedWork] }
        return profiles.map { profile in
            let current = profile.profileId == currentProfileID && owner != nil
            return CommonGroundWalletCard(
                id: profile.profileId,
                design: design(of: profile),
                name: profile.title,
                focus: profile.focusLine,
                topics: current ? myTopics : walletTopics[profile.profileId] ?? [],
                hasCard: current ? hasCard : profile.hasCard
            )
        }
    }

    /// The card on top of the stack, which rooms and codes share.
    var walletSelectedID: String? {
        guard profilesEnabled else { return walletCards.first?.id }
        return currentProfileID ?? walletCards.first?.id
    }

    var canAddCard: Bool {
        profilesEnabled && loaded && profiles.count < CommonGroundCardDesign.walletLimit
    }

    /// Topics for the cards that are not current, so the fanned wallet shows
    /// them. Quiet on failure.
    func loadWalletTopics() async {
        guard profilesEnabled else { return }
        for profile in profiles where profile.profileId != currentProfileID {
            guard profile.hasCard else {
                walletTopics[profile.profileId] = nil
                continue
            }
            let id = profile.profileId
            if let view = try? await call({ try await $0.commonGroundCard(token: $1, profileId: id) }) {
                walletTopics[id] = Self.visibleTopics(view.card)
            }
        }
    }

    /// Where the card's references came from, most used first.
    var cardSources: [String] {
        guard let evidence = card?.profile?.evidence.values else { return [] }
        var counts: [String: Int] = [:]
        for item in evidence where !item.source.isEmpty { counts[item.source, default: 0] += 1 }
        return counts.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.map(\.key)
    }

    /// Creates a card of a design; a custom design keeps its look on this device.
    @discardableResult
    func createCard(_ design: CommonGroundCardDesign, name: String, focus: String) async -> CommonGroundProfileSummary? {
        await createProfile(CommonGroundNewProfile(kind: design.kind, name: name, focus: focus), design: design)
    }

    // MARK: Rooms

    /// The create body: the meetup name and the chosen profile with its kind.
    func createRoomRequest(name: String, profileId: String?) -> CommonGroundCreateRoomRequest {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard profilesEnabled else { return CommonGroundCreateRoomRequest(name: name) }
        return CommonGroundCreateRoomRequest(name: name, kind: profile(profileId)?.kind, profileId: profileId)
    }

    /// Opens a room for a meetup; the room goes to the top of Rooms.
    func createRoom(name: String, profileId: String?) async -> CommonGroundRoom? {
        let request = createRoomRequest(name: name, profileId: profileId)
        guard !request.name.isEmpty,
              let room = await run("create", { try await $0.createCommonGroundRoom(token: $1, request: request) }) else { return nil }
        setRoom(room, code: room.code)
        await loadRooms()
        raiseRoom(room.code)
        return room
    }

    /// Joins a room from Home's code row; the room goes to the top of Rooms.
    func joinFromHome(_ code: String, profileId: String?) async -> CommonGroundRoom? {
        guard await joinRoom(code, request: joinRequest(profileId: profileId)) else { return nil }
        await loadRooms()
        raiseRoom(code)
        return rooms[code]
    }

    /// Whether you are already in an open room with this code.
    func isInOpenRoom(_ code: String) -> Bool {
        roomList?.contains { $0.code == code && $0.open } ?? false
    }
}
