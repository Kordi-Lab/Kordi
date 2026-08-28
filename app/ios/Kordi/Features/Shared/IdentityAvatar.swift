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

    private var normalizedImageSource: String? {
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

    var body: some View {
        ZStack {
            if normalizedImageSource == nil {
                fallback
            } else {
                imageLoadingPlaceholder
            }

            if let normalizedImageSource {
                AvatarSourceImage(source: normalizedImageSource)
                    .id("\(kind):\(seed?.nonEmpty ?? name)")
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
                Circle().fill(Color(uiColor: .secondarySystemFill))
            case .group:
                Circle().fill(KordiTheme.signalBlue.opacity(0.12))
                Image(systemName: "person.2.fill")
                    .font(.system(size: size * 0.34, weight: .semibold))
                    .foregroundStyle(KordiTheme.signalBlue)
            case .person:
                Circle().fill(Color(uiColor: .secondarySystemFill))
                Image(systemName: "person.crop.circle.fill")
                    .font(.system(size: size * 0.42, weight: .regular))
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var imageLoadingPlaceholder: some View {
        if isKordiSupport {
            KordiSupportAvatar()
        } else if kind == .agent {
            Circle().fill(Color(uiColor: .secondarySystemFill))
        } else {
            Circle().fill(Color(uiColor: .secondarySystemFill))
            Image(systemName: kind == .group ? "person.2.fill" : "person.crop.circle.fill")
                .font(.system(size: size * 0.42, weight: .regular))
                .foregroundStyle(.secondary)
        }
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
        Array(participants.sorted(by: CloudGroupParticipant.canonicalPrecedes).prefix(3))
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
                guard let loaded = await AvatarImageLoader.image(from: source),
                      !Task.isCancelled else { return }
                image = loaded
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
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        cache.setObject(image, forKey: normalized as NSString, cost: cost)
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
