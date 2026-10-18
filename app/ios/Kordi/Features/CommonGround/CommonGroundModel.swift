import SwiftUI

/// Decides whether the Common ground entry exists in Contacts. The server
/// side does not exist yet, so only debug builds show it: with the
/// `--preview-common-ground` launch argument, or with the
/// `kordi.debug.common-ground` defaults flag. Release builds never do.
enum CommonGroundAvailability {
    static let previewArgument = "--preview-common-ground"
    static let defaultsKey = "kordi.debug.common-ground"

    static func isPreviewRequested(arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
#if DEBUG
        arguments.contains(previewArgument)
#else
        false
#endif
    }

    static func isEnabled(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        defaults: UserDefaults = .standard
    ) -> Bool {
#if DEBUG
        isPreviewRequested(arguments: arguments) || defaults.bool(forKey: defaultsKey)
#else
        false
#endif
    }

    /// Whether a room invitation is waiting. There is no invitation feed yet;
    /// the preview argument shows the waiting state.
    static func hasWaitingInvitation(arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
        isPreviewRequested(arguments: arguments)
    }
}

#if DEBUG
/// Network-backed state for the Common ground preview. Talks to the local demo
/// server described in experiments/common-ground-lab/demo/API.md.

// MARK: - Wire types

struct CommonGroundCard: Codable, Hashable {
    var workingOn: [String]
    var interests: [String]
    var canHelp: [String]
    var lookingFor: [String]
    var hidden: [String]
    /// Absent in older server responses.
    var profile: CommonGroundProfile?
}

/// Where each topic came from and when it was active. Keys arrive in
/// snake_case and are converted by the decoder's key strategy.
struct CommonGroundProfile: Codable, Hashable {
    struct Period: Codable, Hashable {
        let period: String
        let topics: [String]
    }

    struct TopicInfo: Codable, Hashable {
        let refs: [String]
        let firstSeen: String?
        let lastSeen: String?
        let score: Double?
    }

    struct Evidence: Codable, Hashable {
        let source: String
        let title: String
        let date: String?
        let url: String?
        let snippet: String
    }

    var latest: [String]
    var earlier: [String]
    var timeline: [Period]
    var topics: [String: TopicInfo]
    var evidence: [String: Evidence]

    /// The decoder's snake_case strategy also rewrites dictionary keys, so a
    /// label with underscores is looked up under its converted form too.
    func info(for label: String) -> TopicInfo? {
        topics[label] ?? topics[Self.convertedKey(label)]
    }

    func evidence(for label: String) -> [(id: String, item: Evidence)] {
        (info(for: label)?.refs ?? []).compactMap { id in
            (evidence[id] ?? evidence[Self.convertedKey(id)]).map { (id, $0) }
        }
    }

    /// Mirrors JSONDecoder.KeyDecodingStrategy.convertFromSnakeCase.
    private static func convertedKey(_ key: String) -> String {
        guard key.contains("_"),
              let first = key.firstIndex(where: { $0 != "_" }),
              let last = key.lastIndex(where: { $0 != "_" }) else { return key }
        let parts = key[first...last].split(separator: "_")
        guard parts.count > 1 else { return key }
        let joined = ([parts[0].lowercased()] + parts.dropFirst().map(\.capitalized)).joined()
        return String(key[..<first]) + joined + String(key[key.index(after: last)...])
    }
}

struct CommonGroundPerson: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let lab: String
}

struct CommonGroundRanked: Codable, Identifiable, Hashable {
    let person: CommonGroundPerson
    let score: Int
    let headline: String
    var id: String { person.id }
}

struct CommonGroundTopic: Codable, Identifiable, Hashable {
    let label: String
    let people: [CommonGroundPerson]
    var id: String { label }
}

struct CommonGroundReason: Codable, Hashable {
    let topic: String
    let theirTopic: String
    let why: String
}

