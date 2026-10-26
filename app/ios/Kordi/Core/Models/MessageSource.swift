import Foundation

/// A connector event an agent message is based on (#2091), shown as a chip
/// under the agent's bubble.
struct MessageSource: Codable, Hashable, Identifiable, Sendable {
    let eventId: String
    let provider: String
    /// A short label from the event, such as a sender, subject, or event title.
    let title: String

    var id: String { eventId }

    init(eventId: String, provider: String, title: String) {
        self.eventId = eventId
        self.provider = provider
        self.title = title
    }

    enum CodingKeys: String, CodingKey {
        case eventId, provider, title
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let eventId = try container.decode(String.self, forKey: .eventId).nonEmpty,
              let provider = try container.decode(String.self, forKey: .provider).nonEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .eventId,
                in: container,
                debugDescription: "A message source needs an event and a provider"
            )
        }
        self.eventId = eventId
        self.provider = provider
        title = (try? container.decodeIfPresent(String.self, forKey: .title))?.nonEmpty ?? ""
    }
}

/// Decodes a `sources` array and drops the entries it cannot read, so one bad
/// source never hides the message it belongs to.
struct MessageSourceList: Codable, Hashable, Sendable {
    let values: [MessageSource]

    init(_ values: [MessageSource]) {
        var seen = Set<String>()
        self.values = values.filter { seen.insert($0.eventId).inserted }
    }

    init(from decoder: Decoder) throws {
        guard var container = try? decoder.unkeyedContainer() else {
            self.init([])
            return
        }
        var values: [MessageSource] = []
        while !container.isAtEnd {
            if let source = try? container.decode(MessageSource.self) {
                values.append(source)
            } else if (try? container.decode(SkippedValue.self)) == nil {
                break
            }
        }
        self.init(values)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(values)
    }

    private struct SkippedValue: Decodable {
        init(from decoder: Decoder) throws {}
    }
}

enum MessageSourcePresentation {
    /// The chip's provider label: Gmail, Calendar, GitHub, Slack, or the
    /// provider id with its first letter capitalized.
    static func providerName(_ provider: String) -> String {
        let normalized = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch normalized {
        case "gmail": return "Gmail"
        case "calendar", "google_calendar", "mac_calendar": return "Calendar"
        case "github": return "GitHub"
        case "slack": return "Slack"
        default:
            let words = normalized
                .replacingOccurrences(of: "_", with: " ")
                .replacingOccurrences(of: "-", with: " ")
                .split(whereSeparator: \.isWhitespace)
                .joined(separator: " ")
            guard let first = words.first else { return "Source" }
            return first.uppercased() + words.dropFirst()
        }
    }

    static func systemImage(_ provider: String) -> String {
        switch providerName(provider) {
        case "Gmail": "envelope"
        case "Calendar": "calendar"
        case "GitHub": "arrow.triangle.pull"
        case "Slack": "number"
        default: "link"
        }
    }

    static func accessibilityLabel(_ source: MessageSource) -> String {
        [providerName(source.provider), source.title.nonEmpty]
            .compactMap { $0 }
            .joined(separator: ", ")
    }
}
