@preconcurrency import LinkPresentation
import SwiftUI
@preconcurrency import UIKit

// Link Presentation finishes populating metadata before this value crosses a
// suspension, and Kordi unwraps it only on MainActor. Remove this wrapper when
// LinkPresentation adopts Sendable.
struct LinkPreviewMetadataValue: @unchecked Sendable {
    let metadata: LPLinkMetadata?
}

// The callback captures this box only to retain the provider; it never calls
// provider APIs across actors. Remove it when LPMetadataProvider is Sendable.
private final class LinkMetadataProviderRetention: @unchecked Sendable {
    let provider: LPMetadataProvider

    init(_ provider: LPMetadataProvider) {
        self.provider = provider
    }
}

@MainActor
final class LinkPreviewMetadataCache {
    typealias Loader = (URL) async -> LinkPreviewMetadataValue

    static let shared = LinkPreviewMetadataCache()

    private final class Entry: NSObject {
        let metadata: LPLinkMetadata?
        let expiresAt: Date

        init(metadata: LPLinkMetadata?, expiresAt: Date) {
            self.metadata = metadata
            self.expiresAt = expiresAt
        }
    }

    private let cache = NSCache<NSURL, Entry>()
    private var inFlight: [URL: Task<LinkPreviewMetadataValue, Never>] = [:]
    private let loader: Loader
    private let successTTL: TimeInterval
    private let failureTTL: TimeInterval

    init(
        countLimit: Int = 64,
        successTTL: TimeInterval = 6 * 60 * 60,
        failureTTL: TimeInterval = 60,
        loader: @escaping Loader = LinkPreviewMetadataCache.fetch
    ) {
        cache.countLimit = countLimit
        self.successTTL = successTTL
        self.failureTTL = failureTTL
        self.loader = loader
    }

    func metadata(for url: URL, now: Date = Date()) async -> LinkPreviewMetadataValue {
        let key = url as NSURL
        if let entry = cache.object(forKey: key) {
            if entry.expiresAt > now { return LinkPreviewMetadataValue(metadata: entry.metadata) }
            cache.removeObject(forKey: key)
        }
        if let task = inFlight[url] { return await task.value }

        let task = Task { await loader(url) }
        inFlight[url] = task
        let value = await task.value
        inFlight[url] = nil
        cache.setObject(
            Entry(
                metadata: value.metadata,
                expiresAt: now.addingTimeInterval(value.metadata == nil ? failureTTL : successTTL)
            ),
            forKey: key
        )
        return value
    }

    private static func fetch(_ url: URL) async -> LinkPreviewMetadataValue {
        await withCheckedContinuation { continuation in
            let provider = LPMetadataProvider()
            let retention = LinkMetadataProviderRetention(provider)
            provider.timeout = 10
            provider.startFetchingMetadata(for: url) { [retention] metadata, _ in
                _ = retention
                continuation.resume(returning: LinkPreviewMetadataValue(metadata: metadata))
            }
        }
    }
}

struct MessageLinkPreview: View {
    let url: URL
    @State private var metadata: LPLinkMetadata?
    @State private var artwork: UIImage?

    var body: some View {
        Link(destination: url) {
            card
            .frame(maxWidth: .infinity)
            .frame(minHeight: 92)
            .clipShape(.rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Open \(displayTitle) on \(displayHost)")
        .task(id: url) {
            metadata = nil
            artwork = nil
            let loaded = await LinkPreviewMetadataCache.shared.metadata(for: url).metadata
            guard !Task.isCancelled else { return }
            metadata = loaded
            if let loaded {
                let loadedArtwork = await previewArtwork(for: loaded)
                guard !Task.isCancelled else { return }
                artwork = loadedArtwork
            }
        }
    }

    private var card: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(displayHost)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(displayTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                if let displayPath {
                    Text(displayPath)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            ZStack {
                Color.primary.opacity(0.05)
                if let artwork {
                    Image(uiImage: artwork)
                        .resizable()
                        .scaledToFill()
                        .accessibilityHidden(true)
                } else {
                    Image(systemName: "link")
                        .font(.title3.weight(.medium))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
            }
            .frame(width: 88)
            .clipped()
        }
        .background(Color.primary.opacity(0.035))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.primary.opacity(0.12), lineWidth: 1)
        }
    }

    private var displayHost: String {
        url.host?.replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
            ?? "Link"
    }

    private var displayPath: String? {
        let path = url.path.removingPercentEncoding ?? url.path
        return path == "/" || path.isEmpty ? nil : String(path.prefix(100))
    }

    private var fallbackTitle: String {
        guard let leaf = displayPath?.split(separator: "/").last else { return displayHost }
        let title = leaf.replacingOccurrences(of: "[-_]", with: " ", options: .regularExpression)
        guard !title.isEmpty,
              title.range(of: "^[a-fA-F0-9]{20,}$", options: .regularExpression) == nil else {
            return displayHost
        }
        return String(title.prefix(100))
    }

    private var displayTitle: String {
        guard let title = metadata?.title?.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty else { return fallbackTitle }
        return String(title.prefix(200))
    }

    private func previewArtwork(for metadata: LPLinkMetadata) async -> UIImage? {
        guard let provider = metadata.imageProvider ?? metadata.iconProvider,
              provider.canLoadObject(ofClass: UIImage.self) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadObject(ofClass: UIImage.self) { image, _ in
                continuation.resume(returning: image as? UIImage)
            }
        }
    }
}
