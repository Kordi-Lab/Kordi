import Foundation
import SwiftUI

/// What the sheet knows before the profile request answers: the contact row's
/// data, enough for the header and tiles.
struct ContactProfileSubject: Identifiable, Hashable {
    let accountId: String
    var name: String
    var avatarUrl: String?
    var kordiId: String?
    var kind: CloudContactProfile.Kind = .person

    var id: String { accountId }

    init(
        accountId: String,
        name: String,
        avatarUrl: String? = nil,
        kordiId: String? = nil,
        kind: CloudContactProfile.Kind = .person
    ) {
        self.accountId = accountId
        self.name = name
        self.avatarUrl = avatarUrl
        self.kordiId = kordiId
        self.kind = kind
    }

    init(contact: CloudContact) {
        let isSystem = contact.contactKind == "system_agent"
            || KordiSupportIdentity.matches(name: contact.preferredName, seed: contact.accountId)
        self.init(
            accountId: contact.accountId,
            name: contact.preferredName,
            avatarUrl: contact.avatarUrl.nonEmpty,
            kordiId: contact.kordiId.nonEmpty,
            kind: isSystem ? .system : .person
        )
    }
}

enum ContactProfileTile: String, Identifiable, Hashable {
    case message, mute, share, settings, more

    var id: Self { self }
}

/// The pure part of the sheet: which status line, tiles and rows a profile shows.
struct ContactProfilePresentation: Equatable {
    enum StatusTone: Equatable { case online, muted }

    let subject: ContactProfileSubject
    let profile: CloudContactProfile?
    /// True when the flag is missing or the request failed: Kordi ID, Message and Delete only.
    let isFallback: Bool
    var selfAccountId: String? = nil
    var presence: CloudPresenceAccount? = nil
    /// The server can remove contacts (`contactProfileVersion` present).
    var canDelete: Bool = false

    var kind: CloudContactProfile.Kind { profile?.kind ?? subject.kind }
    var name: String { profile?.displayName?.nonEmpty ?? subject.name }
    var avatarUrl: String? { profile?.avatarUrl?.nonEmpty ?? subject.avatarUrl }
    var kordiId: String? { profile?.kordiId?.nonEmpty ?? subject.kordiId }

    var isOwnAgent: Bool {
        guard kind == .agent else { return false }
        if profile?.isSelf == true { return true }
        guard let owner = profile?.owner?.accountId, let selfAccountId else { return false }
        return owner == selfAccountId
    }

    var effectivePresence: CloudPresenceAccount? {
        if let presence = profile?.presence {
            return CloudPresenceAccount(accountId: subject.accountId, status: presence.status, lastSeenAt: presence.lastSeenAt)
        }
        return presence
    }

    var isOnline: Bool { kind == .person && effectivePresence?.status == .online }

    func statusLine(now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        switch kind {
        case .system:
            return "Kordi"
        case .agent:
            if isOwnAgent { return "Your agent" }
            if let owner = profile?.owner?.displayName?.nonEmpty { return "Agent · owned by \(owner)" }
            return "Agent"
        case .person:
            return ContactPresencePresentation.label(for: effectivePresence, now: now, calendar: calendar, locale: locale)
        }
    }

    var statusTone: StatusTone { isOnline ? .online : .muted }

    var tiles: [ContactProfileTile] {
        switch kind {
        case .system: return [.message]
        case .agent: return isOwnAgent ? [.message, .settings, .more] : [.message, .share, .more]
        case .person: return [.message, .mute, .share, .more]
        }
    }

    var showsKordiId: Bool { kind != .system && kordiId != nil }
    var about: String? { isFallback ? nil : profile?.about?.nonEmpty }
    var showsType: Bool { !isFallback && kind == .agent }
    var theirAgent: CloudContactProfile.Agent? { isFallback || kind != .person ? nil : profile?.defaultAgent }
    var owner: CloudContactProfile.Owner? { isFallback || kind != .agent || isOwnAgent ? nil : profile?.owner }

    var contactSince: Date? {
        guard !isFallback, let value = profile?.contactSince?.nonEmpty else { return nil }
        let date = parseCloudDate(value)
        return date == .distantPast ? nil : date
    }

    /// Nil hides the section; the system contact and your own agent never show it.
    var shared: CloudContactProfile.Shared? {
        guard !isFallback, kind != .system, !isOwnAgent else { return nil }
        return profile?.shared
    }

    var commonGround: CloudContactProfile.CommonGround? {
        guard !isFallback, kind == .person, let ground = profile?.commonGround, !ground.isEmpty else { return nil }
        return ground
    }

    /// Whether the person can be deleted at all; the More menu keeps a disabled item otherwise.
    var offersDelete: Bool { kind != .system && !isOwnAgent }
    /// The bottom red row shows only when deleting works.
    var showsDelete: Bool { offersDelete && canDelete }

