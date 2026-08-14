import Foundation
import SwiftUI
import UIKit

struct IdentityAvatar: View {
    let name: String
    let imageSource: String?
    let kind: ConversationKind
    var size: CGFloat = 52
    var seed: String? = nil

    private var normalizedImageSource: String? {
        AvatarImageLoader.normalizedSource(imageSource)
    }

    private var isKordiSupport: Bool {
        KordiSupportIdentity.matches(name: name, seed: seed)
    }

    var body: some View {
        ZStack {
            if normalizedImageSource == nil {
                fallback
            } else {
                imageLoadingPlaceholder
            }

            if let normalizedImageSource {
                AvatarSourceImage(source: normalizedImageSource)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay {
            Circle().stroke(Color(uiColor: .separator).opacity(0.22), lineWidth: 0.5)
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var fallback: some View {
        if isKordiSupport {
            KordiSupportAvatar()
        } else {
            switch kind {
            case .agent:
                AgentIdenticonAvatar(seed: seed?.nonEmpty ?? name)
            case .group:
                Circle().fill(KordiTheme.signalBlue.opacity(0.12))
                Image(systemName: "person.2.fill")
                    .font(.system(size: size * 0.34, weight: .semibold))
                    .foregroundStyle(KordiTheme.signalBlue)
            case .person:
                initials
            }
        }
    }

    @ViewBuilder
    private var imageLoadingPlaceholder: some View {
        if isKordiSupport {
            KordiSupportAvatar()
        } else if kind == .agent {
            AgentIdenticonAvatar(seed: seed?.nonEmpty ?? name)
        } else {
            Circle().fill(Color(uiColor: .secondarySystemFill))
            Image(systemName: kind == .group ? "person.2.fill" : "person.crop.circle.fill")
                .font(.system(size: size * 0.42, weight: .regular))
                .foregroundStyle(.secondary)
        }
    }

    private var initials: some View {
        let palette = CloudAvatarFallback.palette(for: name)
        return ZStack {
            Circle().fill(palette.background)
            Text(CloudAvatarFallback.initials(for: name))
                .font(.system(size: size * 0.36, weight: .semibold, design: .rounded))
                .foregroundStyle(palette.foreground)
        }
    }
}

enum KordiSupportIdentity {
    static let accountId = "acct_kordi_support"
    static let agentId = "cloud_agent_kordi_support"
    static let displayName = "Kordi Support"
    private static let systemAgentSessionPrefix = "session:direct-system-agent:"

    static func matches(name: String?, seed: String?) -> Bool {
        let normalizedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedSeed = seed?.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalizedName?.localizedCaseInsensitiveCompare(displayName) == .orderedSame
            || normalizedSeed == accountId
            || normalizedSeed == agentId
    }

    static func isSystemAgentSession(_ sessionId: String?) -> Bool {
        guard let sessionId = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              sessionId.hasPrefix(systemAgentSessionPrefix) else { return false }
        return sessionId.hasSuffix(":\(agentId)")
    }
}

private struct KordiSupportAvatar: View {
    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 256
            context.fill(
                Path(ellipseIn: CGRect(x: 0, y: 0, width: 256 * scale, height: 256 * scale)),
                with: .color(.white)
            )
            for (rect, color) in [
                (CGRect(x: 87, y: 47, width: 90, height: 90), Color(red: 0.957, green: 0.247, blue: 0.616)),
                (CGRect(x: 45, y: 105, width: 92, height: 92), Color(red: 0.141, green: 0.722, blue: 0.835)),
                (CGRect(x: 124, y: 106, width: 90, height: 90), Color(red: 1.000, green: 0.710, blue: 0.145))
            ] {
                let scaled = CGRect(
                    x: rect.origin.x * scale,
                    y: rect.origin.y * scale,
                    width: rect.size.width * scale,
                    height: rect.size.height * scale
                )
                context.fill(Path(ellipseIn: scaled), with: .color(color))
            }
        }
    }
}

struct GroupAvatarStack: View {
    let participants: [CloudGroupParticipant]
    var size: CGFloat = 52

    private var visibleParticipants: [CloudGroupParticipant] {
        Array(participants.sorted { $0.accountId < $1.accountId }.prefix(3))
    }

    var body: some View {
        if visibleParticipants.isEmpty {
            IdentityAvatar(name: "Group", imageSource: nil, kind: .group, size: size)
        } else if visibleParticipants.count == 1, let participant = visibleParticipants.first {
            participantAvatar(participant, diameter: size)
        } else {
            let diameter = size * 0.68
            let overlap = (size - diameter) / CGFloat(max(visibleParticipants.count - 1, 1))

            ZStack(alignment: .leading) {
                ForEach(Array(visibleParticipants.enumerated()), id: \.element.id) { index, participant in
                    participantAvatar(participant, diameter: diameter)
                        .overlay {
                            Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2)
                        }
                        .offset(x: CGFloat(index) * overlap)
                        .zIndex(Double(index))
                }
            }
            .frame(width: size, height: size, alignment: .leading)
            .accessibilityHidden(true)
        }
    }

    private func participantAvatar(_ participant: CloudGroupParticipant, diameter: CGFloat) -> some View {
        IdentityAvatar(
            name: participant.displayName.nonEmpty ?? "Kordi user",
            imageSource: participant.avatarUrl?.nonEmpty,
            kind: .person,
            size: diameter,
            seed: participant.accountId
        )
    }
}

enum CloudAvatarFallback {
    struct Palette {
        let background: Color
        let foreground: Color
    }

