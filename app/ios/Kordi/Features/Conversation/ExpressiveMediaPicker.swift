import EmojiKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers
import UIKit

enum ExpressivePickerTab: String, CaseIterable, Identifiable {
    case emoji = "Emoji"
    case stickers = "Stickers"
    case gifs = "GIFs"

    var id: String { rawValue }
}

struct PublicStickerTemplate: Identifiable, Hashable {
    let id: String
    let name: String
    let imageURL: URL
    let previewURL: URL
    let license: String
}

struct PublicGIFResult: Identifiable, Hashable {
    let id: String
    let title: String
    let mediaURL: URL
    let previewURL: URL
    let license: String
    let sizeBytes: Int64
}

enum ExpressiveMediaCatalog {
    private static let gifAPIURL = URL(string: "https://commons.wikimedia.org/w/api.php")!
    private static let mediaHost = "upload.wikimedia.org"

    static func loadPublicStickers(query: String) async throws -> [PublicStickerTemplate] {
        let (data, response) = try await URLSession.shared.data(from: publicStickerSearchURL(query: query))
        try validate(response: response, fallback: "The public sticker catalog is unavailable right now.")
        let templates = try parsePublicStickerTemplates(data)
        guard !templates.isEmpty else { throw ExpressiveMediaCatalogError.noStickerResults }
        return templates
    }

    static func publicStickerSearchURL(query: String) throws -> URL {
        try publicSearchURL(query: query, fallback: "reaction", searchSuffix: "filetype:bitmap", limit: 36)
    }

    static func searchPublicGIFs(query: String) async throws -> [PublicGIFResult] {
        let requestURL = try publicGIFSearchURL(query: query)
        let (data, response) = try await URLSession.shared.data(from: requestURL)
        try validate(response: response, fallback: "The public GIF catalog is unavailable right now.")
        return try parsePublicGIFResults(data)
    }

    static func publicGIFSearchURL(query: String) throws -> URL {
        try publicSearchURL(query: query, fallback: "funny", searchSuffix: "filemime:image/gif", limit: 24)
    }

