import AVKit
import QuickLook
import SwiftUI
import UIKit

/// Photos, Files or Links of the chat, pushed inside the profile's sheet or
/// navigation stack and grouped by month.
struct ContactProfileSharedPageView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.calendar) private var calendar
    @Environment(\.locale) private var locale
    let page: ContactProfileSharedPage
    let conversation: ConversationSummary
    @State private var isLoading = false
    @State private var mediaPreview: MediaPreviewPresentation?
    @State private var videoPreview: VideoPreviewPresentation?
    @State private var previewURL: URL?
    @State private var documentReader: DocumentReaderRequest?
    @State private var loadingAttachmentId: String?

    /// Whatever is loaded so far; complete once the history finishes loading.
    private var items: ContactProfileSharedItems {
        model.contactProfileSharedItems(for: conversation)
            ?? ContactProfileSharedItemsMemo.items(for: conversation.id, messages: model.messages(for: conversation))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                content
            }
            .padding(.bottom, 32)
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .task(id: conversation.id) {
            isLoading = true
            await model.loadContactProfileHistory(for: conversation)
            isLoading = false
        }
        .quickLookPreview($previewURL)
        .navigationDestination(item: $documentReader) { DocumentReaderScreen(request: $0) }
        .fullScreenCover(item: $mediaPreview) { MediaPreviewView(presentation: $0) }
        .fullScreenCover(item: $videoPreview) { presentation in
            FullScreenMessageVideo(player: presentation.player, name: presentation.attachment.name, poster: presentation.poster)
        }
    }

    @ViewBuilder
    private var content: some View {
        let count = items.count(page)
        if count == 0 {
            Group {
                if isLoading { ProgressView() } else { Text(page.emptyTitle).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
        } else {
            switch page {
            case .photos: photoSections
            case .files: fileSections
            case .links: linkSections
            }
        }
    }

    private func sections<Item: Identifiable>(_ list: [Item], date: (Item) -> Date) -> [ContactProfileMonthSection<Item>] {
        ContactProfileMonthGrouping.sections(list, date: date, calendar: calendar, locale: locale)
    }

    private var photoSections: some View {
        ForEach(sections(items.photos, date: \.date)) { section in
            ContactProfileMonthLabel(title: section.title)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 1), count: 3), spacing: 1) {
                ForEach(section.items) { item in
                    ContactProfilePhotoTile(item: item) { open(photo: item, image: $0) }
                }
            }
        }
    }

    private var fileSections: some View {
        ForEach(sections(items.files, date: \.date)) { section in
            ContactProfileMonthLabel(title: section.title)
            ForEach(Array(section.items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { ContactProfileDivider(inset: ContactProfileSharedRowMetrics.dividerInset) }
                ContactProfileFileRow(
                    item: item,
                    day: ContactProfileMonthGrouping.dayLabel(item.date, calendar: calendar, locale: locale),
                    isLoading: loadingAttachmentId == item.attachment.id
                ) { open(file: item) }
            }
        }
    }

    private var linkSections: some View {
        ForEach(sections(items.links, date: \.date)) { section in
            ContactProfileMonthLabel(title: section.title)
            ForEach(Array(section.items.enumerated()), id: \.element.id) { index, link in
                if index > 0 { ContactProfileDivider(inset: ContactProfileSharedRowMetrics.dividerInset) }
                ContactProfileLinkRow(link: link, day: ContactProfileMonthGrouping.dayLabel(link.date, calendar: calendar, locale: locale)) {
                    UIApplication.shared.open(link.url)
                }
            }
        }
    }

    // MARK: Actions

    /// Images open in the media viewer, videos in the full-screen player.
    private func open(photo item: ContactProfileSharedAttachment, image: UIImage?) {
        guard item.isVideo else {
            mediaPreview = MediaPreviewPresentation.make(
                opening: item.attachment,
                from: item.message,
                in: model.messages(for: conversation),
                initialImage: image
            )
            return
        }
        prepare(item.attachment) { url in
            videoPreview = VideoPreviewPresentation(attachment: item.attachment, inlinePlayer: AVPlayer(url: url), poster: image)
        }
    }

    /// The same as a file bubble: Markdown and HTML in the reader, the rest in Quick Look.
    private func open(file item: ContactProfileSharedAttachment) {
        if let request = DocumentReaderRequest(attachment: item.attachment, message: item.message, conversation: conversation) {
            documentReader = request
        } else {
            prepare(item.attachment) { previewURL = $0 }
        }
    }

    private func prepare(_ attachment: ChatAttachment, then present: @escaping (URL) -> Void) {
        guard loadingAttachmentId == nil else { return }
        loadingAttachmentId = attachment.id
        Task {
            defer { loadingAttachmentId = nil }
            if let url = await model.prepareAttachmentForPresentation(attachment) { present(url) }
        }
    }
}

