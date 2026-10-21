import Foundation

/// People: cards, matches and contact actions with someone you met.
extension CommonGroundModel {
    /// Sees a person through one of your profiles from now on; a different
    /// profile drops what was loaded through the last one.
    func view(_ accountId: String, through profileId: String?) {
        guard profilesEnabled, let profileId, viewerProfiles[accountId] != profileId else { return }
        viewerProfiles[accountId] = profileId
        matches[accountId] = nil
        people[accountId] = nil
    }

    func loadPerson(_ accountId: String) async {
        do {
            let profileId = viewerProfiles[accountId]
            people[accountId] = try await call { try await $0.commonGroundPerson(token: $1, accountId: accountId, profileId: profileId) }
        } catch {
            report(error)
        }
    }

    func loadMatch(_ accountId: String) async {
        do {
            let profileId = viewerProfiles[accountId]
            matches[accountId] = try await call { try await $0.commonGroundMatch(token: $1, accountId: accountId, profileId: profileId) }
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
