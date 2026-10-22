import Foundation

/// Card sources (`commonGroundVersion` 3): the picks saved on each profile
/// and the account's own documents a card can read.
extension CommonGroundModel {
    /// The current profile's saved picks; nil before version 3 or before
    /// anything was saved.
    var currentSources: CommonGroundSourcePicks? {
        sourcesEnabled ? currentProfile?.sources : nil
    }

    /// Saves the picks without building, so other devices open with them.
    /// Quiet unless the server refuses.
    func saveSources(_ picks: CommonGroundSourcePicks, for profileId: String) async {
        guard sourcesEnabled, let current = profile(profileId), (current.sources ?? CommonGroundSourcePicks()) != picks else { return }
        let edit = CommonGroundProfileEdit(sources: .some(picks))
        do {
            let saved = try await call { try await $0.updateCommonGroundProfile(token: $1, profileId: profileId, edit: edit) }
            if let index = profiles.firstIndex(where: { $0.profileId == profileId }) { profiles[index] = saved }
        } catch {
            report(error)
        }
    }

    /// Keeps the picks a build saved, so the list matches the server.
    func rememberSources(_ picks: CommonGroundSourcePicks, for profileId: String?) {
        guard let profileId, let index = profiles.firstIndex(where: { $0.profileId == profileId }) else { return }
        profiles[index].sources = picks
    }

    /// Documents a card can read; nil before version 3 or on failure.
    func loadDocuments() async -> [CommonGroundDocument]? {
        guard sourcesEnabled else { return nil }
        return try? await call { try await $0.commonGroundDocuments(token: $1) }.documents
    }
}
