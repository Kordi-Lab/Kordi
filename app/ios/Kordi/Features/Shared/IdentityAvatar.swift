import Foundation
import PhotosUI
import SwiftUI
import UIKit

struct IdentityAvatar: View {
    let name: String
    let imageSource: String?
    let kind: ConversationKind
    var size: CGFloat = 52
    var seed: String? = nil
    var cornerRadius: CGFloat? = nil
    /// False leaves the person fallback as a plain fill, for avatars under an overlay.
    var showsInitials = true

    private var normalizedImageSource: String? {
        if isSystemAgent || isSystem { return nil }
        if let source = AvatarImageLoader.normalizedSource(imageSource) { return source }
        guard kind == .agent, !isKordiSupport, let seed = seed?.nonEmpty else { return nil }
        return CanonicalAvatarSystem.previewURL(
            style: CanonicalAvatarSystem.agentStyle,
            seed: seed
        )?.absoluteString
    }

    private var isKordiSupport: Bool {
        KordiSupportIdentity.matches(name: name, seed: seed)
    }

    private var isSystemAgent: Bool {
        KordiSystemAgentIdentity.matches(name: name, seed: seed)
    }

    private var isSystem: Bool { KordiSystemIdentity.matches(seed: seed) }

    var body: some View {
        ZStack {
            fallback

            if let normalizedImageSource {
                AvatarSourceImage(source: normalizedImageSource)
                    .id("\(kind):\(seed?.nonEmpty ?? name)")
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius ?? size * 0.17, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: cornerRadius ?? size * 0.17, style: .continuous).stroke(Color(uiColor: .separator).opacity(0.22), lineWidth: 0.5)
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var fallback: some View {
        if isSystem || isSystemAgent {
            KordiSystemAvatar()
        } else if isKordiSupport {
            KordiSupportAvatar()
        } else {
            switch kind {
            case .agent:
                Rectangle().fill(Color(uiColor: .secondarySystemFill))
            case .group:
                Rectangle().fill(KordiTheme.signalBlue.opacity(0.12))
                Image(systemName: "person.2.fill")
                    .font(.system(size: size * 0.34, weight: .semibold))
                    .foregroundStyle(KordiTheme.signalBlue)
            case .person:
                Rectangle().fill(Color(uiColor: .secondarySystemFill))
                Text(initials)
                    .opacity(showsInitials ? 1 : 0)
                    .font(.system(size: size * 0.36, weight: .semibold, design: .rounded))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var initials: String {
        let words = name.split(whereSeparator: \.isWhitespace)
        let value = words.count > 1
            ? String(words.prefix(2).compactMap(\.first))
            : String((words.first ?? Substring()).prefix(2))
        return value.nonEmpty?.uppercased() ?? "?"
    }
}

struct AvatarActionPill: View {
    @Binding var selectedPhoto: PhotosPickerItem?
    let disabled: Bool
    let onRandomize: () -> Void
    var randomLabel = "Random avatar"
    var uploadLabel = "Upload avatar"
    var vertical = false
    var buttonHeight: CGFloat = 44

    var body: some View {
        Group {
            if vertical {
                VStack(spacing: 0) { actions }
            } else {
                HStack(spacing: 0) { actions }
            }
        }
        .foregroundStyle(.secondary)
        .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
        .overlay {
            Capsule()
                .stroke(Color(uiColor: .separator).opacity(0.45), lineWidth: 0.5)
        }
        .disabled(disabled)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var actions: some View {
        Button(action: onRandomize) {
            Image(systemName: "dice")
                .frame(width: 44, height: buttonHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(randomLabel)

        Divider()
            .frame(width: vertical ? 24 : nil, height: vertical ? nil : 24)

        PhotosPicker(selection: $selectedPhoto, matching: .images) {
            Image(systemName: "camera")
                .frame(width: 44, height: buttonHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(uploadLabel)
    }
}

/// The System agent, the built-in plan agent. Its account still posts plans, but
/// the app shows it as System with the gray Kordi bird, like every server notice.
enum KordiSystemAgentIdentity {
    // The stored ids keep the agent's old name.
    static let accountId = "acct_kordi_pip"
    static let agentId = "cloud_agent_kordi_pip"
    /// The name the agent's account carried before it showed as System.
    static let legacyName = "PiP"

    /// The legacy name, in any capitalisation, so messages loaded before the
    /// server rename still show as System.
    static func isLegacyName(_ name: String?) -> Bool {
        name?.trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare(legacyName) == .orderedSame
    }

    static func isSystemAgent(accountId: String?) -> Bool {
        accountId?.trimmingCharacters(in: .whitespacesAndNewlines) == Self.accountId
    }

    static func matches(name: String?, seed: String?) -> Bool {
        let normalizedSeed = seed?.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedSeed == accountId || normalizedSeed == agentId { return true }
        return isLegacyName(name) && (normalizedSeed?.isEmpty ?? true)
    }
}

enum KordiSupportIdentity {
    static let accountId = "acct_kordi_support"
    static let agentId = "cloud_agent_kordi_support"
    static let displayName = "Kordi Support"
    private static let systemAgentSessionPrefix = "session:direct-system-agent:"

    static func sessionId(for accountId: String) -> String {
        "\(systemAgentSessionPrefix)\(accountId):\(agentId)"
    }

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

/// Kordi Support: the ink paper-cut bird on white, in both color schemes.
private struct KordiSupportAvatar: View {
    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            ZStack {
                Color.white
                KordiMark(size: side * 0.86)
                    .environment(\.colorScheme, .light)
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
    }
}

struct GroupAvatarStack: View {
    let participants: [CloudGroupParticipant]
    var size: CGFloat = 52
    var imageSource: String? = nil

    private var visibleParticipants: [CloudGroupParticipant] {
        Array(participants.filter { !KordiSystemIdentity.isServiceAccount($0.accountId) }
            .sorted(by: CloudGroupParticipant.canonicalPrecedes).prefix(9))
    }

    var body: some View {
        let members = visibleParticipants
        let columns = members.count <= 1 ? 1 : members.count <= 4 ? 2 : 3
        let tileSize = (size - 4 - CGFloat(columns - 1)) / CGFloat(columns)
        ZStack(alignment: .topLeading) {
            Color(uiColor: .secondarySystemFill)
            if members.isEmpty {
                IdentityAvatar(name: "Group", imageSource: nil, kind: .group, size: size)
            } else {
                ForEach(members) { participant in
                    let index = members.firstIndex(where: { $0.id == participant.id }) ?? 0
                    IdentityAvatar(name: participant.displayName, imageSource: participant.avatarUrl,
                        kind: .person, size: tileSize, seed: participant.accountId, cornerRadius: 1)
                        .offset(x: 2 + CGFloat(index % columns) * (tileSize + 1),
                                y: 2 + CGFloat(index / columns) * (tileSize + 1))
                }
            }
            if let source = AvatarImageLoader.normalizedSource(imageSource) {
                AvatarSourceImage(source: source).id(source)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.17, style: .continuous))
        .accessibilityHidden(true)
    }
}

private struct AvatarSourceImage: View {
    let source: String
    @Environment(\.scenePhase) private var scenePhase
    @State private var image: UIImage?
    @State private var retry = 0

    init(source: String) {
        self.source = source
        _image = State(initialValue: AvatarImageLoader.cachedImage(from: source))
    }

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
            .task(id: "\(source):\(retry)") {
                for delay in [0, 1, 3] {
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                    guard !Task.isCancelled else { return }
                    if let loaded = await AvatarImageLoader.image(from: source) {
                        guard !Task.isCancelled else { return }
                        image = loaded
                        return
                    }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active, image == nil { retry += 1 }
            }
    }
}

enum AvatarImageLoader {
    static let maximumBytes = 2 * 1_024 * 1_024
    private static let maximumPixelSize: CGFloat = 1_024
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 96
        cache.totalCostLimit = 48 * 1_024 * 1_024
        return cache
    }()

    static func dataFromImageURL(_ value: String?) -> Data? {
        AttachmentPreviewDataURL.decode(value)
    }

    static func normalizedSource(_ source: String?) -> String? {
        guard let value = source?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty,
              !value.lowercased().hasPrefix("kordi-pixel-avatar://") else { return nil }
        if value.lowercased().hasPrefix(CanonicalAvatarSystem.markerPrefix) {
            return CanonicalAvatarSystem.renderURL(from: value)?.absoluteString
        }
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
        guard let data, data.count <= maximumBytes else { return nil }
        let image = await Task.detached(priority: .utility) {
            AttachmentImageDecoder.downsampledImage(
                data: data,
                maximumPixelSize: maximumPixelSize
            )
        }.value
        guard let image else { return nil }
        store(image, for: normalized)
        return image
    }

    static func cachedImage(from source: String, urlCache: URLCache = .shared) -> UIImage? {
        guard let normalized = normalizedSource(source) else { return nil }
        if let cached = cache.object(forKey: normalized as NSString) { return cached }

        let data: Data?
        if normalized.lowercased().hasPrefix("data:image/") {
            data = dataFromImageURL(normalized)
        } else if let url = URL(string: normalized) {
            data = urlCache.cachedResponse(for: URLRequest(url: url))?.data
        } else {
            data = nil
        }
        guard let data, data.count <= maximumBytes,
              let image = AttachmentImageDecoder.downsampledImage(
                data: data,
                maximumPixelSize: maximumPixelSize
              ) else { return nil }
        store(image, for: normalized)
        return image
    }

    private static func store(_ image: UIImage, for source: String) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        cache.setObject(image, forKey: source as NSString, cost: cost)
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