struct CommonGroundMatch: Codable, Hashable {
    let person: CommonGroundPerson
    let score: Int
    let shared: [CommonGroundReason]
    let youBring: [CommonGroundTrade]
    let theyBring: [CommonGroundTrade]
    let nextStep: String
}

/// A skill one person offers and the other person's topic it helps.
struct CommonGroundTrade: Codable, Hashable {
    let topic: String
    let target: String

    enum CodingKeys: String, CodingKey {
        case topic
        case target = "for"
    }
}

struct CommonGroundResults: Codable, Hashable {
    let people: [CommonGroundRanked]
    let topics: [CommonGroundTopic]
    let suggestion: CommonGroundTopic?
}

struct CommonGroundSource: Codable, Hashable {
    let label: String
    let chars: Int
}

private struct CommonGroundMeResponse: Decodable {
    let name: String
    let card: CommonGroundCard?
    /// Connected GitHub login, "" when none. Absent on older servers.
    let github: String?
}

/// GitHub device sign-in state: "idle", "pending", "done", "denied", or "expired".
struct CommonGroundGitHubConnection: Decodable, Hashable {
    let status: String
    let userCode: String?
    let verificationUri: String?
    let login: String
}

private struct CommonGroundSourcesResponse: Decodable { let agents: [CommonGroundSource] }
private struct CommonGroundCardResponse: Decodable { let card: CommonGroundCard }
private struct CommonGroundSkipped: Decodable { let source: String; let reason: String }
private struct CommonGroundBuildResponse: Decodable { let card: CommonGroundCard; let skipped: [CommonGroundSkipped]? }
private struct CommonGroundRoomResponse: Decodable { let code: String; let members: [CommonGroundPerson] }
private struct CommonGroundTapResponse: Decodable { let person: CommonGroundPerson }
private struct CommonGroundRecentResponse: Decodable { let people: [CommonGroundRanked] }
struct CommonGroundDeviceItem: Encodable, Hashable { let title: String; let date: String? }
struct CommonGroundDeviceItems: Encodable { let source: String; let items: [CommonGroundDeviceItem] }
private struct CommonGroundBuildRequest: Encodable { let useAgents: Bool; let links: String; let notes: String; let device: [CommonGroundDeviceItems] }
private struct CommonGroundHiddenRequest: Encodable { let hidden: [String] }
private struct CommonGroundTopicsRequest: Encodable { let workingOn: [String]; let interests: [String]; let canHelp: [String]; let lookingFor: [String] }
private struct CommonGroundServerError: Decodable { let error: String }

struct CommonGroundAPIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// MARK: - Client

private struct CommonGroundAPI {
    let baseURL: URL

    init() {
        let raw = ProcessInfo.processInfo.environment["KORDI_COMMON_GROUND_URL"] ?? ""
        baseURL = URL(string: raw.isEmpty ? "http://127.0.0.1:18190" : raw) ?? URL(string: "http://127.0.0.1:18190")!
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await send("GET", path, body: nil)
    }

    func send<T: Decodable>(_ method: String, _ path: String, body: (any Encodable)? = nil) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        // Card builds and room results can take up to a minute the first time.
        request.timeoutInterval = 120
        if let body {
            let encoder = JSONEncoder()
            encoder.keyEncodingStrategy = .convertToSnakeCase
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw CommonGroundAPIError(message: "Demo server not reachable")
        }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let message = (try? decoder.decode(CommonGroundServerError.self, from: data))?.error
            throw CommonGroundAPIError(message: message ?? "Request failed (\(http.statusCode))")
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw CommonGroundAPIError(message: "Unexpected server response")
        }
    }
}

// MARK: - Model

@MainActor
final class CommonGroundModel: ObservableObject {
    static let meID = "me"
    /// The server calls the tester "You"; avatars need a real name for initials.
    private static let fallbackName = "Alex"

    private let api = CommonGroundAPI()

