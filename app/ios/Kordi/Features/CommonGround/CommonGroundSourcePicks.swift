import Foundation

// Card sources (`commonGroundVersion` 3): each profile keeps the sources its
// card is built from, so every device opens the Build screen with the same
// picks, and a build can read the owner's own Kordi documents.

private extension KeyedDecodingContainer {
    func cgSourceValue<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }
}

/// `{memory, connectors, device, agents, documents, links, notes}` on a
/// profile, owner only. iOS cannot read agent files, so it sends `agents`
/// back as it found it.
struct CommonGroundSourcePicks: Codable, Hashable {
    /// Documents a card may read.
    static let maxDocuments = 8

    var memory = false
    /// Connector providers, such as `gmail`.
    var connectors: [String] = []
    /// `calendar` and `reminders`.
    var device: [String] = []
    var agents = false
    /// Attachment ids of the account's own documents.
    var documents: [String] = []
    var links = ""
    var notes = ""

    init(memory: Bool = false, connectors: [String] = [], device: [String] = [], agents: Bool = false,
         documents: [String] = [], links: String = "", notes: String = "") {
        self.memory = memory
        self.connectors = connectors
        self.device = device
        self.agents = agents
        self.documents = documents
        self.links = links
        self.notes = notes
    }

    private enum CodingKeys: String, CodingKey { case memory, connectors, device, agents, documents, links, notes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        memory = c.cgSourceValue(.memory, false)
        connectors = c.cgSourceValue(.connectors, [])
        device = c.cgSourceValue(.device, [])
        agents = c.cgSourceValue(.agents, false)
        documents = c.cgSourceValue(.documents, [])
        links = c.cgSourceValue(.links, "")
        notes = c.cgSourceValue(.notes, "")
    }
}

/// One entry of `GET documents`: a document the account owns.
struct CommonGroundDocument: Decodable, Hashable, Identifiable {
    let attachmentId: String
    let title: String
    var updatedAt: String?
    var sizeBytes: Int?

    var id: String { attachmentId }

    init(attachmentId: String, title: String, updatedAt: String? = nil, sizeBytes: Int? = nil) {
        self.attachmentId = attachmentId
        self.title = title
        self.updatedAt = updatedAt
        self.sizeBytes = sizeBytes
    }

    private enum CodingKeys: String, CodingKey { case attachmentId, title, updatedAt, sizeBytes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        attachmentId = try c.decode(String.self, forKey: .attachmentId)
        title = c.cgSourceValue(.title, "")
        updatedAt = c.cgSourceValue(.updatedAt, nil as String?)
        sizeBytes = c.cgSourceValue(.sizeBytes, nil as Int?)
    }

    var displayTitle: String { title.isEmpty ? "Untitled" : title }

    /// "Oct 18", with the year when it is not this year.
    func shortDate(now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let date = commonGroundParseDate(updatedAt) else { return nil }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        let style = Date.FormatStyle.dateTime.month(.abbreviated).day()
        return date.formatted(sameYear ? style : style.year())
    }
}

struct CommonGroundDocumentList: Decodable {
    let documents: [CommonGroundDocument]

    private enum CodingKeys: String, CodingKey { case documents }

    init(from decoder: Decoder) throws {
        documents = try decoder.container(keyedBy: CodingKeys.self).cgSourceValue(.documents, [])
    }
}

/// `POST card/build`. The version 3 fields are left out when nil.
struct CommonGroundBuildRequest: Encodable, Hashable {
    var memory: Bool
    var connectors: Bool
    var device: [CommonGroundDeviceItems]
    var links: String
    var notes: String
    /// The profile to build; omitted before profiles.
    var profileId: String? = nil
    /// The connectors to read when `connectors` is on.
    var connectorProviders: [String]? = nil
    /// Attachment ids of the account's own documents.
    var documents: [String]? = nil
    /// The picks the server saves on the profile with the build.
    var picks: CommonGroundSourcePicks? = nil
}
