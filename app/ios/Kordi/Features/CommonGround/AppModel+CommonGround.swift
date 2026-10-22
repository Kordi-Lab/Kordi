import Foundation

/// Whether the Common ground entry exists in Contacts: the account is signed
/// in and the server reports `commonGroundVersion` 1 or later.
enum CommonGroundAvailability {
    /// Debug launch argument that opens the app on the Contacts tab.
    static let previewArgument = "--preview-common-ground"

    static func isPreviewRequested(arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
#if DEBUG
        arguments.contains(previewArgument)
#else
        false
#endif
    }

    static func isEnabled(signedIn: Bool, capabilities: CloudAuthCapabilities?) -> Bool {
        signedIn && (capabilities?.commonGroundVersion ?? 0) >= 1
    }

    /// Version 2 has profiles; version 1 hides every profile control.
    static func hasProfiles(capabilities: CloudAuthCapabilities?) -> Bool {
        (capabilities?.commonGroundVersion ?? 0) >= 2
    }

    /// Version 3 keeps each card's sources and reads Kordi documents.
    static func hasSources(capabilities: CloudAuthCapabilities?) -> Bool {
        (capabilities?.commonGroundVersion ?? 0) >= 3
    }

    /// Whether a room invitation is waiting. There is no invitation feed
    /// outside a room yet, so the dot stays off.
    static func hasWaitingInvitation() -> Bool { false }
}

extension AppModel {
    /// `memoryCapabilities` holds the whole capabilities response.
    var isCommonGroundAvailable: Bool {
        CommonGroundAvailability.isEnabled(signedIn: phase == .signedIn, capabilities: memoryCapabilities)
    }

    var isMemoryCapabilityPresent: Bool { memoryCapabilities?.memoryVersion != nil }

    func makeCommonGroundModel() -> CommonGroundModel {
        let me = CommonGroundPerson(
            accountId: account?.accountId ?? "",
            name: account?.preferredName ?? "",
            avatarUrl: account?.avatarUrl,
            handle: ProfileDraft.customHandle(account?.kordiId)
        )
        let profiles = CommonGroundAvailability.hasProfiles(capabilities: memoryCapabilities)
        let sources = profiles && CommonGroundAvailability.hasSources(capabilities: memoryCapabilities)
        return CommonGroundModel(me: me, profilesEnabled: profiles, sourcesEnabled: sources) { [weak self] in
            guard let self else { throw CancellationError() }
            let (api, token, _) = try self.digestContext()
            return (api, token)
        }
    }

    /// The chat a Common ground action leads to. Looks in the loaded list
    /// first, then refreshes the workspace once and looks again.
    func commonGroundConversation(
        peerAccountId: String? = nil,
        groupSpaceId: String? = nil,
        conversationId: String? = nil,
        sessionId: String? = nil
    ) async -> ConversationSummary? {
        func find() -> ConversationSummary? {
            conversations.first { conversation in
                if let sessionId, conversation.sessionId == sessionId { return true }
                if let conversationId, conversation.id == conversationId { return true }
                if let groupSpaceId { return conversation.groupSpaceId == groupSpaceId }
                if let peerAccountId { return conversation.kind == .person && conversation.peerAccountId == peerAccountId }
                return false
            }
        }
        if let found = find() { return found }
        await refreshWorkspace(showSyncActivity: false)
        if let found = find() { return found }
        if let peerAccountId, let contact = contacts.first(where: { $0.accountId == peerAccountId }) {
            return conversationForContact(contact)
        }
        return nil
    }

    /// A group just started or joined from a room. The server may not have
    /// synced it yet, so after one refresh it tries once more a second later.
    func commonGroundGroupConversation(groupSpaceId: String, conversationId: String?) async -> ConversationSummary? {
        if let found = await commonGroundConversation(groupSpaceId: groupSpaceId, conversationId: conversationId) { return found }
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled else { return nil }
        return await commonGroundConversation(groupSpaceId: groupSpaceId, conversationId: conversationId)
    }

    /// Accepts a pending incoming request with the regular contacts call.
    /// Returns false when the request is not in the loaded list.
    func acceptCommonGroundRequest(requestId: String) async -> Bool {
        if !contactRequests.contains(where: { $0.requestId == requestId }) {
            await refreshContactRequests()
        }
        guard let request = contactRequests.first(where: { $0.requestId == requestId && $0.isIncoming }) else { return false }
        await acceptContactRequest(request)
        return !contactRequests.contains { $0.requestId == requestId }
    }
}
