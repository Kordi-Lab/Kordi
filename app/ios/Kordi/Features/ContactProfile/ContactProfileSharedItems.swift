import Foundation

/// The pages a "Shared with you" row pushes inside the profile.
enum ContactProfileSharedPage: String, Hashable, Identifiable {
    case photos, files, links

    var id: Self { self }

    var title: String {
        switch self {
        case .photos: "Photos"
        case .files: "Files"
        case .links: "Links"
        }
    }

    var emptyTitle: String {
        switch self {
        case .photos: "No photos"
        case .files: "No files"
        case .links: "No links"
        }
    }
}

/// A photo, video or file sent in the chat, with the message that carries it.
struct ContactProfileSharedAttachment: Identifiable, Hashable {
    let message: ChatMessage
    let attachment: ChatAttachment

    var id: String { "\(message.id):\(attachment.id)" }
    var date: Date { message.createdAt }
    var isVideo: Bool { attachment.isMP4Video }
}

/// A distinct http(s) link found in message text.
struct ContactProfileSharedLink: Identifiable, Hashable {
    let url: URL
    /// The label of a Markdown link, when the message has one.
    let title: String?
    let messageId: String
    let date: Date

    var id: String { ContactProfileSharedItems.linkKey(url) }

    var domain: String {
        let host = url.host?.lowercased() ?? url.absoluteString
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// The URL without its scheme, shown when there is no title.
    var displayURL: String {
        var text = url.absoluteString
        for prefix in ["https://", "http://"] where text.lowercased().hasPrefix(prefix) {
            text.removeFirst(prefix.count)
        }
        return text.hasSuffix("/") ? String(text.dropLast()) : text
    }
}

/// Photos, files and links of one chat, newest first. Row counts and pages
/// both come from this value, so they always agree.
struct ContactProfileSharedItems: Equatable {
    struct Counts: Equatable {
        var photos = 0
        var files = 0
        var links = 0
    }

    var photos: [ContactProfileSharedAttachment] = []
    var files: [ContactProfileSharedAttachment] = []
    var links: [ContactProfileSharedLink] = []

    init() {}

    init(messages: [ChatMessage]) {
        var seenLinks = Set<String>()
        for message in messages.sorted(by: { $0.createdAt > $1.createdAt }) {
            guard !message.isSystemNotice, !message.isLocalFailedSend else { continue }
            for attachment in message.attachments where Self.isShared(attachment) {
                let item = ContactProfileSharedAttachment(message: message, attachment: attachment)
                if Self.isPhoto(attachment) { photos.append(item) } else { files.append(item) }
            }
            for (url, title) in Self.links(in: message.text) {
                let key = Self.linkKey(url)
                guard seenLinks.insert(key).inserted else { continue }
                links.append(ContactProfileSharedLink(url: url, title: title, messageId: message.id, date: message.createdAt))
            }
        }
    }

    var counts: Counts { Counts(photos: photos.count, files: files.count, links: links.count) }

    func count(_ page: ContactProfileSharedPage) -> Int {
        switch page {
        case .photos: photos.count
        case .files: files.count
        case .links: links.count
        }
    }

    /// Uploads still in flight and stickers are not shared items.
    static func isShared(_ attachment: ChatAttachment) -> Bool {
        !attachment.attachmentId.hasPrefix("pending:") && attachment.subtype != .sticker
    }

    /// Images and videos go to Photos; everything else to Files.
    static func isPhoto(_ attachment: ChatAttachment) -> Bool {
        attachment.kind == .image || attachment.isMP4Video
    }

    /// http(s) links in reading order, each with its Markdown label when present.
    static func links(in text: String) -> [(URL, String?)] {
        guard !text.isEmpty, text.contains("http") else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        var labels: [String: String] = [:]
        if let markdown = try? NSRegularExpression(pattern: #"\[([^\]\n]+)\]\((https?://[^)\s]+)\)"#) {
            for match in markdown.matches(in: text, range: range) {
                guard let label = Range(match.range(at: 1), in: text).map({ String(text[$0]) }),
                      let target = Range(match.range(at: 2), in: text).flatMap({ URL(string: String(text[$0])) }) else { continue }
                labels[linkKey(target)] = label.trimmingCharacters(in: .whitespaces).nonEmpty
            }
        }
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        var seen = Set<String>()
        return detector.matches(in: text, range: range).compactMap { match in
            guard let url = match.url,
                  let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
                  url.host?.isEmpty == false else { return nil }
            let key = linkKey(url)
            guard seen.insert(key).inserted else { return nil }
            return (url, labels[key])
        }
    }

    /// Scheme, letter case of the host and a trailing slash do not make a link distinct.
    static func linkKey(_ url: URL) -> String {
        var key = url.absoluteString
        if let scheme = url.scheme, let schemeRange = key.range(of: "\(scheme)://") {
            key.removeSubrange(key.startIndex..<schemeRange.upperBound)
        }
        if let host = url.host, let hostRange = key.range(of: host) {
            key.replaceSubrange(hostRange, with: host.lowercased())
        }
        if key.hasPrefix("www.") { key.removeFirst(4) }
        while key.hasSuffix("/") { key.removeLast() }
        return key
    }
}

/// Items of one month: "October", or "October 2025" outside the current year.
struct ContactProfileMonthSection<Item: Identifiable>: Identifiable {
    let id: String
    let title: String
    let items: [Item]
}

enum ContactProfileMonthGrouping {
    /// Groups items that are already sorted newest first, keeping their order.
    static func sections<Item: Identifiable>(
        _ items: [Item],
        date: (Item) -> Date,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> [ContactProfileMonthSection<Item>] {
        var sections: [ContactProfileMonthSection<Item>] = []
        var currentKey: String?
        var currentTitle = ""
        var bucket: [Item] = []
        for item in items {
            let parts = calendar.dateComponents([.year, .month], from: date(item))
            let key = "\(parts.year ?? 0)-\(parts.month ?? 0)"
            if key != currentKey {
                if let currentKey, !bucket.isEmpty {
                    sections.append(ContactProfileMonthSection(id: currentKey, title: currentTitle, items: bucket))
                }
                currentKey = key
                currentTitle = title(for: date(item), now: now, calendar: calendar, locale: locale)
                bucket = []
            }
            bucket.append(item)
        }
        if let currentKey, !bucket.isEmpty {
            sections.append(ContactProfileMonthSection(id: currentKey, title: currentTitle, items: bucket))
        }
        return sections
    }

    static func title(for date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        formatter.setLocalizedDateFormatFromTemplate(sameYear ? "LLLL" : "LLLLyyyy")
        return formatter.string(from: date)
    }

    /// "14 Oct" in a row; the month label carries the year.
    static func dayLabel(_ date: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        date.formatted(
            Date.FormatStyle(date: .omitted, time: .omitted, locale: locale, calendar: calendar, timeZone: calendar.timeZone)
                .day().month(.abbreviated)
        )
    }
}
