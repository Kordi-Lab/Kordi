import Foundation

/// One-to-one pairing codes: the short code the server issues ("K4M7-2QXA"),
/// typed, scanned from a QR code or opened from a link.
enum CommonGroundPairCodeText {
    static let length = 8
    /// The link a pairing QR code holds.
    static let linkPrefix = "kordi://common-ground/pair/"

    /// Upper case without separators; O, I and L read as the digits they
    /// look like, as the server does. Nil unless it is eight characters.
    static func normalized(_ text: String) -> String? {
        let clean = String(text.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.uppercased().map { character -> Character in
            switch character {
            case "O": "0"
            case "I", "L": "1"
            default: character
            }
        })
        return clean.count == length ? clean : nil
    }

    /// `ABCD-EFGH`.
    static func display(_ text: String) -> String? {
        guard let clean = normalized(text) else { return nil }
        return "\(clean.prefix(4))-\(clean.suffix(4))"
    }

    static func link(_ code: String) -> String { linkPrefix + (display(code) ?? code) }

    static func same(_ first: String?, _ second: String?) -> Bool {
        guard let first = first.flatMap(normalized), let second = second.flatMap(normalized) else { return false }
        return first == second
    }

    /// A scanned or typed value: the pairing link or the bare short code.
    static func parse(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed), let link = CommonGroundPairLink.parse(url) { return link.code }
        return display(trimmed)
    }
}

/// `kordi://common-ground/pair/<code>`: opens Grounding and pairs.
struct CommonGroundPairLink: Equatable {
    /// Display form.
    let code: String

    static func parse(_ url: URL) -> CommonGroundPairLink? {
        // The Beta app registers `kordi-beta`.
        guard ["kordi", "kordi-beta"].contains(url.scheme?.lowercased() ?? ""),
              url.host?.lowercased() == "common-ground",
              url.user == nil, url.password == nil
        else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count == 2, parts[0].lowercased() == "pair",
              let code = CommonGroundPairCodeText.display(parts[1]) else { return nil }
        return CommonGroundPairLink(code: code)
    }
}

/// A pairing link waiting for Grounding to open; set by the app's link
/// handling and taken by Home.
@MainActor
final class CommonGroundPairLinkInbox: ObservableObject {
    static let shared = CommonGroundPairLinkInbox()
    @Published var code: String?

    func take() -> String? {
        defer { code = nil }
        return code
    }
}

/// Where proximity is measured: the distance between two phones that both
/// support precise ranging, else MultipeerConnectivity discovery alone.
enum CommonGroundProximity: Equatable {
    case distance
    case discovery

    /// Pairs only closer than this when ranging, in metres.
    static let pairDistance: Float = 0.3

    static func mode(localSupportsRanging: Bool, peerSupportsRanging: Bool) -> CommonGroundProximity {
        localSupportsRanging && peerSupportsRanging ? .distance : .discovery
    }

    static func isNear(_ distance: Float?) -> Bool {
        guard let distance else { return false }
        return distance < pairDistance
    }
}

/// What two phones send each other over the encrypted session.
struct CommonGroundPairMessage: Codable, Equatable {
    enum Kind: String, Codable {
        /// First message: whether this phone can range, and its account.
        case hello
        /// A NearbyInteraction discovery token.
        case token
        /// The sender's pairing code, sent once the phones are close.
        case code
        /// The sender redeemed the receiver's code.
        case paired
    }

    var kind: Kind
    var ranging: Bool?
    var account: String?
    var token: Data?
    var code: String?

    static func hello(ranging: Bool, account: String) -> Self { .init(kind: .hello, ranging: ranging, account: account) }
    static func token(_ data: Data) -> Self { .init(kind: .token, token: data) }
    static func code(_ code: String) -> Self { .init(kind: .code, code: code) }
    static let paired = Self(kind: .paired)
}

/// The answer to one redemption.
enum CommonGroundRedeemOutcome {
    case paired(CommonGroundPersonCard)
    /// Expired, used or replaced; the other phone sends its next code.
    case codeGone
    case failed(String)
}

enum CommonGroundPairCopy {
    static let expired = "That code expired. Ask for a new one."
    static let yourself = "That's your own code."
    static let cameraOff = "Camera access is off"
}
