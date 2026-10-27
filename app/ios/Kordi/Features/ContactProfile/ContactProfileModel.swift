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

/// A sheet keeps its original subject, so observe saved directory changes separately.
struct ContactProfileRefreshID: Equatable {
    let accountId: String
    let viewerAccountId: String?
    let avatarUrl: String?

    init(subject: ContactProfileSubject, viewer: CloudAccount?, contacts: [CloudContact]) {
        accountId = subject.accountId
        viewerAccountId = viewer?.accountId
        if let viewer, viewer.accountId == subject.accountId {
            avatarUrl = viewer.avatarUrl
        } else if let contact = contacts.first(where: { $0.accountId == subject.accountId }) {
            avatarUrl = contact.avatarUrl
        } else {
            avatarUrl = subject.avatarUrl
        }
    }
}

enum ContactProfileTile: String, Identifiable, Hashable {
    case message, call, video, mute, share, settings, more

    var id: Self { self }
}

enum ContactProfileSharedRow: String, Identifiable, Hashable {
    case photos, files, links, groups, todo, memory

    var id: Self { self }

    var title: String {
        switch self {
        case .photos: "Photos"
        case .files: "Files"
        case .links: "Links"
        case .groups: "Groups in common"
        case .todo: "Todo"
        case .memory: "Memory"
        }
    }

    var systemImage: String {
        switch self {
        case .photos: "photo"
        case .files: "doc"
        case .links: "link"
        case .groups: "person.2"
        case .todo: "checkmark.circle"
        case .memory: "brain"
        }
    }

    /// The page the row pushes inside the profile.
    var page: ContactProfileSharedPage? {
        switch self {
        case .photos: .photos
        case .files: .files
        case .links: .links
        case .groups, .todo, .memory: nil
        }
    }
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
    /// Pushed from the direct chat's header instead of shown as a sheet.
    var isPage: Bool = false
    /// Memory is offered (the Memory row on the page).
    var memoryAvailable: Bool = false
    /// Counts from the chat's whole history on this device; nil until it is loaded.
    var localShared: ContactProfileSharedItems.Counts? = nil

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
        case .person: return isPage ? [.call, .video, .mute, .more] : [.message, .mute, .share, .more]
        }
    }

    /// The page always lists the chat's content rows; the sheet only when the profile has counts.
    var showsSharedSection: Bool { isPage ? kind == .person : shared != nil }

    var sharedRows: [ContactProfileSharedRow] {
        guard isPage else { return [.photos, .files, .links, .groups] }
        return [.photos, .files, .links, .groups, .todo] + (memoryAvailable ? [.memory] : [])
    }

    /// Photos, files and links count the chat's items once its history is
    /// loaded, so a row matches its page; the server count stands in before.
    /// Nil for rows without any count.
    func sharedCount(_ row: ContactProfileSharedRow) -> Int? {
        switch row {
        case .photos: return localShared?.photos ?? shared?.mediaCount
        case .files: return localShared?.files ?? shared?.documentCount
        case .links: return localShared?.links ?? shared?.linkCount
        case .groups: return shared?.groups.count
        case .todo, .memory: return nil
        }
    }

    /// Rows with a count of 0 do nothing; Todo and Memory on the page open
    /// views with their own empty states.
    func isSharedRowEnabled(_ row: ContactProfileSharedRow) -> Bool {
        if isPage, [.todo, .memory].contains(row) { return true }
        return sharedCount(row).map { $0 > 0 } ?? true
    }

    /// The sheet collapses to one muted line when nothing is shared.
    var showsNothingShared: Bool {
        !isPage && shared != nil
            && [ContactProfileSharedRow.photos, .files, .links, .groups].allSatisfy { sharedCount($0) == 0 }
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

/// Loads profile details on appearance and when the saved avatar changes.
/// A server without `contactProfileVersion` uses a nil loader and the fallback.
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
    private var refreshID: ContactProfileRefreshID?
    private var loadID: UUID?
    private var needsRefresh = false

    var canDelete: Bool { remover != nil }

    init(loader: Loader?, profile: CloudContactProfile? = nil, remover: Remover? = nil) {
        self.loader = loader
        self.remover = remover
        self.profile = profile
        isFallback = loader == nil && profile == nil
        isLoading = loader != nil && profile == nil
    }

    func load(refreshID nextRefreshID: ContactProfileRefreshID? = nil) async {
        guard let loader, profile == nil || nextRefreshID != refreshID || needsRefresh else { return }
        if let refreshID, let nextRefreshID,
           refreshID.viewerAccountId != nextRefreshID.viewerAccountId
            || refreshID.accountId != nextRefreshID.accountId {
            profile = nil
            isFallback = false
        }
        refreshID = nextRefreshID
        needsRefresh = true
        let requestID = UUID()
        loadID = requestID
        isLoading = true
        defer { if loadID == requestID { isLoading = false } }
        do {
            let loaded = try await loader()
            try Task.checkCancellation()
            guard loadID == requestID else { return }
            profile = loaded
            needsRefresh = false
            isFallback = false
        } catch {
            guard loadID == requestID else { return }
            needsRefresh = true
            if !(error is CancellationError) { isFallback = profile == nil }
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
                let (api, token, viewerAccountId) = try self.digestContext()
                let profile = try await api.fetchContactProfile(token: token, accountId: accountId)
                let (_, currentToken, currentViewerAccountId) = try self.digestContext()
                guard currentToken == token, currentViewerAccountId == viewerAccountId else {
                    throw CancellationError()
                }
                return profile
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

    /// The chat whose photos, files and links the profile lists.
    func contactProfileSharedConversation(for subject: ContactProfileSubject) -> ConversationSummary? {
        switch subject.kind {
        case .person: directConversation(withAccountId: subject.accountId)
        case .agent: agentConversation(accountId: subject.accountId)
        case .system: nil
        }
    }

    /// Items of the chat, or nil until its whole history is on this device.
    func contactProfileSharedItems(for conversation: ConversationSummary) -> ContactProfileSharedItems? {
        guard messagesByConversation[conversation.id] != nil, !hasEarlierMessages(for: conversation) else { return nil }
        return ContactProfileSharedItemsMemo.items(for: conversation.id, messages: messages(for: conversation))
    }

    /// Loads the chat, then its earlier pages, at most `pageLimit` of them.
    func loadContactProfileHistory(for conversation: ConversationSummary, pageLimit: Int = 20) async {
        if messagesByConversation[conversation.id] == nil {
            guard await loadConversation(conversation) else { return }
        }
        var pages = 0
        while hasEarlierMessages(for: conversation), pages < pageLimit, !Task.isCancelled {
            let before = messagesByConversation[conversation.id]?.count ?? 0
            await loadEarlierMessages(for: conversation)
            pages += 1
            if (messagesByConversation[conversation.id]?.count ?? 0) == before { break }
        }
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

/// Collecting links runs a data detector over every message, so the last
/// result is kept while the chat's messages stay the same.
@MainActor
enum ContactProfileSharedItemsMemo {
    private static var last: (id: String, messages: [ChatMessage], items: ContactProfileSharedItems)?

    static func items(for conversationID: String, messages: [ChatMessage]) -> ContactProfileSharedItems {
        if let last, last.id == conversationID, last.messages == messages { return last.items }
        let items = ContactProfileSharedItems(messages: messages)
        last = (conversationID, messages, items)
        return items
    }
}
