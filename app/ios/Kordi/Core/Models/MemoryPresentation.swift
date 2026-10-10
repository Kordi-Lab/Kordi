import Foundation

/// Pure presentation rules for the Memory settings screen and each conversation's
/// Memory tab. The copy matches the desktop (`app/desktop/src/features/memory/`).
enum MemoryPresentation {
    static let maxCharacters = 500

    /// The scope ids whose memories belong to one conversation, per scope.
    struct ConversationScopes: Equatable {
        var conversation: Set<String> = []
        var group: Set<String> = []
        var project: Set<String> = []
    }

    enum Validation: Equatable {
        case valid(String)
        case invalid(String)
    }

    /// The Memory screen is shown only when the server reports `memoryVersion`.
    static func isAvailable(_ capabilities: CloudAuthCapabilities?) -> Bool {
        (capabilities?.memoryVersion ?? 0) >= 1
    }

    static func sourceLabel(_ source: CloudMemorySource) -> String {
        switch source {
        case .userCorrection: "From a correction"
        case .repeatedFailure: "From a repeated failure"
        case .outcome: "From an outcome"
        case .manual: "Added by hand"
        case .other: "Saved memory"
        }
    }

    /// Global memories for the Settings screen, newest first. The others are
    /// shown on each conversation's Memory tab.
    static func globalMemories(_ memories: [CloudMemory]) -> [CloudMemory] {
        memories.filter { $0.scope == .global }.sorted(by: isNewer)
    }

    static let groupSessionPrefix = "session:group:"

    /// The scope ids memories of this conversation are saved under. Agents save
    /// conversation memories under the cloud session id (the desktop canonical
    /// session id) or the agent subsession id, and group memories under the group
    /// id: the group session id without `session:group:`. The group space id and
    /// the full session id match too. iPhone conversations carry no project.
    static func conversationScopes(for conversation: ConversationSummary) -> ConversationScopes {
        var scopes = ConversationScopes()
        let session = conversation.sessionId.nonEmptyMemoryText
        for id in [session, conversation.subsessionId?.nonEmptyMemoryText].compactMap({ $0 }) {
            scopes.conversation.insert(id)
        }
        if let session, session.hasPrefix(groupSessionPrefix) {
            scopes.group.insert(session)
            if let stripped = String(session.dropFirst(groupSessionPrefix.count)).nonEmptyMemoryText {
                scopes.group.insert(stripped)
            }
        }
        if conversation.kind == .group, let space = conversation.groupSpaceId?.nonEmptyMemoryText {
            scopes.group.insert(space)
        }
        return scopes
    }

    /// The memories of one conversation, its group, or its project, newest first.
    /// Global memories never appear here.
    static func memories(_ memories: [CloudMemory], for scopes: ConversationScopes) -> [CloudMemory] {
        memories.filter { memory in
            switch memory.scope {
            case .conversation: scopes.conversation.contains(memory.scopeId)
            case .group: scopes.group.contains(memory.scopeId)
            case .project: scopes.project.contains(memory.scopeId)
            case .global, .other: false
            }
        }
        .sorted(by: isNewer)
    }

    private static func isNewer(_ lhs: CloudMemory, _ rhs: CloudMemory) -> Bool {
        let left = date(lhs.updatedAt) ?? .distantPast
        let right = date(rhs.updatedAt) ?? .distantPast
        return left == right ? lhs.memoryId < rhs.memoryId : left > right
    }

    private static let fractionalDateParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainDateParser = ISO8601DateFormatter()

    static func date(_ value: String) -> Date? {
        fractionalDateParser.date(from: value) ?? plainDateParser.date(from: value)
    }

    /// "Today", "Yesterday", or a medium date.
    static func dateLabel(_ value: String, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        guard let date = date(value) else { return "" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 0 { return "Today" }
        if days == 1 { return "Yesterday" }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    /// "From a correction · Today". Settings list only global memories and each
    /// conversation lists its own, so the scope label is left out.
    static func detail(_ memory: CloudMemory, now: Date = Date(), calendar: Calendar = .current) -> String {
        [sourceLabel(memory.source), dateLabel(memory.updatedAt, now: now, calendar: calendar).nonEmptyMemoryText]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// Collapses whitespace runs to single spaces and trims the ends.
    static func normalize(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
            .joined(separator: " ")
    }

    /// Counted the way the server counts: Unicode scalars.
    static func characterCount(_ text: String) -> Int {
        text.unicodeScalars.count
    }

    static func validate(_ text: String) -> Validation {
        let normalized = normalize(text)
        if normalized.isEmpty { return .invalid("Enter a memory.") }
        if characterCount(normalized) > maxCharacters {
            return .invalid("Memories are \(maxCharacters) characters or fewer.")
        }
        return .valid(normalized)
    }

    static func counter(_ draft: String) -> String {
        "\(characterCount(draft)) / \(maxCharacters)"
    }

    static func isOverLimit(_ draft: String) -> Bool {
        characterCount(draft) > maxCharacters
    }

    static func forgetConsequences(count: Int) -> String {
        let memories = count == 1 ? "1 memory" : "\(count) memories"
        return "This deletes \(memories) from your account and every signed-in device. It cannot be undone."
    }

    static func globalMemoriesTitle(count: Int) -> String {
        "Global memories · \(count)"
    }

    /// Prefers the account email, then the Kordi ID.
    static func accountLabel(email: String?, kordiId: String?) -> String? {
        email?.nonEmptyMemoryText ?? kordiId?.nonEmptyMemoryText
    }

    /// "Synced with taylor@memory.example · 2 minutes ago"
    static func syncCaption(accountLabel: String, lastSyncedAt: Date?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let lastSyncedAt else { return "Not synced yet with \(accountLabel)" }
        let elapsed = now.timeIntervalSince(lastSyncedAt)
        let when: String
        if elapsed < 60 {
            when = "just now"
        } else if elapsed < 3_600 {
            let minutes = Int(elapsed / 60)
            when = minutes == 1 ? "1 minute ago" : "\(minutes) minutes ago"
        } else {
            when = dateLabel(plainDateParser.string(from: lastSyncedAt), now: now, calendar: calendar)
        }
        return "Synced with \(accountLabel) · \(when)"
    }
}

private extension String {
    var nonEmptyMemoryText: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