    private static let palettes: [Palette] = [
        Palette(background: Color(red: 0.435, green: 0.812, blue: 0.592), foreground: Color(red: 0.122, green: 0.161, blue: 0.216)),
        Palette(background: Color(red: 0.949, green: 0.651, blue: 0.353), foreground: Color(red: 0.122, green: 0.161, blue: 0.216)),
        Palette(background: Color(red: 0.910, green: 0.627, blue: 0.784), foreground: Color(red: 0.122, green: 0.161, blue: 0.216))
    ]

    static func initials(for label: String) -> String {
        let characters = label.filter { $0.isLetter || $0.isNumber }
        let initials = String(characters.prefix(2)).uppercased()
        return initials.isEmpty ? "KO" : initials
    }

    static func paletteIndex(for label: String) -> Int {
        var hash: UInt32 = 2_166_136_261
        for scalar in label.unicodeScalars {
            hash ^= scalar.value
            hash = hash &* 16_777_619
        }
        return Int(hash % UInt32(palettes.count))
    }

    static func palette(for label: String) -> Palette {
        palettes[paletteIndex(for: label)]
    }
}

struct AgentIdenticonCell: Equatable {
    let x: Int
    let y: Int
    let accent: Bool
    let opacity: Double
}

struct AgentIdenticonParts: Equatable {
    let paletteIndex: Int
    let cells: [AgentIdenticonCell]
}

enum AgentIdenticonGenerator {
    static func parts(seed: String) -> AgentIdenticonParts {
        var random = AgentIdenticonRandom(seed: "agent-identicon:\(seed)")
        let paletteIndex = Int(random.next() * 8) % 8
        var cells: [AgentIdenticonCell] = []

        for y in 0..<5 {
            for x in 0..<3 {
                let active = random.next() > 0.42 || (x == 2 && y == 2 && random.next() > 0.22)
                if !active { continue }
                let accent = random.next() > 0.78
                let opacity = 0.82 + random.next() * 0.18
                cells.append(AgentIdenticonCell(x: x, y: y, accent: accent, opacity: opacity))
                let mirrorX = 4 - x
                if mirrorX != x {
                    cells.append(AgentIdenticonCell(x: mirrorX, y: y, accent: accent, opacity: opacity))
                }
            }
        }

        if cells.count < 8 {
            cells += [
                AgentIdenticonCell(x: 1, y: 1, accent: false, opacity: 0.92),
                AgentIdenticonCell(x: 3, y: 1, accent: false, opacity: 0.92),
                AgentIdenticonCell(x: 2, y: 2, accent: true, opacity: 0.96),
                AgentIdenticonCell(x: 1, y: 3, accent: false, opacity: 0.92),
                AgentIdenticonCell(x: 3, y: 3, accent: false, opacity: 0.92)
            ]
        }

        return AgentIdenticonParts(paletteIndex: paletteIndex, cells: cells)
    }
}

private struct AgentIdenticonRandom {
    private var state: UInt32

    init(seed: String) {
        var hash: UInt32 = 2_166_136_261
        for value in seed.utf16 {
            hash ^= UInt32(value)
            hash = hash &* 16_777_619
        }
        state = hash
    }