    /// "@482 731 906", the way the preview groups the nine digits.
    static func formattedKordiId(_ value: String) -> String {
        let digits = value.filter(\.isNumber)
        guard digits.count == 9 else { return "@\(value)" }
        var groups: [String] = []
        var index = digits.startIndex
        while index < digits.endIndex {
            let end = digits.index(index, offsetBy: 3, limitedBy: digits.endIndex) ?? digits.endIndex
            groups.append(String(digits[index..<end]))
            index = end
        }
        return "@" + groups.joined(separator: " ")
    }

    static func formattedDay(_ date: Date, locale: Locale = .current, calendar: Calendar = .current) -> String {
        date.formatted(
            Date.FormatStyle(date: .omitted, time: .omitted, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
                .day().month(.abbreviated).year()
        )
    }
}

/// Loads the profile once the sheet appears. `loader` is nil when the server
/// does not report `contactProfileVersion`, which shows the fallback at once.
@MainActor
final class ContactProfileModel: ObservableObject {
    typealias Loader = () async throws -> CloudContactProfile
    typealias Remover = () async throws -> Void

    @Published private(set) var profile: CloudContactProfile?
    @Published private(set) var isFallback: Bool
    @Published private(set) var isLoading: Bool
    @Published private(set) var isDeleting = false
    private let loader: Loader?
    private let remover: Remover?

    var canDelete: Bool { remover != nil }

    init(loader: Loader?, profile: CloudContactProfile? = nil, remover: Remover? = nil) {
        self.loader = loader
        self.remover = remover
        self.profile = profile
        isFallback = loader == nil && profile == nil
        isLoading = loader != nil && profile == nil
    }

    func load() async {
        guard let loader, profile == nil else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            profile = try await loader()
            isFallback = false
        } catch {
            if !(error is CancellationError) { isFallback = true }
        }
    }

    /// Removes the contact; throws the server error for the caller to show.
    func removeContact() async throws {
        guard let remover, !isDeleting else { return }
        isDeleting = true
        defer { isDeleting = false }
        try await remover()
    }
}

enum ContactProfileAvailability {
    static func isEnabled(_ capabilities: CloudAuthCapabilities?) -> Bool {
        (capabilities?.contactProfileVersion ?? 0) >= 1
    }
}

extension AppModel {
    func makeContactProfileModel(for subject: ContactProfileSubject) -> ContactProfileModel {
        if isPreviewMode {
            let profile = ContactProfilePreviewData.profile(for: subject)
            return ContactProfileModel { profile }
        }
        guard ContactProfileAvailability.isEnabled(memoryCapabilities) else {
            return ContactProfileModel(loader: nil)
        }
        let accountId = subject.accountId
        return ContactProfileModel(
            loader: { [weak self] in
                guard let self else { throw CancellationError() }
                let (api, token, _) = try self.digestContext()
                return try await api.fetchContactProfile(token: token, accountId: accountId)
            },
            remover: { [weak self] in
                guard let self else { throw CancellationError() }
                let (api, token, _) = try self.digestContext()
                try await api.removeContact(token: token, accountId: accountId)
                await self.refreshWorkspace(showSyncActivity: false)
            }
        )
    }

    /// The direct chat with an account, existing or new.
    func directConversation(withAccountId accountId: String) -> ConversationSummary? {
        if let found = conversations.first(where: { $0.kind == .person && $0.peerAccountId == accountId }) {
            return found
        }
        return contacts.first { $0.accountId == accountId }.flatMap(conversationForContact)
    }

    /// The most recent chat with an agent, matched by agent id or agent account,
    /// preferring a real session over a launch template.
    func agentConversation(agentId: String? = nil, accountId: String? = nil) -> ConversationSummary? {
        let matches = conversations.filter { conversation in
            guard conversation.kind == .agent else { return false }
            if let agentId, conversation.agentId == agentId { return true }
            if let accountId, conversation.peerAccountId == accountId || conversation.agentId == accountId { return true }
            return false
        }
        return matches.first { !$0.isAgentLaunchTemplate } ?? matches.first
    }

    func groupConversation(groupSpaceId: String) -> ConversationSummary? {
        conversations.first { $0.kind == .group && $0.groupSpaceId == groupSpaceId }
    }

    func contactProfileSubject(for conversation: ConversationSummary) -> ContactProfileSubject {
        if let contact = contacts.first(where: { $0.accountId == conversation.peerAccountId }) {
            return ContactProfileSubject(contact: contact)
        }
        return ContactProfileSubject(
            accountId: conversation.peerAccountId,
            name: conversation.displayName,
            avatarUrl: conversation.avatarSource?.nonEmpty,
            kind: conversation.representsKordiSupport ? .system : .person
        )
    }
}
