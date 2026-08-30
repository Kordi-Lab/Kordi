import Foundation
import PhotosUI
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

struct ExpressiveMediaImportRequest {
    let completion: ([PhotosPickerItem]) -> Void
}

struct ExpressiveMediaPicker: View {
    @State private var selectedTab = ExpressivePickerTab.emoji
    let model: AppModel
    let height: CGFloat
    let isSending: Bool
    let onInsertEmoji: (String) -> Void
    let onSendMedia: (PendingAttachment) async -> Void
    let allowsSearch: Bool
    var onRequestImport: ((ExpressiveMediaImportRequest) -> Void)? = nil

    var body: some View {
        pickerContent
            .background(keyboardSurfaceColor.ignoresSafeArea(.container, edges: .bottom))
            .accessibilityElement(children: .contain)
    }

    private var keyboardSurfaceColor: Color {
        Color(uiColor: .systemGray6)
    }

    private var pickerContent: some View {
        VStack(spacing: 0) {
            tabBar
            Divider()
            Group {
                switch selectedTab {
                case .emoji:
                    BlobEmojiSelectionBoard(allowsSearch: allowsSearch) {
                        onInsertEmoji($0.inlineToken)
                    }
                case .stickers:
                    ExpressiveMediaLibraryPanel(
                        model: model,
                        kind: .sticker,
                        isSending: isSending,
                        onSendMedia: onSendMedia,
                        onRequestImport: onRequestImport
                    )
                    .id(ExpressivePickerTab.stickers)
                case .gifs:
                    ExpressiveMediaLibraryPanel(
                        model: model,
                        kind: .gif,
                        isSending: isSending,
                        onSendMedia: onSendMedia,
                        onRequestImport: onRequestImport
                    )
                    .id(ExpressivePickerTab.gifs)
                }
            }
        }
        .frame(height: height)
    }

    private var tabBar: some View {
        Picker("Media type", selection: $selectedTab) {
            ForEach(ExpressivePickerTab.allCases) { tab in
                Text(tab.rawValue).tag(tab)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

enum BlobEmojiPickerCategory: String, CaseIterable, Identifiable {
    case recent = "Recent"
    case all = "All"
    case animated = "Animated"
    case staticImages = "Static"

    var id: String { rawValue }

    var symbolName: String {
        switch self {
        case .recent: "clock"
        case .all: "square.grid.3x3"
        case .animated: "play.circle"
        case .staticImages: "photo"
        }
    }
}

struct BlobEmojiSelectionBoard: View {
    @AppStorage(BlobEmojiRecentStore.key) private var storedRecentEmojiIDs = "[]"
    @State private var category: BlobEmojiPickerCategory
    @State private var query = ""
    let allowsSearch: Bool
    let onSelect: (BlobEmoji) -> Void

    init(
        initialCategory: BlobEmojiPickerCategory = .all,
        allowsSearch: Bool = true,
        onSelect: @escaping (BlobEmoji) -> Void
    ) {
        _category = State(initialValue: initialCategory)
        self.allowsSearch = allowsSearch
        self.onSelect = onSelect
    }

    var body: some View {
        VStack(spacing: 0) {
            if allowsSearch {
                KordiPullDownSearchField(
                    text: $query,
                    prompt: "Search Blob Emoji",
                    accessibilityLabel: "Search Blob Emoji"
                )
                .padding(.horizontal, 10)
                .padding(.top, 8)
            }

            HStack {
                Text("\(category.rawValue) · \(displayedEmojis.count)")
                    .font(.subheadline.weight(.semibold))
                Spacer(minLength: 8)
                Image(systemName: "slider.horizontal.3")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 34)

            if displayedEmojis.isEmpty {
                ContentUnavailableView.search(text: query)
            } else {
                ScrollView {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 40, maximum: 46), spacing: 0)],
                        spacing: 0
                    ) {
                        ForEach(displayedEmojis) { emoji in
                            Button {
                                storedRecentEmojiIDs = BlobEmojiRecentStore.recording(
                                    emoji.id,
                                    in: storedRecentEmojiIDs
                                )
                                onSelect(emoji)
                            } label: {
                                BlobEmojiView(emoji: emoji, size: 34)
                                    .frame(minWidth: 44, minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(emoji.accessibilityName)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)
                }
                .scrollDismissesKeyboard(.never)
            }

            Divider()
            categoryBar
        }
        .background(Color(uiColor: .systemGray6))
        .accessibilityElement(children: .contain)
    }

    private var categoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(BlobEmojiPickerCategory.allCases) { category in
                    categoryButton(category)
                }
            }
            .padding(.horizontal, 8)
        }
        .frame(height: 44)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Emoji categories")
    }