    private static func publicSearchURL(
        query: String,
        fallback: String,
        searchSuffix: String,
        limit: Int
    ) throws -> URL {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedQuery = String((trimmed.nonEmpty ?? fallback).prefix(100))
        var components = URLComponents(url: gifAPIURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "action", value: "query"),
            URLQueryItem(name: "format", value: "json"),
            URLQueryItem(name: "formatversion", value: "2"),
            URLQueryItem(name: "generator", value: "search"),
            URLQueryItem(name: "gsrsearch", value: "\(normalizedQuery) \(searchSuffix)"),
            URLQueryItem(name: "gsrnamespace", value: "6"),
            URLQueryItem(name: "gsrlimit", value: String(limit)),
            URLQueryItem(name: "gsrsort", value: "relevance"),
            URLQueryItem(name: "prop", value: "imageinfo"),
            URLQueryItem(name: "iiprop", value: "url|mime|size|extmetadata"),
            URLQueryItem(name: "iiurlwidth", value: "320")
        ]
        guard let url = components?.url else { throw ExpressiveMediaCatalogError.invalidResponse }
        return url
    }

    static func downloadSticker(_ template: PublicStickerTemplate) async throws -> PendingAttachment {
        guard isTrustedHTTPSURL(template.imageURL, host: mediaHost) else {
            throw ExpressiveMediaCatalogError.invalidResponse
        }
        return try await downloadMedia(
            at: template.imageURL,
            baseName: template.id,
            expectedKind: .sticker
        )
    }

    static func downloadGIF(_ result: PublicGIFResult) async throws -> PendingAttachment {
        guard isTrustedHTTPSURL(result.mediaURL, host: mediaHost) else {
            throw ExpressiveMediaCatalogError.invalidResponse
        }
        return try await downloadMedia(
            at: result.mediaURL,
            baseName: result.title,
            expectedKind: .gif
        )
    }

    static func parsePublicStickerTemplates(_ data: Data) throws -> [PublicStickerTemplate] {
        let payload = try JSONDecoder().decode(WikimediaResponse.self, from: data)
        let supportedMIMETypes = Set(["image/png", "image/jpeg", "image/webp"])
        return (payload.query?.pages ?? []).compactMap { page -> (Int, PublicStickerTemplate)? in
            guard let pageID = page.pageid,
                  let rawTitle = page.title,
                  let imageInfo = page.imageinfo?.first,
                  let mimeType = imageInfo.mime?.lowercased(),
                  supportedMIMETypes.contains(mimeType),
                  let size = imageInfo.size,
                  size > 0,
                  size <= Int64(PendingAttachmentLoader.maximumAttachmentBytes),
                  let license = publicLicense(imageInfo.extmetadata?.licenseShortName?.value),
                  let rawImageURL = imageInfo.url,
                  let imageURL = URL(string: rawImageURL),
                  isTrustedHTTPSURL(imageURL, host: mediaHost) else { return nil }
            let previewURL = imageInfo.thumburl
                .flatMap(URL.init(string:))
                .flatMap { isTrustedHTTPSURL($0, host: mediaHost) ? $0 : nil }
                ?? imageURL
            let name = cleanMediaTitle(rawTitle)
            guard !name.isEmpty else { return nil }
            return (
                page.index ?? Int.max,
                PublicStickerTemplate(
                    id: String(pageID),
                    name: name,
                    imageURL: imageURL,
                    previewURL: previewURL,
                    license: license
                )
            )
        }
        .sorted { $0.0 < $1.0 }
        .prefix(24)
        .map(\.1)
    }

    static func parsePublicGIFResults(_ data: Data) throws -> [PublicGIFResult] {
        let payload = try JSONDecoder().decode(WikimediaResponse.self, from: data)
        return (payload.query?.pages ?? []).compactMap { page -> (Int, PublicGIFResult)? in
            guard let pageID = page.pageid,
                  let rawTitle = page.title,
                  let imageInfo = page.imageinfo?.first,
                  imageInfo.mime?.lowercased() == "image/gif",
                  let size = imageInfo.size,
                  size > 0,
                  size <= Int64(PendingAttachmentLoader.maximumAttachmentBytes),
                  let license = publicLicense(imageInfo.extmetadata?.licenseShortName?.value),
                  let rawMediaURL = imageInfo.url,
                  let mediaURL = URL(string: rawMediaURL),
                  isTrustedHTTPSURL(mediaURL, host: mediaHost) else { return nil }
            let previewURL = imageInfo.thumburl
                .flatMap(URL.init(string:))
                .flatMap { isTrustedHTTPSURL($0, host: mediaHost) ? $0 : nil }
                ?? mediaURL
            let title = cleanGIFTitle(rawTitle)
            guard !title.isEmpty else { return nil }
            return (
                page.index ?? Int.max,
                PublicGIFResult(
                    id: String(pageID),
                    title: title,
                    mediaURL: mediaURL,
                    previewURL: previewURL,
                    license: license,
                    sizeBytes: size
                )
            )
        }
        .sorted { $0.0 < $1.0 }
        .prefix(18)
        .map(\.1)
    }

    private static func downloadMedia(
        at url: URL,
        baseName: String,
        expectedKind: ExpressiveMediaLibraryKind
    ) async throws -> PendingAttachment {
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("Kordi iOS", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, fallback: "This media could not be downloaded.")
        guard let response = response as? HTTPURLResponse else {
            throw ExpressiveMediaCatalogError.invalidResponse
        }
        let mimeType = response.mimeType?.lowercased()
        let fileExtension = fileExtension(for: mimeType, kind: expectedKind)
        let name = "\(sanitizedFileStem(baseName)).\(fileExtension)"
        return try PendingAttachmentLoader.loadExpressiveMedia(
            data: data,
            suggestedName: name,
            mimeType: mimeType,
            expectedKind: expectedKind
        )
    }

    private static func validate(response: URLResponse, fallback: String) throws {
        guard let response = response as? HTTPURLResponse,
              (200..<300).contains(response.statusCode) else {
            throw ExpressiveMediaCatalogError.requestFailed(fallback)
        }
    }

    private static func isTrustedHTTPSURL(_ url: URL, host: String) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.lowercased() == host
    }

    private static func publicLicense(_ value: String?) -> String? {
        let normalized = value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: " ", with: "")
        switch normalized {
        case "cc0": return "CC0"
        case "publicdomain": return "Public domain"
        default: return nil
        }
    }

    private static func cleanGIFTitle(_ value: String) -> String {
        var title = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.lowercased().hasPrefix("file:") { title.removeFirst(5) }
        if title.lowercased().hasSuffix(".gif") { title.removeLast(4) }
        return title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func cleanMediaTitle(_ value: String) -> String {
        var title = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.lowercased().hasPrefix("file:") { title.removeFirst(5) }
        for suffix in [".png", ".jpg", ".jpeg", ".webp"] where title.lowercased().hasSuffix(suffix) {
            title.removeLast(suffix.count)
            break
        }
        return title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func fileExtension(
        for mimeType: String?,
        kind: ExpressiveMediaLibraryKind
    ) -> String {
        switch mimeType {
        case "image/png": "png"
        case "image/webp": "webp"
        case "image/gif": "gif"
        default: kind == .gif ? "gif" : "jpg"
        }
    }

    private static func sanitizedFileStem(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        let result = value.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
        return String((result.nonEmpty ?? "media").prefix(80))
    }
}

private struct WikimediaResponse: Decodable {
    struct Query: Decodable { let pages: [Page]? }

    struct Page: Decodable {
        let pageid: Int?
        let title: String?
        let index: Int?
        let imageinfo: [ImageInfo]?
    }

    struct ImageInfo: Decodable {
        let url: String?
        let thumburl: String?
        let mime: String?
        let size: Int64?
        let extmetadata: Metadata?
    }

    struct Metadata: Decodable {
        let licenseShortName: MetadataValue?

        enum CodingKeys: String, CodingKey {
            case licenseShortName = "LicenseShortName"
        }
    }

    struct MetadataValue: Decodable { let value: String? }

    let query: Query?
}

private enum ExpressiveMediaCatalogError: LocalizedError {
    case invalidResponse
    case noStickerResults
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "The public media catalog returned an invalid response."
        case .noStickerResults:
            "The public sticker catalog returned no results."
        case let .requestFailed(message):
            message
        }
    }
}

