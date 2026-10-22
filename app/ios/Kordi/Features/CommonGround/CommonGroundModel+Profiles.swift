import Foundation

/// Profiles: the list, the current one on Home (saved per account), create,
/// rename, focus, delete, and the profile shared in a room.
extension CommonGroundModel {
    var currentProfile: CommonGroundProfileSummary? {
        guard profilesEnabled, let currentProfileID else { return nil }
        return profiles.first { $0.profileId == currentProfileID }
    }

    var anyProfileHasCard: Bool { profilesEnabled && profiles.contains(where: \.hasCard) }

    /// Profiles that can be shared: the ones with a card.
    var shareChoices: [CommonGroundProfileSummary] { profilesEnabled ? profiles.filter(\.hasCard) : [] }

    /// A join or pair code asks which profile to share only when there is a choice.
    var asksWhichProfile: Bool { shareChoices.count > 1 }

    /// Fixed kinds that already exist cannot be created again.
    func canCreate(_ kind: CommonGroundProfileKind) -> Bool {
        !kind.isFixed || !profiles.contains { $0.kind == kind.rawValue }
    }

    func profile(_ profileId: String?) -> CommonGroundProfileSummary? {
        guard let profileId else { return nil }
        return profiles.first { $0.profileId == profileId }
    }

    /// The Build hero for the current profile.
    var buildTitle: String { currentProfile?.buildTitle ?? "Build your profile" }

    /// Loads the list and settles the current profile. Quiet on failure.
    func loadProfiles() async {
        guard profilesEnabled, let list = try? await call({ try await $0.commonGroundProfiles(token: $1) }) else { return }
        profiles = list.profiles
        let saved = currentProfileID ?? CommonGroundProfileChoice.saved(account: me.accountId, defaults: defaults)
        let current = CommonGroundProfileChoice.current(saved: saved, in: profiles)
        if current != currentProfileID {
            currentProfileID = current
            CommonGroundProfileChoice.save(current, account: me.accountId, defaults: defaults)
        }
    }

    /// Makes a profile current, saves the choice and loads its card.
    func selectProfile(_ profileId: String) async {
        guard profilesEnabled, profileId != currentProfileID else { return }
        currentProfileID = profileId
        CommonGroundProfileChoice.save(profileId, account: me.accountId, defaults: defaults)
        resetOwner()
        await refreshCard()
    }

    /// Creates a profile and makes it current; nil when the server refused.
    @discardableResult
    func createProfile(_ draft: CommonGroundNewProfile, design: CommonGroundCardDesign? = nil) async -> CommonGroundProfileSummary? {
        guard draft.isValid,
              let created = await run("profile", { try await $0.createCommonGroundProfile(token: $1, profile: draft) }) else { return nil }
        if let design, design.kind == .custom {
            CommonGroundCardDesignStore.save(design, profileId: created.profileId, defaults: defaults)
        }
        profiles.removeAll { $0.profileId == created.profileId }
        profiles.append(created)
        profiles.sort { $0.position < $1.position }
        await selectProfile(created.profileId)
        return created
    }

    /// Renames a profile or changes its focus; an empty focus clears it.
    @discardableResult
    func updateProfile(_ profileId: String, name: String? = nil, focus: String? = nil) async -> Bool {
        let edit = CommonGroundProfileEdit(
            name: name?.trimmingCharacters(in: .whitespacesAndNewlines),
            focus: focus?.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        guard let saved = await run("profile", {
            try await $0.updateCommonGroundProfile(token: $1, profileId: profileId, edit: edit)
        }) else { return false }
        if let index = profiles.firstIndex(where: { $0.profileId == profileId }) { profiles[index] = saved }
        return true
    }

    /// Deletes a profile with its card; another profile becomes current.
    @discardableResult
    func deleteProfile(_ profileId: String) async -> Bool {
        guard (await run("profile", { try await $0.deleteCommonGroundProfile(token: $1, profileId: profileId) })) != nil else { return false }
        profiles.removeAll { $0.profileId == profileId }
        walletTopics[profileId] = nil
        CommonGroundCardDesignStore.save(nil, profileId: profileId, defaults: defaults)
        if currentProfileID == profileId {
            currentProfileID = nil
            CommonGroundProfileChoice.save(nil, account: me.accountId, defaults: defaults)
            resetOwner()
        }
        await loadHome()
        return true
    }

    // MARK: Rooms

    /// The profile you share in a room, from the room or the rooms list.
    func sharedProfileID(inRoom code: String) -> String? {
        rooms[code]?.profileId ?? roomList?.first { $0.code == code }?.profileId
    }

    /// The kind a room suggests, when it is known before joining.
    func suggestedKind(ofRoom code: String) -> String? {
        rooms[code]?.kind ?? roomList?.first { $0.code == code }?.kind
    }

    /// "Sharing: Work" for a room; nil before profiles or while unknown.
    func sharingLine(inRoom code: String) -> String? {
        guard profilesEnabled, let shared = sharedProfileID(inRoom: code) else { return nil }
        let title = profile(shared)?.title
            ?? rooms[code]?.kind.map { CommonGroundProfileSummary.title(kind: $0, name: "") }
        return title.map { "Sharing: \($0)" }
    }

    /// The join body: the chosen profile with its kind, which names the
    /// room's kind when this join opens it.
    func joinRequest(profileId: String?, roomName: String = "") -> CommonGroundJoinRequest {
        guard profilesEnabled else { return CommonGroundJoinRequest() }
        let name = roomName.trimmingCharacters(in: .whitespacesAndNewlines)
        return CommonGroundJoinRequest(
            name: name.isEmpty ? nil : name,
            kind: profile(profileId)?.kind,
            profileId: profileId
        )
    }

    /// Shares another profile in an open room; its results are matched again.
    @discardableResult
    func switchRoomProfile(_ code: String, to profileId: String) async -> Bool {
        guard let room = await run("switch", {
            try await $0.switchCommonGroundRoomProfile(token: $1, code: code, profileId: profileId)
        }) else { return false }
        setRoom(room, code: code)
        await loadRooms()
        return true
    }

    /// A row title with the profile you share there unless it is Work.
    func roomRowTitle(_ room: CommonGroundRoomSummary) -> String {
        guard profilesEnabled, let shared = profile(room.profileId), !shared.isWork else { return room.title }
        return "\(room.title) · \(shared.title)"
    }
}
