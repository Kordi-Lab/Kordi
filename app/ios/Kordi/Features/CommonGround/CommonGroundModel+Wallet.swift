import Foundation
import SwiftUI

/// `POST rooms`: opens a room under a new code, shared with one profile.
struct CommonGroundCreateRoomRequest: Encodable, Hashable {
    var name: String
    var kind: String?
    var profileId: String?
}

/// `GET rooms/:code/preview`: a room as anyone with its code sees it before joining.
struct CommonGroundRoomPreview: Decodable, Hashable {
    let code: String
    let name: String
    var kind: String?
    var memberCount: Int
    var member: Bool
    /// For a member, the card already shared there.
    var profileId: String?
    /// For anyone else, the card a join would share.
    var suggestedProfileId: String?

    init(code: String, name: String, kind: String? = nil, memberCount: Int = 0, member: Bool = false,
         profileId: String? = nil, suggestedProfileId: String? = nil) {
        self.code = code
        self.name = name
        self.kind = kind
        self.memberCount = memberCount
        self.member = member
        self.profileId = profileId
        self.suggestedProfileId = suggestedProfileId
    }

    private enum CodingKeys: String, CodingKey { case code, name, kind, memberCount, member, profileId, suggestedProfileId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil
        memberCount = (try? c.decodeIfPresent(Int.self, forKey: .memberCount)) ?? 0
        member = (try? c.decodeIfPresent(Bool.self, forKey: .member)) ?? false
        profileId = (try? c.decodeIfPresent(String.self, forKey: .profileId)) ?? nil
        suggestedProfileId = (try? c.decodeIfPresent(String.self, forKey: .suggestedProfileId)) ?? nil
    }

    var title: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Room \(code)" : trimmed
    }

    /// "Work · 5 people"; only the count for a room without a kind.
    var detail: String {
        let people = memberCount == 1 ? "1 person" : "\(memberCount) people"
        guard let kind = kind.flatMap(CommonGroundProfileKind.init(rawValue:)) else { return people }
        return "\(kind.title) · \(people)"
    }
}

/// What a typed code finds before joining.
enum CommonGroundRoomLookup: Equatable {
    case found(CommonGroundRoomPreview)
    /// A line for under the code boxes; nil when there is nothing to say.
    case failed(String?)
    /// The server has no preview; the join goes ahead as before.
    case unavailable
    /// A newer code was typed meanwhile; this answer is dropped.
    case stale
}

/// One card in Home's wallet.
struct CommonGroundWalletCard: Identifiable, Hashable {
    /// The profile id; `default` before profiles, `suggested` for the first-run card.
    let id: String
    let design: CommonGroundCardDesign
    var icon: CommonGroundCardIcon?
    /// The kind's design, whose glyph a colour design draws.
    var kindDesign: CommonGroundCardDesign = .work
    let name: String
    var focus: String?
    var topics: [String] = []
    var hasCard = false

    static let suggestedID = "suggested"
    static let defaultID = "default"

    var isSuggested: Bool { id == Self.suggestedID }

    /// The empty wallet's single card: Work, ready to build.
    static let suggestedWork = CommonGroundWalletCard(id: suggestedID, design: .work, icon: nil, name: "Work", focus: "Suggested")

    /// Only a profile's card has a look to change.
    var hasLook: Bool { !isSuggested && id != Self.defaultID }
}

/// The wallet on Home: cards per profile with their topics, the card that
/// is shared, a new card per design, and creating a code for a meetup.
extension CommonGroundModel {
    static func visibleTopics(_ card: CommonGroundOwnCard?) -> [String] {
        guard let card else { return [] }
        let hidden = Set(card.hidden)
        return card.topics.all.filter { !hidden.contains($0) }
    }

    func design(of profile: CommonGroundProfileSummary) -> CommonGroundCardDesign { profile.cardDesign }

    func design(ofProfile profileId: String?) -> CommonGroundCardDesign {
        profile(profileId).map(design(of:)) ?? .work
    }