    private func categoryButton(_ value: BlobEmojiPickerCategory) -> some View {
        Button {
            query = ""
            category = value
        } label: {
            Image(systemName: value.symbolName)
                .font(.body)
                .foregroundStyle(category == value ? KordiTheme.agentViolet : .secondary)
                .frame(width: 44, height: 44)
                .background(
                    category == value ? KordiTheme.agentViolet.opacity(0.12) : .clear,
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(value.rawValue)
        .accessibilityAddTraits(category == value ? .isSelected : [])
    }

    private var displayedEmojis: [BlobEmoji] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedQuery.isEmpty { return BlobEmojiCatalog.matching(normalizedQuery) }
        switch category {
        case .recent:
            return BlobEmojiRecentStore.ids(from: storedRecentEmojiIDs)
                .compactMap { BlobEmojiCatalog.byID[$0] }
        case .all:
            return BlobEmojiCatalog.all
        case .animated:
            return BlobEmojiCatalog.all.filter(\.animated)
        case .staticImages:
            return BlobEmojiCatalog.all.filter { !$0.animated }
        }
    }
}

private struct ExpressiveMediaLibraryPanel: View {
    @State private var libraryEntries: [ExpressiveMediaLibraryEntry] = []
    @State private var isShowingPhotoPicker = false
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var activeMediaID: String?
    let model: AppModel
    let kind: ExpressiveMediaLibraryKind
    let isSending: Bool
    let onSendMedia: (PendingAttachment) async -> Void
    let onRequestImport: ((ExpressiveMediaImportRequest) -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                librarySection
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.never)
        }
        .photosPicker(
            isPresented: $isShowingPhotoPicker,
            selection: $selectedPhotos,
            maxSelectionCount: PendingAttachmentLoader.maximumAttachmentCount,
            matching: .images,
            preferredItemEncoding: .current
        )
        .onChange(of: selectedPhotos) { _, items in
            guard !items.isEmpty else { return }
            selectedPhotos = []
            importMedia(items)
        }
        .task {
            await refreshLibrary()
        }
    }

    private var librarySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(kind.libraryName)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button {
                    if let onRequestImport {
                        onRequestImport(ExpressiveMediaImportRequest(
                            completion: importMedia
                        ))
                    } else {
                        isShowingPhotoPicker = true
                    }
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
                     ? "Add an image from Photos."
                     : "Add an animated GIF from Photos.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 54, alignment: .center)
            } else {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 64, maximum: 64), spacing: 8)],
                    spacing: 8
                ) {
                    ForEach(libraryEntries) { entry in
                        Button {
                            send(entry)
                        } label: {
                            LocalExpressiveMediaThumbnail(url: entry.fileURL)
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
                        .accessibilityAction(named: "Delete \(entry.item.name)") {
                            remove(entry)
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                remove(entry)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            }
        }
    }

    private var importerHint: String {
        kind == .sticker
            ? "Opens Photos to add an image directly to My Stickers"
            : "Opens Photos to add an animated GIF directly to My GIFs"
    }

    private func importMedia(_ items: [PhotosPickerItem]) {
        Task {
            do {
                guard !items.isEmpty else { return }
                activeMediaID = "import"
                for (index, item) in items.enumerated() {
                    let attachment = try await loadPhoto(item, index: index)
                    guard await model.addExpressiveMediaAttachment(attachment, kind: kind) else {
                        activeMediaID = nil
                        return
                    }
                }
                await refreshLibrary()
                activeMediaID = nil
            } catch {
                activeMediaID = nil
                model.errorMessage = error.localizedDescription
            }
        }
    }

    private func loadPhoto(_ item: PhotosPickerItem, index: Int) async throws -> PendingAttachment {
        guard let data = try await item.loadTransferable(type: Data.self) else {
            throw AttachmentTransferError.invalidImage
        }
        let isGIF = item.supportedContentTypes.contains { $0.conforms(to: .gif) }
        let expectedKind = kind
        if kind == .gif, !isGIF {
            throw ExpressiveMediaLibraryError.unsupportedFile
        }
        if isGIF {
            return try await Task.detached(priority: .userInitiated) {
                try PendingAttachmentLoader.loadExpressiveMedia(
                    data: data,
                    suggestedName: "GIF-\(index + 1).gif",
                    mimeType: "image/gif",
                    expectedKind: expectedKind
                )
            }.value
        }
        guard kind == .sticker else {
            throw ExpressiveMediaLibraryError.unsupportedFile
        }
        if let type = item.supportedContentTypes.first(where: {
            guard let fileExtension = $0.preferredFilenameExtension else { return false }
            return ExpressiveMediaLibraryKind.supportedKind(
                name: "Sticker.\(fileExtension)",
                mimeType: $0.preferredMIMEType
            ) == .sticker
        }), let fileExtension = type.preferredFilenameExtension {
            return try await Task.detached(priority: .userInitiated) {
                try PendingAttachmentLoader.loadExpressiveMedia(
                    data: data,
                    suggestedName: "Sticker-\(index + 1).\(fileExtension)",
                    mimeType: type.preferredMIMEType,
                    expectedKind: .sticker
                )
            }.value
        }
        var attachment = try await Task.detached(priority: .userInitiated) {
            try PendingAttachmentLoader.loadImage(
                data: data,
                suggestedName: "Sticker-\(index + 1).jpg"
            )
        }.value
        attachment.subtype = .sticker
        return attachment
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

    private func remove(_ entry: ExpressiveMediaLibraryEntry) {
        guard activeMediaID == nil, !isSending else { return }
        activeMediaID = entry.id
        Task {
            if await model.removeExpressiveMedia(entry) {
                libraryEntries = await model.expressiveMediaLibraryEntries(kind: kind)
            }
            activeMediaID = nil
        }
    }

    private func refreshLibrary() async {
        libraryEntries = await model.expressiveMediaLibraryEntries(kind: kind)
        await model.synchronizeExpressiveMediaLibrary()
        libraryEntries = await model.expressiveMediaLibraryEntries(kind: kind)
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
                    .scaledToFit()
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(width: 64, height: 64)
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
