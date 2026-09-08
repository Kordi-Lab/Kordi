import Photos
import SwiftUI
import UIKit

struct ConversationMediaItem: Identifiable, Equatable {
    let id: String
    let messageID: String
    var attachment: ChatAttachment
    let conversationID: String
    let clientMessageID: String?
    let attachmentIndex: Int
    let senderName: String
    let sentAt: Date

    func updated(in messages: [ChatMessage]) -> Self {
        guard let message = messages.first(where: {
            $0.id == messageID || (clientMessageID != nil && $0.clientMessageId == clientMessageID)
        }), message.attachments.indices.contains(attachmentIndex) else { return self }
        var updated = self
        updated.attachment = message.attachments[attachmentIndex]
        return updated
    }
}

enum ConversationMediaGallery {
    static func items(in messages: [ChatMessage]) -> [ConversationMediaItem] {
        messages.flatMap { message in
            message.attachments.enumerated().compactMap { index, attachment in
                guard attachment.kind == .image else { return nil }
                return ConversationMediaItem(
                    id: "\(message.id):\(attachment.id)",
                    messageID: message.id,
                    attachment: attachment,
                    conversationID: message.conversationId,
                    clientMessageID: message.clientMessageId,
                    attachmentIndex: index,
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
    @State private var liveShareURLs: [URL] = []
    @State private var showLiveShare = false
    @State private var sharingItemID: ConversationMediaItem.ID?
    @State private var saving = false
    @State private var saveStatus: String?
    @State private var playback = LivePhotoPlayback()

    init(presentation: MediaPreviewPresentation) {
        self.presentation = presentation
        _selectedItemID = State(initialValue: presentation.initialItemID)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            GeometryReader { viewport in
                TabView(selection: $selectedItemID) {
                    ForEach(presentation.items) { item in
                        MediaPreviewPage(
                            item: item,
                            livePhoto: item.id == selectedItemID ? playback.photo : nil,
                            playRequest: playback.playRequest,
                            initialImage: item.id == presentation.initialItemID ? presentation.initialImage : nil
                        )
                        .tag(item.id)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .frame(width: viewport.size.width, height: viewport.size.height)
                .offset(y: dismissalOffset)
                .clipped()
                .accessibilityAdjustableAction(moveSelection)
                .simultaneousGesture(dismissalGesture(viewportHeight: viewport.size.height))
            }
            footer
        }
        .background { Color.black.ignoresSafeArea() }
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .sensoryFeedback(.selection, trigger: selectedItemID)
        .onChange(of: selectedItemID) { _, _ in playback.reset(); saveStatus = nil }
        .onChange(of: currentItem?.attachment.id) { _, _ in playback.reset() }
        .onDisappear { playback.reset() }
        .sheet(item: $shareItem) { item in ActivityShareSheet(items: [item.url]) }
        .sheet(isPresented: $showLiveShare) { ActivityShareSheet(items: liveShareURLs) }
        .accessibilityAction(.escape, dismiss.callAsFunction)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button("Close image preview", systemImage: "chevron.backward") { dismiss() }
                .labelStyle(.iconOnly).frame(width: 44, height: 44)
            VStack(spacing: 3) {
                Text(currentItem?.senderName ?? "Photo").font(.headline).lineLimit(1)
                if let item = currentItem {
                    Text(item.sentAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
            Menu {
                if currentItem?.attachment.livePhoto != nil {
                    Button("Save Live Photo", systemImage: "square.and.arrow.down", action: saveCurrentItem)
                        .disabled(saving)
                }
                Button("Share or Save", systemImage: "square.and.arrow.up", action: shareCurrentItem)
                    .disabled(sharingItemID != nil)
            } label: {
                Image(systemName: "ellipsis").frame(width: 44, height: 44)
            }
            .accessibilityLabel("More image actions")
        }
        .font(.body.weight(.semibold))
        .buttonStyle(.plain)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .accessibilityIdentifier("media-preview-header")
    }

    private var footer: some View {
        VStack(spacing: 8) {
            if playback.failed {
                Text("Live playback unavailable. Try again.").font(.caption).foregroundStyle(.secondary)
            }
            if let saveStatus { Text(saveStatus).font(.caption).foregroundStyle(.secondary) }
            ZStack {
                Text("\(currentIndex + 1) of \(presentation.items.count)")
                    .font(.caption.weight(.medium)).monospacedDigit().foregroundStyle(.secondary)
                HStack {
                    Button(action: shareCurrentItem) {
                        Group {
                            if sharingItemID != nil { ProgressView().tint(.white) }
                            else { Image(systemName: "square.and.arrow.up").font(.title3) }
                        }
                        .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain).disabled(sharingItemID != nil)
                    .accessibilityLabel("Share or save image")
                    Spacer()
                    if let item = currentItem, item.attachment.livePhoto != nil {
                        LivePhotoPlaybackButton(playback: playback) {
                            let attachment = item.attachment
                            playback.play {
                                guard let urls = await model.prepareLivePhotoURLs(attachment) else { throw AttachmentTransferError.invalidImage }
                                return try await LivePhotoMedia.fromFiles(photo: urls.photo, video: urls.video)
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .accessibilityIdentifier("media-preview-footer")
    }

    private var currentItem: ConversationMediaItem? {
        let item = presentation.items.first(where: { $0.id == selectedItemID }) ?? presentation.items.first
        return item.map { $0.updated(in: model.messagesByConversation[$0.conversationID] ?? []) }
    }
    private var currentIndex: Int { presentation.items.firstIndex(where: { $0.id == selectedItemID }) ?? 0 }

    private func dismissalGesture(viewportHeight: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { dismissalOffset = MediaPreviewDismissal.verticalOffset(for: $0.translation) }
            .onEnded { value in
                if MediaPreviewDismissal.shouldDismiss(translation: value.translation, predictedEndTranslation: value.predictedEndTranslation, viewportHeight: viewportHeight) {
                    dismiss()
                } else {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { dismissalOffset = 0 }
                }
            }
    }

    private func moveSelection(_ direction: AccessibilityAdjustmentDirection) {
        let next = direction == .increment ? currentIndex + 1 : currentIndex - 1
        guard presentation.items.indices.contains(next) else { return }
        selectedItemID = presentation.items[next].id
    }

    private func saveCurrentItem() {
        guard let item = currentItem, !saving else { return }
        saving = true
        Task {
            let saved = await model.saveLivePhoto(item.attachment)
            saving = false
            guard selectedItemID == item.id else { return }
            saveStatus = saved ? "Saved to Photos" : "Could not save Live Photo. Check Photos access and try again."
        }
    }

    private func shareCurrentItem() {
        guard let item = currentItem, sharingItemID == nil else { return }
        sharingItemID = item.id
        Task {
            defer { sharingItemID = nil }
            if item.attachment.livePhoto != nil {
                guard let urls = await model.prepareLivePhotoURLs(item.attachment) else { return }
                liveShareURLs = [urls.photo, urls.video]
                showLiveShare = true
            } else if let url = await model.prepareAttachmentForSharing(item.attachment) {
                shareItem = SharedFileItem(url: url)
            }
        }
    }
}

private struct MediaPreviewPage: View {
    @EnvironmentObject private var model: AppModel
    let item: ConversationMediaItem
    let livePhoto: PHLivePhoto?
    let playRequest: Int
    @State private var image: UIImage?
    @State private var loadFailed = false
    @State private var reloadToken = 0

    init(item: ConversationMediaItem, livePhoto: PHLivePhoto?, playRequest: Int, initialImage: UIImage?) {
        self.item = item
        self.livePhoto = livePhoto
        self.playRequest = playRequest
        _image = State(initialValue: initialImage)
    }
    private var attachment: ChatAttachment { item.updated(in: model.messagesByConversation[item.conversationID] ?? []).attachment }

    var body: some View {
        ZStack {
            LivePhotoImageSurface(image: image, livePhoto: livePhoto, playRequest: playRequest, label: attachment.altText ?? attachment.name)
            if image == nil && livePhoto == nil {
                if loadFailed {
                    ContentUnavailableView {
                        Label("Image unavailable", systemImage: "photo.badge.exclamationmark")
                    } description: {
                        Text("Check your connection, then try again.")
                    } actions: {
                        Button("Try Again") { reloadToken += 1 }.buttonStyle(.bordered)
                    }
                } else { ProgressView("Loading image").tint(.white) }
            }
        }
        .task(id: "\(attachment.id):\(reloadToken)") { await loadImage() }
    }

    private func loadImage() async {
        loadFailed = false
        if image == nil, let source = attachment.previewURL, let preview = await AvatarImageLoader.image(from: source) {
            guard !Task.isCancelled else { return }
            image = preview
        }
        guard let url = await model.prepareAttachmentForSharing(attachment) else {
            guard !Task.isCancelled else { return }
            loadFailed = image == nil
            return
        }
        let fullImage = await Task.detached(priority: .userInitiated) {
            AttachmentImageDecoder.downsampledImage(at: url, maximumPixelSize: 4_096)
        }.value
        guard !Task.isCancelled else { return }
        if let fullImage { image = fullImage }
        loadFailed = image == nil
    }
}