    /// Cards in profile order, or one Work card before profiles; the
    /// suggested Work card when there is nothing yet.
    var walletCards: [CommonGroundWalletCard] {
        guard loaded || !profiles.isEmpty else { return [] }
        guard profilesEnabled else {
            guard hasCard || isBuilding else { return [.suggestedWork] }
            return [CommonGroundWalletCard(id: CommonGroundWalletCard.defaultID, design: .work, icon: nil, name: "Work", topics: myTopics, hasCard: hasCard)]
        }
        if profiles.isEmpty { return [.suggestedWork] }
        return profiles.map { profile in
            let current = profile.profileId == currentProfileID && owner != nil
            return CommonGroundWalletCard(
                id: profile.profileId,
                design: design(of: profile),
                icon: profile.cardIcon,
                kindDesign: profile.kindDesign,
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

    /// Creates a card of a design, drawn with `look` and `icon` when chosen;
    /// the server keeps both.
    @discardableResult
    func createCard(_ design: CommonGroundCardDesign, name: String, focus: String,
                    look: CommonGroundCardDesign? = nil, icon: CommonGroundCardIcon? = nil) async -> CommonGroundProfileSummary? {
        await createProfile(CommonGroundNewProfile(kind: design.kind, name: name, focus: focus, design: look ?? design, icon: icon))
    }

    /// Changes a card's background or icon at once and saves it; the old
    /// look comes back when the server refuses. `icon: .some(nil)` goes back
    /// to the design's glyph.
    @discardableResult
    func setCardLook(_ profileId: String, design: CommonGroundCardDesign? = nil, icon: CommonGroundCardIcon?? = nil) async -> Bool {
        guard let index = profiles.firstIndex(where: { $0.profileId == profileId }) else { return false }
        let before = profiles[index]
        var after = before
        if let design { after.design = design.rawValue }
        if let icon { after.icon = icon?.rawValue }
        guard after != before else { return true }
        profiles[index] = after
        let edit = CommonGroundProfileEdit(design: design?.rawValue, icon: icon.map { $0?.rawValue })
        let saved = await run("look") { try await $0.updateCommonGroundProfile(token: $1, profileId: profileId, edit: edit) }
        // A later tap may have changed the look meanwhile; leave that one alone.
        guard let now = profiles.firstIndex(where: { $0.profileId == profileId }),
              profiles[now].design == after.design, profiles[now].icon == after.icon else { return saved != nil }
        if let saved {
            profiles[now] = saved
            return true
        }
        profiles[now].design = before.design
        profiles[now].icon = before.icon
        return false
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

    /// Looks a typed code up once, never retried; a 429 asks to wait. Only
    /// the latest code's answer counts, so an older one comes back `.stale`.
    func previewRoom(_ code: String) async -> CommonGroundRoomLookup {
        latestLookup = code
        let lookup: CommonGroundRoomLookup
        do {
            let preview = try await call { try await $0.commonGroundRoomPreview(token: $1, code: code) }
            guard latestLookup == code else { return .stale }
            roomPreviews[code] = preview
            lookup = .found(preview)
        } catch let error as CloudAPIError where error.statusCode == 404 && !error.code.hasPrefix("common_ground") {
            lookup = .unavailable
        } catch let error as CloudAPIError where error.statusCode == 429 || error.code == "rate_limited" {
            lookup = .failed("Try again in a minute.")
        } catch {
            lookup = .failed(Self.message(for: error))
        }
        return latestLookup == code ? lookup : .stale
    }

    /// The card a room suggests: the server's pick when it is one you can
    /// share, else the first card of the room's kind.
    func suggestedProfile(forRoom code: String) -> String? {
        if let id = roomPreviews[code]?.suggestedProfileId, shareChoices.contains(where: { $0.profileId == id }) { return id }
        return CommonGroundProfileChoice.suggested(roomKind: suggestedKind(ofRoom: code), in: shareChoices)
    }

    /// The card a join preselects: the suggested one, else the current card,
    /// else the first card you can share.
    func preselectedProfile(forRoom code: String) -> String? {
        suggestedProfile(forRoom: code)
            ?? CommonGroundProfileChoice.preselected(roomKind: nil, current: currentProfileID, in: shareChoices)
    }

    /// "Work · 5 people" for a code looked up before joining.
    func roomDetail(_ code: String) -> String? { roomPreviews[code]?.detail }

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
