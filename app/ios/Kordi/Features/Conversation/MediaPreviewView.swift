import SwiftUI
import UIKit

struct ConversationMediaItem: Identifiable, Equatable {
    let id: String
    let messageID: String
    let attachment: ChatAttachment
    let senderName: String
    let sentAt: Date
}

enum ConversationMediaGallery {
    static func items(in messages: [ChatMessage]) -> [ConversationMediaItem] {
        messages.flatMap { message in
            message.attachments.compactMap { attachment in
                guard attachment.kind == .image else { return nil }
                return ConversationMediaItem(
                    id: "\(message.id):\(attachment.id)",
                    messageID: message.id,
                    attachment: attachment,
                    senderName: message.author == .me ? "You" : message.authorName,
                    sentAt: message.createdAt
                )
            }
        }
    }
}

struct MediaPreviewPresentation: Identifiable {
    let items: [ConversationMediaItem]
    let initialItemID: ConversationMediaItem.ID
    let initialImage: UIImage?

    var id: ConversationMediaItem.ID { initialItemID }

    static func make(
        opening attachment: ChatAttachment,
        from message: ChatMessage,
        in messages: [ChatMessage],
        initialImage: UIImage?
    ) -> MediaPreviewPresentation? {
        let items = ConversationMediaGallery.items(in: messages)
        guard let selected = items.first(where: {
            $0.messageID == message.id && $0.attachment.id == attachment.id
        }) else { return nil }
        return MediaPreviewPresentation(
            items: items,
            initialItemID: selected.id,
            initialImage: initialImage
        )
    }
}

enum MediaPreviewDismissal {
    static func verticalOffset(for translation: CGSize) -> CGFloat {
        guard translation.height > 0,
              abs(translation.height) > abs(translation.width) * 1.1 else { return 0 }
        return translation.height
    }

    static func shouldDismiss(
        translation: CGSize,
        predictedEndTranslation: CGSize,
        viewportHeight: CGFloat
    ) -> Bool {
        let distance = verticalOffset(for: translation)
        guard distance > 0 else { return false }
        let projectedDistance = verticalOffset(for: predictedEndTranslation)
        let threshold = max(96, min(viewportHeight * 0.18, 180))
        return distance >= threshold || projectedDistance >= threshold * 1.35
    }
}

struct MediaPreviewView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let presentation: MediaPreviewPresentation

    @State private var selectedItemID: ConversationMediaItem.ID
    @State private var dismissalOffset: CGFloat = 0
    @State private var shareItem: SharedFileItem?
    @State private var sharingItemID: ConversationMediaItem.ID?

    init(presentation: MediaPreviewPresentation) {
        self.presentation = presentation
        _selectedItemID = State(initialValue: presentation.initialItemID)
    }

    var body: some View {
        GeometryReader { viewport in
            ZStack {
                Color.black
                    .opacity(backgroundOpacity)
                    .ignoresSafeArea()

                if presentation.items.isEmpty {
                    ContentUnavailableView(
                        "Image unavailable",
                        systemImage: "photo.badge.exclamationmark",
                        description: Text("Close the preview and try opening the image again.")
                    )
                    .foregroundStyle(.white)
                } else {
                    TabView(selection: $selectedItemID) {
                        ForEach(presentation.items) { item in
                            MediaPreviewPage(
                                item: item,
                                initialImage: item.id == presentation.initialItemID
                                    ? presentation.initialImage
                                    : nil
                            )
                            .tag(item.id)
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                    .offset(y: dismissalOffset)
                    .scaleEffect(contentScale)
                    .accessibilityValue(pageAccessibilityValue)
                    .accessibilityAdjustableAction(moveSelection)
                }
            }
            .overlay(alignment: .top) {
                MediaPreviewHeader(
                    item: currentItem,
                    onClose: dismiss.callAsFunction,
                    onShare: shareCurrentItem
                )
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .opacity(chromeOpacity)
            }
            .overlay(alignment: .bottom) {
                MediaPreviewFooter(
                    currentPage: currentIndex + 1,
                    totalPages: presentation.items.count,
                    isSharing: sharingItemID == selectedItemID,
                    onShare: shareCurrentItem
                )
                .padding(.horizontal, 18)
                .padding(.bottom, 10)
                .opacity(chromeOpacity)
            }
            .contentShape(Rectangle())
            .simultaneousGesture(dismissalGesture(viewportHeight: viewport.size.height))
        }
        .presentationBackground(.clear)
        .preferredColorScheme(.dark)
        .statusBarHidden(false)
        .sensoryFeedback(.selection, trigger: selectedItemID)
        .sheet(item: $shareItem) { item in
            ActivityShareSheet(items: [item.url])
        }
        .accessibilityAction(.escape, dismiss.callAsFunction)
    }

    private var currentItem: ConversationMediaItem? {
        presentation.items.first(where: { $0.id == selectedItemID })
            ?? presentation.items.first
    }

    private var currentIndex: Int {
        presentation.items.firstIndex(where: { $0.id == selectedItemID }) ?? 0
    }

    private var backgroundOpacity: Double {
        max(0.28, 1 - Double(dismissalOffset / 520))
    }

    private var chromeOpacity: Double {
        max(0, 1 - Double(dismissalOffset / 180))
    }

    private var contentScale: CGFloat {
        guard !reduceMotion else { return 1 }
        return max(0.92, 1 - dismissalOffset / 1_800)
    }

    private var pageAccessibilityValue: String {
        "Image \(currentIndex + 1) of \(presentation.items.count)"
    }

    private func dismissalGesture(viewportHeight: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                dismissalOffset = MediaPreviewDismissal.verticalOffset(for: value.translation)
            }
            .onEnded { value in
                if MediaPreviewDismissal.shouldDismiss(
                    translation: value.translation,
                    predictedEndTranslation: value.predictedEndTranslation,
                    viewportHeight: viewportHeight
                ) {
                    dismiss()
                } else {
                    withAnimation(reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.32, dampingFraction: 0.86)) {
                        dismissalOffset = 0
                    }
                }
            }
    }

    private func moveSelection(_ direction: AccessibilityAdjustmentDirection) {
        let nextIndex: Int
        switch direction {
        case .increment:
            nextIndex = min(currentIndex + 1, presentation.items.count - 1)
        case .decrement:
            nextIndex = max(currentIndex - 1, 0)
        @unknown default:
            return
        }
        guard presentation.items.indices.contains(nextIndex) else { return }
        selectedItemID = presentation.items[nextIndex].id
    }

    private func shareCurrentItem() {
        guard let item = currentItem, sharingItemID == nil else { return }
        sharingItemID = item.id
        Task {
            defer { sharingItemID = nil }
            guard let url = await model.prepareAttachmentForSharing(item.attachment) else { return }
            shareItem = SharedFileItem(url: url)
        }
    }
}