    @Published private(set) var me = CommonGroundPerson(id: meID, name: fallbackName, lab: "")
    @Published private(set) var card: CommonGroundCard?
    /// Connected GitHub account, "" when none.
    @Published private(set) var githubLogin = ""
    @Published private(set) var loadedMe = false
    @Published private(set) var sources: [CommonGroundSource] = []
    @Published private(set) var recent: [CommonGroundRanked] = []
    @Published private(set) var roomCode = ""
    @Published private(set) var members: [CommonGroundPerson] = []
    @Published private(set) var results: CommonGroundResults?
    @Published private(set) var matches: [String: CommonGroundMatch] = [:]
    /// Short error or status line shown as a toast over every screen.
    @Published var notice: String?

    var hasCard: Bool { card != nil }

    func shown(_ topics: [String]) -> [String] {
        let hidden = Set(card?.hidden ?? [])
        return topics.filter { !hidden.contains($0) }
    }

    var myTopics: [String] {
        guard let card else { return [] }
        return shown(card.workingOn + card.interests)
    }

    func isHidden(_ topic: String) -> Bool { card?.hidden.contains(topic) ?? false }

    /// Replaces the server's "me" entry with the tester's display identity.
    func resolve(_ person: CommonGroundPerson) -> CommonGroundPerson {
        person.id == Self.meID ? me : person
    }

    func report(_ error: Error) {
        guard !(error is CancellationError) else { return }
        notice = (error as? LocalizedError)?.errorDescription ?? "Something went wrong"
    }

    // MARK: Home

    func loadHome() async {
        do {
            let response: CommonGroundMeResponse = try await api.get("v1/me")
            let name = response.name.trimmingCharacters(in: .whitespaces)
            me = CommonGroundPerson(
                id: Self.meID,
                name: name.isEmpty || name == "You" ? Self.fallbackName : name,
                lab: ""
            )
            card = response.card
            githubLogin = response.github ?? ""
            loadedMe = true
        } catch {
            report(error)
            return
        }
        guard card != nil else { return }
        do {
            let response: CommonGroundRecentResponse = try await api.get("v1/recent")
            recent = response.people
        } catch {
            report(error)
        }
    }

    // MARK: Card

    func loadSources() async {
        do {
            let response: CommonGroundSourcesResponse = try await api.get("v1/me/sources")
            sources = response.agents
        } catch {
            report(error)
        }
    }

    /// Starts GitHub's device sign-in; the response carries the code to show.
    func connectGitHub() async throws -> CommonGroundGitHubConnection {
        let response: CommonGroundGitHubConnection = try await api.send("POST", "v1/connect/github")
        githubLogin = response.login
        return response
    }

    func githubStatus() async throws -> CommonGroundGitHubConnection {
        let response: CommonGroundGitHubConnection = try await api.get("v1/connect/github")
        githubLogin = response.login
        return response
    }

    func disconnectGitHub() async throws {
        let response: CommonGroundGitHubConnection = try await api.send("DELETE", "v1/connect/github")
        githubLogin = response.login
    }

    /// `links` holds URLs and text separated by ";". Links the server could not
    /// read (sign-in walls, private pages) come back as a notice.
    func buildCard(useAgents: Bool, links: String, notes: String, device: [CommonGroundDeviceItems] = []) async throws {
        let body = CommonGroundBuildRequest(useAgents: useAgents, links: links, notes: notes, device: device)
        let response: CommonGroundBuildResponse = try await api.send("POST", "v1/me/card/build", body: body)
        card = response.card
        if let skipped = response.skipped, !skipped.isEmpty {
            notice = skipped.map(\.reason).joined(separator: " ")
        }
        matches = [:]
        results = nil
    }