enum ContactProfileSharedRowMetrics {
    static let leadSize: CGFloat = 40
    static let dividerInset: CGFloat = ContactProfileMetrics.gutter + leadSize + 12
}

/// "October", or "October 2025" outside the current year.
struct ContactProfileMonthLabel: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, ContactProfileMetrics.gutter)
            .padding(.top, 16)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A square grid tile; videos carry a small play badge.
struct ContactProfilePhotoTile: View {
    @EnvironmentObject private var model: AppModel
    let item: ContactProfileSharedAttachment
    let onOpen: (UIImage?) -> Void
    @State private var image: UIImage?
    @State private var hasFailed = false

    var body: some View {
        Button { onOpen(image) } label: {
            Color(uiColor: .secondarySystemFill)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else if hasFailed {
                        Image(systemName: item.isVideo ? "video" : "photo")
                            .foregroundStyle(.secondary)
                    }
                }
                .overlay(alignment: .bottomLeading) {
                    if item.isVideo {
                        Image(systemName: "play.fill")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .shadow(color: .black.opacity(0.45), radius: 2)
                            .padding(6)
                    }
                }
                .clipped()
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .task(id: item.attachment.id) { await loadImage() }
        .accessibilityLabel(item.isVideo ? "Video" : "Photo")
    }

    private func loadImage() async {
        if let preview = await model.prepareAttachmentPreviewImage(item.attachment) {
            image = preview
            return
        }
        guard !item.isVideo, let url = await model.prepareAttachmentForPresentation(item.attachment) else {
            hasFailed = !Task.isCancelled
            return
        }
        let loaded = await Task.detached(priority: .utility) { UIImage(contentsOfFile: url.path) }.value
        guard !Task.isCancelled else { return }
        image = loaded
        hasFailed = loaded == nil
    }
}

/// Document icon, file name, "size · date".
struct ContactProfileFileRow: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let item: ContactProfileSharedAttachment
    let day: String
    let isLoading: Bool
    let action: () -> Void

    private var caption: String {
        [item.attachment.sizeLabel, day].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        Button(action: action) {
            ContactProfileSharedRowLayout(title: item.attachment.name, caption: caption) {
                Image(systemName: "doc")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(chatTheme.accent)
                    .frame(width: ContactProfileSharedRowMetrics.leadSize, height: ContactProfileSharedRowMetrics.leadSize)
                    .background(chatTheme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            } trailing: {
                if isLoading { ProgressView() }
            }
        }
        .buttonStyle(.plain)
    }
}

/// Domain letter, link title or URL, domain, and the date on the right.
struct ContactProfileLinkRow: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let link: ContactProfileSharedLink
    let day: String
    let action: () -> Void
    @State private var fetchedTitle: String?

    var body: some View {
        Button(action: action) {
            ContactProfileSharedRowLayout(
                title: link.title ?? fetchedTitle ?? link.displayURL,
                caption: link.domain,
                captionColor: chatTheme.accent
            ) {
                Text(link.domain.prefix(1).uppercased())
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: ContactProfileSharedRowMetrics.leadSize, height: ContactProfileSharedRowMetrics.leadSize)
                    .background(Self.tint(for: link.domain), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            } trailing: {
                Text(day)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(height: ContactProfileSharedRowMetrics.leadSize, alignment: .top)
                    .padding(.top, 2)
            }
        }
        .buttonStyle(.plain)
        .task(id: link.id) {
            guard link.title == nil else { return }
            fetchedTitle = await LinkPreviewMetadataCache.shared.metadata(for: link.url).metadata?.title?.nonEmpty
        }
    }

    private static let palette: [Color] = [
        Color(red: 0.69, green: 0.25, blue: 0.24), Color(red: 0.18, green: 0.44, blue: 0.56),
        Color(red: 0.29, green: 0.29, blue: 0.32), Color(red: 0.79, green: 0.60, blue: 0.18),
        Color(red: 0.54, green: 0.36, blue: 0.76), Color(red: 0.23, green: 0.49, blue: 0.36),
        Color(red: 0.18, green: 0.36, blue: 0.54), Color(red: 0.17, green: 0.47, blue: 0.72),
    ]

    /// A stable colour per domain.
    static func tint(for domain: String) -> Color {
        let sum = domain.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        return palette[sum % palette.count]
    }
}

/// Leading square, title over caption, optional trailing view: the flat row
/// shared by the Files and Links pages.
struct ContactProfileSharedRowLayout<Leading: View, Trailing: View>: View {
    let title: String
    let caption: String
    var captionColor: Color = .secondary
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            leading
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text(caption)
                    .font(.footnote)
                    .foregroundStyle(captionColor)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(.leading, ContactProfileMetrics.gutter)
        .padding(.trailing, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 60)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