private struct MediaPreviewHeader: View {
    let item: ConversationMediaItem?
    let onClose: () -> Void
    let onShare: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            MediaPreviewCircleButton(
                systemImage: "chevron.backward",
                accessibilityLabel: "Close image preview",
                action: onClose
            )

            Spacer(minLength: 0)

            if let item {
                VStack(spacing: 1) {
                    Text(item.senderName)
                        .font(.headline)
                        .lineLimit(1)
                    Text(item.sentAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 7)
                .frame(maxWidth: 240)
                .background(.ultraThinMaterial, in: Capsule())
                .accessibilityElement(children: .combine)
            }

            Spacer(minLength: 0)

            Menu {
                Button(action: onShare) {
                    Label("Share or Save", systemImage: "square.and.arrow.up")
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(.ultraThinMaterial, in: Circle())
                    .contentShape(Circle())
            }
            .accessibilityLabel("More image actions")
        }
    }
}

private struct MediaPreviewFooter: View {
    let currentPage: Int
    let totalPages: Int
    let isSharing: Bool
    let onShare: () -> Void

    var body: some View {
        HStack {
            Button(action: onShare) {
                Group {
                    if isSharing {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Image(systemName: "square.and.arrow.up")
                            .font(.title3.weight(.medium))
                    }
                }
                .frame(width: 52, height: 52)
                .background(.ultraThinMaterial, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(isSharing)
            .accessibilityLabel(isSharing ? "Preparing image" : "Share or save image")

            Spacer(minLength: 0)

            Text("\(currentPage) of \(totalPages)")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(.ultraThinMaterial, in: Capsule())
                .accessibilityLabel("Image \(currentPage) of \(totalPages)")

            Spacer(minLength: 0)

            Color.clear
                .frame(width: 52, height: 52)
                .accessibilityHidden(true)
        }
    }
}

private struct MediaPreviewCircleButton: View {
    let systemImage: String
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 48, height: 48)
                .background(.ultraThinMaterial, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct MediaPreviewPage: View {
    @EnvironmentObject private var model: AppModel

    let item: ConversationMediaItem

    @State private var image: UIImage?
    @State private var loadFailed = false
    @State private var reloadToken = 0

    init(item: ConversationMediaItem, initialImage: UIImage?) {
        self.item = item
        _image = State(initialValue: initialImage)
    }

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .transition(.opacity)
                    .accessibilityLabel(item.attachment.name)
            } else if loadFailed {
                ContentUnavailableView {
                    Label("Image unavailable", systemImage: "photo.badge.exclamationmark")
                } description: {
                    Text("Check your connection, then try again.")
                } actions: {
                    Button("Try Again") {
                        reloadToken += 1
                    }
                    .buttonStyle(.bordered)
                }
                .foregroundStyle(.white)
            } else {
                ProgressView("Loading image")
                    .tint(.white)
                    .foregroundStyle(.white)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 76)
        .task(id: "\(item.id):\(reloadToken)") {
            await loadImage()
        }
    }

    private func loadImage() async {
        loadFailed = false

        if image == nil,
           let source = item.attachment.previewURL,
           let preview = await AvatarImageLoader.image(from: source) {
            guard !Task.isCancelled else { return }
            image = preview
        }

        if item.attachment.previewURL?.lowercased().hasPrefix("data:image/") == true {
            loadFailed = image == nil
            return
        }

        guard !item.attachment.attachmentId.hasPrefix("pending:"),
              let url = await model.prepareAttachmentForPresentation(item.attachment) else {
            guard !Task.isCancelled else { return }
            loadFailed = image == nil
            return
        }

        let fullImage = await Task.detached(priority: .userInitiated) {
            AttachmentImageDecoder.downsampledImage(at: url, maximumPixelSize: 4_096)
        }.value
        guard !Task.isCancelled else { return }
        if let fullImage {
            image = fullImage
        }
        loadFailed = image == nil
    }
}