    /// Replaces the card's topics after the tester removes or adds tags.
    func updateCard(_ next: CommonGroundCard) {
        guard let previous = card else { return }
        card = next
        let body = CommonGroundTopicsRequest(workingOn: next.workingOn, interests: next.interests, canHelp: next.canHelp, lookingFor: next.lookingFor)
        Task {
            do {
                let response: CommonGroundCardResponse = try await api.send("PUT", "v1/me/card", body: body)
                card = response.card
                matches = [:]
                results = nil
            } catch {
                card = previous
                report(error)
            }
        }
    }

    func toggle(_ topic: String) {
        guard var next = card else { return }
        let previous = next
        if let index = next.hidden.firstIndex(of: topic) {
            next.hidden.remove(at: index)
        } else {
            next.hidden.append(topic)
        }
        card = next
        let hidden = next.hidden
        Task {
            do {
                let response: CommonGroundCardResponse = try await api.send("PUT", "v1/me/card/hidden", body: CommonGroundHiddenRequest(hidden: hidden))
                card = response.card
                matches = [:]
            } catch {
                card = previous
                report(error)
            }
        }
    }

    // MARK: Room

    func join(code: String) async throws {
        let response: CommonGroundRoomResponse = try await api.send("POST", "v1/rooms/\(code)/join")
        roomCode = response.code
        members = response.members.filter { $0.id != Self.meID }
        results = nil
    }

    func refreshRoom() async {
        guard !roomCode.isEmpty else { return }
        do {
            let response: CommonGroundRoomResponse = try await api.get("v1/rooms/\(roomCode)")
            let next = response.members.filter { $0.id != Self.meID }
            if next != members {
                withAnimation(.snappy) { members = next }
            }
        } catch {
            report(error)
        }
    }

    func loadResults() async throws {
        let response: CommonGroundResults = try await api.send("POST", "v1/rooms/\(roomCode)/results")
        results = CommonGroundResults(
            people: response.people,
            topics: response.topics.map(resolve),
            suggestion: response.suggestion.map(resolve)
        )
    }

    private func resolve(_ topic: CommonGroundTopic) -> CommonGroundTopic {
        CommonGroundTopic(label: topic.label, people: topic.people.map(resolve))
    }

    // MARK: Match

    func tap() async throws -> CommonGroundPerson {
        let response: CommonGroundTapResponse = try await api.send("POST", "v1/tap")
        return response.person
    }

    func loadMatch(_ personID: String) async throws {
        let response: CommonGroundMatch = try await api.get("v1/match/\(personID)")
        matches[personID] = response
    }
}

// MARK: - Topic styling

/// Settings-style icon tile for a topic, picked by keyword so any server
/// string gets a stable icon and brand colour.
func commonGroundStyle(for topic: String) -> (symbol: String, color: Color) {
    let text = topic.lowercased()
    func has(_ words: String...) -> Bool { words.contains { text.contains($0) } }
    if has("memory") { return ("brain", KordiTheme.brandPink) }
    if has("eval", "benchmark") { return ("checkmark.seal", KordiTheme.signalBlue) }
    if has("privacy", "security") { return ("lock", Color(uiColor: .systemGray)) }
    if has("education", "learn", "tutor") { return ("graduationcap", KordiTheme.brandCyan) }
    if has("device", "quantiz", "edge", "compression") { return ("iphone", KordiTheme.brandAmber) }
    if has("moderation", "community", "social") { return ("bubble.left.and.bubble.right", KordiTheme.agentViolet) }
    if has("robot") { return ("gearshape.2", KordiTheme.agentViolet) }
    if has("study", "user", "qualitative") { return ("person.2", KordiTheme.brandCyan) }
    let palette = [KordiTheme.brandPink, KordiTheme.brandCyan, KordiTheme.brandAmber, KordiTheme.signalBlue, KordiTheme.agentViolet]
    // djb2: String.hashValue is seeded per launch, this stays stable.
    var hash: UInt64 = 5381
    for byte in text.utf8 { hash = (hash &* 33) &+ UInt64(byte) }
    return ("sparkles", palette[Int(hash % UInt64(palette.count))])
}
#endif