struct ExpressiveMediaPicker: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @AppStorage("kordi.expressive.recent-emojis") private var storedRecentEmojis = "[]"
    @State private var selectedTab = ExpressivePickerTab.emoji
    @State private var emojiCategoryID = EmojiCategory.smileysAndPeople.id
    @State private var emojiQuery = ""
    let isSending: Bool
    let onInsertEmoji: (String) -> Void
    let onSendMedia: (PendingAttachment) async -> Void

    var body: some View {
        VStack(spacing: 0) {
            tabBar
            Divider()
            Group {
                switch selectedTab {
                case .emoji:
                    emojiPanel
                case .stickers:
                    ExpressiveMediaLibraryPanel(
                        kind: .sticker,
                        isSending: isSending,
                        onSendMedia: onSendMedia
                    )
                    .id(ExpressivePickerTab.stickers)
                case .gifs:
                    ExpressiveMediaLibraryPanel(
                        kind: .gif,
                        isSending: isSending,
                        onSendMedia: onSendMedia
                    )
                    .id(ExpressivePickerTab.gifs)
                }
            }
        }
        .frame(height: panelHeight)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color(uiColor: .separator).opacity(0.28), lineWidth: 0.5)
        }
        .accessibilityElement(children: .contain)
    }

    private var panelHeight: CGFloat {
        if verticalSizeClass == .compact { return 248 }
        return dynamicTypeSize.isAccessibilitySize ? 380 : 334
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(ExpressivePickerTab.allCases) { tab in
                Button {
                    selectedTab = tab
                } label: {
                    Text(tab.rawValue)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(selectedTab == tab ? .primary : .secondary)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .overlay(alignment: .bottom) {
                            if selectedTab == tab {
                                Capsule()
                                    .fill(KordiTheme.agentViolet)
                                    .frame(width: 42, height: 3)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
            }
        }
    }

    private var emojiPanel: some View {
        VStack(spacing: 0) {
            KordiPullDownSearchField(
                text: $emojiQuery,
                prompt: "Search emoji",
                accessibilityLabel: "Search emoji"
            )
            .padding(.horizontal, 10)
            .padding(.vertical, 8)

            emojiCategoryBar
            Divider()

            if displayedEmojis.isEmpty {
                ContentUnavailableView.search(text: emojiQuery)
            } else {
                ScrollView {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 42, maximum: 48), spacing: 4)],
                        spacing: 4
                    ) {
                        ForEach(displayedEmojis) { emoji in
                            Button {
                                selectEmoji(emoji)
                            } label: {
                                Text(emoji.char)
                                    .font(.system(size: 29))
                                    .frame(minWidth: 44, minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(emoji.localizedName)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
    }

    private var emojiCategoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                if !recentEmojiCharacters.isEmpty {
                    emojiCategoryButton(
                        id: "recent",
                        name: "Recently used",
                        symbolName: "clock"
                    )
                }
                ForEach(EmojiCategory.standardCategories, id: \.id) { category in
                    emojiCategoryButton(
                        id: category.id,
                        name: category.labelText,
                        symbolName: category.symbolIconName
                    )
                }
            }
            .padding(.horizontal, 8)
        }
        .frame(height: 42)
    }

    private func emojiCategoryButton(id: String, name: String, symbolName: String) -> some View {
        Button {
            emojiQuery = ""
            emojiCategoryID = id
        } label: {
            Image(systemName: symbolName)
                .font(.body)
                .foregroundStyle(emojiCategoryID == id ? KordiTheme.agentViolet : .secondary)
                .frame(width: 44, height: 42)
                .background(
                    emojiCategoryID == id ? KordiTheme.agentViolet.opacity(0.12) : .clear,
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityAddTraits(emojiCategoryID == id ? .isSelected : [])
    }

    private var displayedEmojis: [Emoji] {
        let query = emojiQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if !query.isEmpty { return Emoji.all.matching(query) }
        if emojiCategoryID == "recent" { return recentEmojiCharacters.map(Emoji.init) }
        return EmojiCategory.standardCategories
            .first { $0.id == emojiCategoryID }?
            .emojis ?? EmojiCategory.smileysAndPeople.emojis
    }

    private var recentEmojiCharacters: [String] {
        guard let data = storedRecentEmojis.data(using: .utf8),
              let values = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return values
    }

    private func selectEmoji(_ emoji: Emoji) {
        onInsertEmoji(emoji.char)
        var recent = recentEmojiCharacters.filter { $0 != emoji.char }
        recent.insert(emoji.char, at: 0)
        recent = Array(recent.prefix(24))
        if let data = try? JSONEncoder().encode(recent),
           let encoded = String(data: data, encoding: .utf8) {
            storedRecentEmojis = encoded
        }
    }
}

private struct ExpressiveMediaLibraryPanel: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    @State private var libraryEntries: [ExpressiveMediaLibraryEntry] = []
    @State private var stickerTemplates: [PublicStickerTemplate] = []
    @State private var gifResults: [PublicGIFResult] = []
    @State private var isLoadingPublicMedia = false
    @State private var publicError: String?
    @State private var isShowingImporter = false
    @State private var activeMediaID: String?
    let kind: ExpressiveMediaLibraryKind
    let isSending: Bool
    let onSendMedia: (PendingAttachment) async -> Void

    var body: some View {
        VStack(spacing: 0) {
            KordiPullDownSearchField(
                text: $query,
                prompt: kind == .sticker ? "Search stickers" : "Search GIFs",
                accessibilityLabel: kind == .sticker ? "Search stickers" : "Search GIFs"
            )
            .padding(.horizontal, 10)
            .padding(.vertical, 8)

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    librarySection
                    Divider()
                    publicSection
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .fileImporter(
            isPresented: $isShowingImporter,
            allowedContentTypes: allowedContentTypes,
            allowsMultipleSelection: true,
            onCompletion: importMedia
        )
        .task {
            await refreshLibrary()
        }
        .task(id: publicSearchID) {
            do {
                try await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled else { return }
                await reloadPublicMedia()
            } catch {
                return
            }
        }
    }

    private var librarySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(kind.libraryName)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button {
                    isShowingImporter = true
                } label: {
                    Label("Add", systemImage: "plus")
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .foregroundStyle(KordiTheme.signalBlue)
                .disabled(activeMediaID != nil || isSending)
                .accessibilityHint(importerHint)
            }

            if libraryEntries.isEmpty {
                Text(kind == .sticker
                     ? "Add a PNG, JPEG, or WebP file."
                     : "Add a GIF file.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 54, alignment: .center)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 8) {
                        ForEach(libraryEntries) { entry in
                            Button {
                                send(entry)
                            } label: {
                                LocalExpressiveMediaThumbnail(url: entry.fileURL)
                                    .frame(width: 64, height: 64)
                                    .overlay {
                                        if activeMediaID == entry.id {
                                            ProgressView()
                                                .tint(.white)
                                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                                .background(.black.opacity(0.28))
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                            .disabled(activeMediaID != nil || isSending)
                            .accessibilityLabel("Send \(entry.item.name)")
                        }
                    }
                }
                .frame(height: 64)
            }
        }
    }

    @ViewBuilder
    private var publicSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(kind == .sticker ? "Discover Stickers" : "Discover GIFs")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("Wikimedia Commons")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if isLoadingPublicMedia {
                ProgressView(kind == .sticker ? "Searching stickers…" : "Searching GIFs…")
                    .font(.footnote)
                    .frame(maxWidth: .infinity, minHeight: 92)
            } else if let publicError {
                VStack(spacing: 4) {
                    Text(publicError)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Try Again") {
                        Task { await reloadPublicMedia() }
                    }
                    .font(.footnote.weight(.semibold))
                }
                .frame(maxWidth: .infinity, minHeight: 92)
            } else if kind == .sticker {
                stickerGrid
            } else {
                gifGrid
            }
        }
    }

    private var stickerGrid: some View {
        return Group {
            if stickerTemplates.isEmpty {
                Text("No public-domain stickers match this search.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 92)
            } else {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 68, maximum: 84), spacing: 8)],
                    spacing: 10
                ) {
                    ForEach(stickerTemplates) { template in
                        publicMediaButton(
                            id: "sticker:\(template.id)",
                            title: template.name,
                            previewURL: template.previewURL,
                            send: { try await ExpressiveMediaCatalog.downloadSticker(template) },
                            save: { try await ExpressiveMediaCatalog.downloadSticker(template) }
                        )
                    }
                }
            }
        }
    }

    private var gifGrid: some View {
        Group {
            if gifResults.isEmpty {
                Text("No public-domain GIFs match this search.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 92)
            } else {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 68, maximum: 84), spacing: 8)],
                    spacing: 10
                ) {
                    ForEach(gifResults) { result in
                        publicMediaButton(
                            id: "gif:\(result.id)",
                            title: result.title,
                            previewURL: result.previewURL,
                            send: { try await ExpressiveMediaCatalog.downloadGIF(result) },
                            save: { try await ExpressiveMediaCatalog.downloadGIF(result) }
                        )
                    }
                }
            }
        }
    }

    private func publicMediaButton(
        id: String,
        title: String,
        previewURL: URL,
        send: @escaping () async throws -> PendingAttachment,
        save: @escaping () async throws -> PendingAttachment
    ) -> some View {
        Button {
            performPublicMediaAction(id: id, loader: send, shouldSend: true)
        } label: {
            VStack(spacing: 3) {
                RemoteExpressiveMediaThumbnail(url: previewURL)
                    .frame(height: 64)
                    .overlay {
                        if activeMediaID == id {
                            ProgressView()
                                .tint(.white)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                                .background(.black.opacity(0.28))
                        }
                    }
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .disabled(activeMediaID != nil || isSending)
        .accessibilityLabel("Send \(title)")
        .contextMenu {
            Button {
                performPublicMediaAction(id: id, loader: save, shouldSend: false)
            } label: {
                Label("Add to \(kind.libraryName)", systemImage: "plus.square.on.square")
            }
        }
    }

    private var allowedContentTypes: [UTType] {
        switch kind {
        case .sticker:
            var types: [UTType] = [.png, .jpeg]
            if let webP = UTType(filenameExtension: "webp") { types.append(webP) }
            return types
        case .gif:
            return [.gif]
        }
    }

    private var importerHint: String {
        kind == .sticker
            ? "Adds PNG, JPEG, or WebP files directly to My Stickers"
            : "Adds GIF files directly to My GIFs"
    }

    private var publicSearchID: String {
        "\(kind.rawValue):\(query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
    }

    private func importMedia(_ result: Result<[URL], Error>) {
        Task {
            do {
                let urls = try result.get()
                guard !urls.isEmpty else { return }
                activeMediaID = "import"
                _ = await model.addExpressiveMediaFiles(urls, kind: kind)
                await refreshLibrary()
                activeMediaID = nil
            } catch {
                let nsError = error as NSError
                guard nsError.domain != NSCocoaErrorDomain || nsError.code != NSUserCancelledError else { return }
                model.errorMessage = error.localizedDescription
            }
        }
    }

    private func send(_ entry: ExpressiveMediaLibraryEntry) {
        guard activeMediaID == nil, !isSending else { return }
        activeMediaID = entry.id
        Task {
            if let attachment = await model.pendingAttachment(for: entry) {
                await onSendMedia(attachment)
            }
            activeMediaID = nil
        }
    }

    private func performPublicMediaAction(
        id: String,
        loader: @escaping () async throws -> PendingAttachment,
        shouldSend: Bool
    ) {
        guard activeMediaID == nil, !isSending else { return }
        activeMediaID = id
        Task {
            do {
                let attachment = try await loader()
                if shouldSend {
                    await onSendMedia(attachment)
                } else if await model.addExpressiveMediaAttachment(attachment, kind: kind) {
                    await refreshLibrary()
                }
            } catch {
                publicError = error.localizedDescription
            }
            activeMediaID = nil
        }
    }

    private func refreshLibrary() async {
        libraryEntries = await model.expressiveMediaLibraryEntries(kind: kind)
        await model.synchronizeExpressiveMediaLibrary()
        libraryEntries = await model.expressiveMediaLibraryEntries(kind: kind)
    }

    private func reloadPublicMedia() async {
        if kind == .sticker {
            await loadPublicStickers()
        } else {
            await loadPublicGIFs()
        }
    }

    private func loadPublicStickers() async {
        isLoadingPublicMedia = true
        publicError = nil
        do {
            stickerTemplates = try await ExpressiveMediaCatalog.loadPublicStickers(query: query)
        } catch {
            guard !Task.isCancelled else { return }
            publicError = error.localizedDescription
        }
        isLoadingPublicMedia = false
    }

    private func loadPublicGIFs() async {
        isLoadingPublicMedia = true
        publicError = nil
        do {
            gifResults = try await ExpressiveMediaCatalog.searchPublicGIFs(query: query)
        } catch {
            guard !Task.isCancelled else { return }
            publicError = error.localizedDescription
        }
        isLoadingPublicMedia = false
    }
}

private struct LocalExpressiveMediaThumbnail: View {
    let url: URL
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .tertiarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .clipped()
        .task(id: url) {
            image = await Task.detached(priority: .utility) {
                AttachmentImageDecoder.downsampledImage(at: url, maximumPixelSize: 240)
            }.value
        }
    }
}

private struct RemoteExpressiveMediaThumbnail: View {
    let url: URL

    var body: some View {
        AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.16))) { phase in
            switch phase {
            case let .success(image):
                image.resizable().scaledToFill()
            case .failure:
                Image(systemName: "photo")
                    .foregroundStyle(.secondary)
            default:
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .tertiarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .clipped()
    }
}