    mutating func next() -> Double {
        state = state &+ 0x6D2B_79F5
        var value = state
        value = (value ^ (value >> 15)) &* (value | 1)
        value ^= value &+ ((value ^ (value >> 7)) &* (value | 61))
        return Double(value ^ (value >> 14)) / 4_294_967_296
    }
}

private struct AgentIdenticonAvatar: View {
    let seed: String

    private static let palettes: [(background: Color, foreground: Color, accent: Color)] = [
        (Color(hex: 0xF6F8FA), Color(hex: 0x0969DA), Color(hex: 0x2DA44E)),
        (Color(hex: 0xF6F8FA), Color(hex: 0x8250DF), Color(hex: 0xBF3989)),
        (Color(hex: 0xF6F8FA), Color(hex: 0x1A7F37), Color(hex: 0x9A6700)),
        (Color(hex: 0xF6F8FA), Color(hex: 0xBC4C00), Color(hex: 0x0969DA)),
        (Color(hex: 0x0D1117), Color(hex: 0x58A6FF), Color(hex: 0x3FB950)),
        (Color(hex: 0x0D1117), Color(hex: 0xA371F7), Color(hex: 0xF778BA)),
        (Color(hex: 0x0D1117), Color(hex: 0x7EE787), Color(hex: 0xD29922)),
        (Color(hex: 0x0D1117), Color(hex: 0xFFA657), Color(hex: 0x79C0FF))
    ]

    var body: some View {
        let parts = AgentIdenticonGenerator.parts(seed: seed)
        let palette = Self.palettes[parts.paletteIndex]
        Canvas { context, size in
            let scale = min(size.width, size.height) / 64
            let canvas = CGRect(origin: .zero, size: size)
            context.fill(Path(canvas), with: .color(palette.background))
            context.fill(
                Path(canvas),
                with: .color(Color.white.opacity(parts.paletteIndex >= 4 ? 0.04 : 0.22))
            )

            for cell in parts.cells {
                let rect = CGRect(
                    x: CGFloat(8 + cell.x * 10) * scale,
                    y: CGFloat(8 + cell.y * 10) * scale,
                    width: 8 * scale,
                    height: 8 * scale
                )
                context.fill(
                    Path(roundedRect: rect, cornerRadius: 2 * scale),
                    with: .color((cell.accent ? palette.accent : palette.foreground).opacity(cell.opacity))
                )
            }

            let ring = CGRect(x: 0.5 * scale, y: 0.5 * scale, width: 63 * scale, height: 63 * scale)
            context.stroke(Path(ellipseIn: ring), with: .color(Color.white.opacity(0.18)), lineWidth: 0.5 * scale)
            context.stroke(Path(ellipseIn: ring), with: .color(Color(hex: 0x0D1117).opacity(0.16)), lineWidth: 0.5 * scale)
        }
    }
}

private struct AvatarSourceImage: View {
    let source: String
    @State private var image: UIImage?

    var body: some View {
        Color.clear
            .overlay {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
            }
            .task(id: source) {
                image = nil
                image = await AvatarImageLoader.image(from: source)
            }
    }
}

enum AvatarImageLoader {
    static let maximumBytes = 2 * 1_024 * 1_024
    private static let cache = NSCache<NSString, UIImage>()

    static func dataFromImageURL(_ value: String?) -> Data? {
        AttachmentPreviewDataURL.decode(value)
    }

    static func normalizedSource(_ source: String?) -> String? {
        guard let value = source?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty,
              !value.lowercased().hasPrefix("kordi-pixel-avatar://") else { return nil }
        if value.lowercased().hasPrefix("data:image/") { return value }
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme) else { return nil }
        return value
    }

    static func image(from source: String) async -> UIImage? {
        guard let normalized = normalizedSource(source) else { return nil }
        if let cached = cache.object(forKey: normalized as NSString) { return cached }

        let data: Data?
        if normalized.lowercased().hasPrefix("data:image/") {
            data = dataFromImageURL(normalized)
        } else if let url = URL(string: normalized) {
            data = try? await remoteData(from: url)
        } else {
            data = nil
        }

        guard let data, data.count <= maximumBytes, let image = UIImage(data: data) else { return nil }
        cache.setObject(image, forKey: normalized as NSString)
        return image
    }

    private static func remoteData(from url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.cachePolicy = .returnCacheDataElseLoad
        request.timeoutInterval = 15
        request.setValue("image/png,image/jpeg,image/webp,image/*;q=0.8", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              data.count <= maximumBytes else {
            throw URLError(.badServerResponse)
        }
        return data
    }

}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
