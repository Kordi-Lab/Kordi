import Foundation

/// Pure presentation rules for the Memory settings screen. The copy matches
/// the desktop Memory tab (`app/desktop/src/features/memory/memoryModel.ts`).
enum MemoryPresentation {
    static let maxCharacters = 500

    struct Group: Identifiable, Equatable {
        let scope: CloudMemoryScope
        let label: String
        let memories: [CloudMemory]

        var id: String { label }
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

    static func groupLabel(_ scope: CloudMemoryScope) -> String {
        switch scope {
        case .conversation: "Conversations"
        case .project: "Projects"
        case .group: "Groups"
        case .other: "Other"
        }
    }

    private static func groupRank(_ scope: CloudMemoryScope) -> Int {
        switch scope {
        case .conversation: 0
        case .project: 1
        case .group: 2
        case .other: 3
        }
    }

    /// Groups memories as Conversations, Projects, Groups, newest first, without empty groups.
    /// Scopes from a newer server follow under Other so no memory is hidden.
    static func groups(_ memories: [CloudMemory]) -> [Group] {
        let buckets = Dictionary(grouping: memories) { groupRank($0.scope) }
        return buckets.keys.sorted().compactMap { rank in
            guard let entries = buckets[rank], let first = entries.first else { return nil }
            return Group(scope: first.scope, label: groupLabel(first.scope), memories: entries.sorted(by: isNewer))
        }
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

    /// "From a correction · Launch copy with Priya · Today"
    static func detail(_ memory: CloudMemory, now: Date = Date(), calendar: Calendar = .current) -> String {
        [sourceLabel(memory.source), memory.scopeLabel?.nonEmptyMemoryText, dateLabel(memory.updatedAt, now: now, calendar: calendar).nonEmptyMemoryText]
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

    static func savedMemoriesTitle(count: Int) -> String {
        "Saved memories · \(count)"
    }

    static func replayRunsLabel(_ count: Int) -> String {
        if count <= 0 { return "Nothing stored" }
        return count == 1 ? "1 run" : "\(count) runs"
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
