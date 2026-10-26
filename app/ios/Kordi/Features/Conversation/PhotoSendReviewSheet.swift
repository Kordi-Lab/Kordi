import AVKit
import Foundation
import Photos
import SwiftUI
import UIKit

enum PhotoSendGrouping: Equatable {
    case combined
    case separate
}

enum PhotoLibrarySelection {
    static func toggling(_ id: String, in selectedIDs: [String]) -> [String] {
        if selectedIDs.contains(id) {
            return selectedIDs.filter { $0 != id }
        }
        return selectedIDs + [id]
    }

    static func editingID(in selectedIDs: [String]) -> String? {
        selectedIDs.last
    }
}

enum PhotoSelectionPreparationPlan {
    static func batches<Element>(
        for selection: [Element],
        grouping: PhotoSendGrouping
    ) -> [[Element]] {
        guard grouping == .separate else {
            return selection.isEmpty ? [] : [selection]
        }
        return selection.map { [$0] }
    }
}

private struct PhotoEditorRequest: Identifiable {
    let asset: PHAsset
    var id: String { asset.localIdentifier }
}

struct PhotoLibrarySendPicker: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let allowsSeparateMessages: Bool
    let onSend: ([PendingAttachment], PhotoSendGrouping) async -> Bool
    let onError: (String) -> Void
    let onClose: () -> Void

    @State private var authorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @State private var library: PhotoLibraryAssets?
    @State private var selectedAssetIDs: [String] = []
    @State private var editedPhotos: [String: PhotoLibraryEdit] = [:]
    @State private var editingRequest: PhotoEditorRequest?
    @State private var liveEditRequest: PhotoEditorRequest?
    @State private var stillOnlyIDs: Set<String> = []
    @State private var previewIndex: Int?
    @State private var grouping: PhotoSendGrouping = .combined
    @State private var isSending = false

    var body: some View {
        VStack(spacing: 0) {
            pickerHeader
            Group {
                switch authorizationStatus {
                case .authorized, .limited:
                    photoGrid
                case .denied, .restricted:
                    deniedAccessView
                case .notDetermined:
                    Color(uiColor: .systemBackground)
                @unknown default:
                    deniedAccessView
                }
            }
            .background(Color(uiColor: .systemBackground))
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if authorizationStatus == .authorized || authorizationStatus == .limited {
                sendBar
            }
        }
        .animation(.snappy(duration: 0.22), value: showsGroupingOption)
        .overlay {
            if let library, let previewIndex {
                PhotoLibraryPreview(
                    library: library,
                    index: Binding(get: { previewIndex }, set: { self.previewIndex = $0 }),
                    selectedIDs: $selectedAssetIDs,
                    stillOnlyIDs: $stillOnlyIDs,
                    editedImages: editedPhotos.mapValues(\.image),
                    isSending: isSending,
                    onEdit: beginEditing,
                    onSend: sendSelection(fallbackID:),
                    onClose: { self.previewIndex = nil }
                )
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.18), value: previewIndex == nil)
        .statusBarHidden(previewIndex != nil)
        .fullScreenCover(item: $editingRequest) { request in
            PhotoLibraryImageEditor(asset: request.asset, edit: editBinding(for: request.id))
        }
        .confirmationDialog(
            "Editing will send this Live Photo as a still image.",
            isPresented: Binding(get: { liveEditRequest != nil }, set: { if !$0 { liveEditRequest = nil } }),
            titleVisibility: .visible,
            presenting: liveEditRequest
        ) { request in
            Button("Edit and send still image") {
                stillOnlyIDs.insert(request.id)
                editingRequest = request
            }
        }
        .task {
            await loadLibrary()
        }
    }

    private var pickerHeader: some View {
        ZStack {
            Text("Recents")
                .font(.headline)
            HStack {
                Button("Close", systemImage: "xmark", action: onClose)
                    .labelStyle(.iconOnly)
                    .font(.title3)
                    .foregroundStyle(.primary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                    .disabled(isSending)
                Spacer()
            }
        }
        .frame(height: 54)
        .padding(.horizontal, 8)
        .background(.bar)
    }

    @ViewBuilder
    private var photoGrid: some View {
        if let library {
            if library.count == 0 {
                ContentUnavailableView(
                    "No photos",
                    systemImage: "photo.on.rectangle.angled",
                    description: Text("Photos in your library will appear here.")
                )
            } else {
                PhotoLibraryGrid(
                    library: library,
                    selectedIDs: selectedAssetIDs,
                    editedImages: editedPhotos.mapValues(\.image),
                    stillOnlyIDs: stillOnlyIDs,
                    accent: chatTheme.accent,
                    onSelectionChange: { selectedAssetIDs = $0 },
                    onToggleLive: { id in
                        guard editedPhotos[id] == nil else { return } // Edits are always sent as stills.
                        if stillOnlyIDs.remove(id) == nil { stillOnlyIDs.insert(id) }
                    },
                    onOpen: { previewIndex = $0 }
                )
            }
        } else {
            Color(uiColor: .systemBackground)
        }
    }

    private var deniedAccessView: some View {
        ContentUnavailableView {
            Label("Photo access is off", systemImage: "photo.on.rectangle.angled")
        } description: {
            Text("Allow Kordi to view your photo library in Settings.")
        } actions: {
            Button("Open Settings") {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(url)
            }
        }
    }

    private var showsGroupingOption: Bool {
        allowsSeparateMessages && selectedAssetIDs.count > 1
    }

    private var sendBar: some View {
        VStack(spacing: 0) {
            Divider()
            if showsGroupingOption {
                Button {
                    grouping = grouping == .combined ? .separate : .combined
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: grouping == .combined ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(grouping == .combined ? chatTheme.accent : .secondary)
                        Text("Send photos as one grouped message")
                            .font(.body.weight(.medium))
                            .foregroundStyle(.primary)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 18)
                .frame(minHeight: 52)
            }
            HStack(spacing: 12) {
                Text(selectedAssetIDs.isEmpty ? "Select photos" : "\(selectedAssetIDs.count) selected")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                Spacer(minLength: 8)
                Button("Edit", systemImage: "pencil") {
                    beginEditingSelection()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(chatTheme.accent)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
                .buttonStyle(.plain)
                .opacity(selectedAssetIDs.isEmpty ? 0 : 1)
                .disabled(selectedAssetIDs.isEmpty || isSending)
                .accessibilityHidden(selectedAssetIDs.isEmpty)
                .accessibilityHint("Edits the most recently selected photo")
                Spacer(minLength: 8)
                Button {
                    sendSelection(fallbackID: nil)
                } label: {
                    Text("Send (\(selectedAssetIDs.count))")
                        .fontWeight(.semibold)
                        .padding(.horizontal, 18)
                        .frame(minHeight: 44)
                        .foregroundStyle(.white)
                        .background(
                            selectedAssetIDs.isEmpty
                                ? Color(uiColor: .tertiarySystemFill)
                                : chatTheme.accent,
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                }
                .buttonStyle(.plain)
                .disabled(selectedAssetIDs.isEmpty || isSending)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
        }
        .background(.bar)
    }

    @MainActor
    private func beginEditingSelection() {
        guard let id = PhotoLibrarySelection.editingID(in: selectedAssetIDs),
              let asset = PhotoLibraryAssets.assets(for: [id]).first else { return }
        beginEditing(asset)
    }

    @MainActor
    private func beginEditing(_ asset: PHAsset) {
        let request = PhotoEditorRequest(asset: asset)
        if asset.mediaSubtypes.contains(.photoLive), !stillOnlyIDs.contains(request.id) {
            liveEditRequest = request
        } else {
            editingRequest = request
        }
    }

    /// Saving an edit also selects the photo, as in Photos and Telegram.
    private func editBinding(for id: String) -> Binding<PhotoLibraryEdit?> {
        Binding(
            get: { editedPhotos[id] },
            set: { edit in
                editedPhotos[id] = edit
                if edit != nil, !selectedAssetIDs.contains(id) { selectedAssetIDs.append(id) }
            }
        )
    }

    @MainActor
    private func loadLibrary() async {
        if authorizationStatus == .notDetermined {
            authorizationStatus = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        guard authorizationStatus == .authorized || authorizationStatus == .limited, library == nil else { return }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        // The fetch result is lazy; only visible photos are read.
        let loaded = PhotoLibraryAssets(fetchResult: PHAsset.fetchAssets(with: .image, options: options))
        library = loaded
        if ProcessInfo.processInfo.arguments.contains("--preview-photo-send"),
           selectedAssetIDs.isEmpty {
            selectedAssetIDs = (0..<min(4, loaded.count)).compactMap(loaded.id(at:))
        }
    }

    /// The preview sends the photo on screen when nothing is selected.
    @MainActor
    private func sendSelection(fallbackID: String?) {
        let ids = selectedAssetIDs.isEmpty ? [fallbackID].compactMap { $0 } : selectedAssetIDs
        guard !ids.isEmpty, !isSending else { return }
        isSending = true
        let selectedAssets = PhotoLibraryAssets.assets(for: ids)
        let batches = PhotoSelectionPreparationPlan.batches(
            for: selectedAssets,
            grouping: grouping
        )
        let selectedEdits = editedPhotos.filter { ids.contains($0.key) }
        let stillOnly = stillOnlyIDs
        onClose()
        Task {
            await Task.yield()
            do {
                for batch in batches {
                    let attachments = try await PhotoLibraryAttachmentLoader.load(
                        batch,
                        edits: selectedEdits,
                        stillOnlyIDs: stillOnly
                    )
                    guard await onSend(attachments, grouping) else { return }
                }
            } catch {
                onError(error.localizedDescription)
            }
        }
    }
}

enum PhotoLibraryAttachmentLoader {
    static func load(
        _ assets: [PHAsset],
        edits: [String: PhotoLibraryEdit] = [:],
        stillOnlyIDs: Set<String> = []
    ) async throws -> [PendingAttachment] {
        var attachments: [PendingAttachment] = []
        attachments.reserveCapacity(assets.count)
        var succeeded = false
        defer { if !succeeded { attachments.forEach { $0.discardOwnedFile() } } }
        for (index, asset) in assets.enumerated() {
            if asset.mediaSubtypes.contains(.photoLive), !stillOnlyIDs.contains(asset.localIdentifier) {
                guard edits[asset.localIdentifier] == nil else { throw AttachmentTransferError.invalidImage }
                attachments.append(try await LivePhotoMedia.load(asset))
                continue
            }
            let edit = edits[asset.localIdentifier]
            let data: Data
            let originalName: String
            if let edit {
                data = edit.data
                originalName = edit.suggestedName
            } else {
                data = try await imageData(for: asset)
                originalName = PHAssetResource.assetResources(for: asset).first?.originalFilename
                    ?? "Photo-\(index + 1).jpg"
            }
            let attachment = try await Task.detached(priority: .userInitiated) {
                try PendingAttachmentLoader.loadImage(data: data, suggestedName: originalName)
            }.value
            attachments.append(attachment)
        }
        succeeded = true
        return attachments
    }

    static func imageData(for asset: PHAsset) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.version = .current
            options.isNetworkAccessAllowed = true
            PHImageManager.default().requestImageDataAndOrientation(
                for: asset,
                options: options
            ) { data, _, _, info in
                if let error = info?[PHImageErrorKey] as? Error {
                    continuation.resume(throwing: error)
                } else if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: AttachmentTransferError.invalidImage)
                }
            }
        }
    }
}

enum OutgoingAttachmentGroupingPlan {
    static func batches(
        for attachments: [PendingAttachment],
        photoGrouping: PhotoSendGrouping
    ) -> [[PendingAttachment]] {
        let images = attachments.filter { $0.kind == .image }
        guard photoGrouping == .separate, images.count > 1 else {
            return attachments.isEmpty ? [] : [attachments]
        }

        var batches = images.map { [$0] }
        let otherAttachments = attachments.filter { $0.kind != .image }
        if !otherAttachments.isEmpty {
            batches[0].append(contentsOf: otherAttachments)
        }
        return batches
    }
}

struct VideoSendReviewSheet: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.dismiss) private var dismiss

    let attachment: PendingAttachment
    let onCancel: () -> Void
    let onSend: () async -> Bool

    @State private var player: AVPlayer?
    @State private var playbackFailed = false
    @State private var isSending = false

    var body: some View {
        VStack(spacing: 0) {
            header
            videoSurface
                .frame(maxHeight: .infinity)
            sendBar
        }
        .background(Color(uiColor: .systemBackground))
        .interactiveDismissDisabled()
        .task(id: attachment.id) {
            guard let fileURL = attachment.fileURL else {
                playbackFailed = true
                return
            }
            let asset = AVURLAsset(url: fileURL)
            guard (try? await asset.load(.isPlayable)) == true else {
                playbackFailed = true
                return
            }
            player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        }
        .onDisappear { player?.pause() }
    }

    private var header: some View {
        ZStack {
            Text("Review video")
                .font(.headline)
            HStack {
                Button("Close", systemImage: "xmark") {
                    onCancel()
                    dismiss()
                }
                .labelStyle(.iconOnly)
                .font(.title3)
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
                .disabled(isSending)
                Spacer()
            }
        }
        .frame(height: 54)
        .padding(.horizontal, 8)
        .background(.bar)
    }

    private var videoSurface: some View {
        ZStack {
            Color(uiColor: .secondarySystemBackground)
            if let previewImage {
                Image(uiImage: previewImage)
                    .resizable()
                    .scaledToFit()
                    .accessibilityHidden(true)
            }
            if let player {
                VideoPlayer(player: player)
            } else if playbackFailed || previewImage == nil {
                ContentUnavailableView(
                    "Video unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text("Choose another MP4 file.")
                )
                .foregroundStyle(.white)
            } else {
                ProgressView("Preparing video")
                    .tint(.white)
                    .foregroundStyle(.white)
            }
        }
        .aspectRatio(videoAspectRatio, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }

    private var sendBar: some View {
        HStack(spacing: 12) {
            Text(attachment.sizeBytes, format: .byteCount(style: .file))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button {
                isSending = true
                Task {
                    if await onSend() {
                        dismiss()
                    } else {
                        isSending = false
                    }
                }
            } label: {
                Group {
                    if isSending {
                        ProgressView().tint(.white)
                    } else {
                        Text("Send video").fontWeight(.semibold)
                    }
                }
                .padding(.horizontal, 18)
                .frame(minWidth: 116, minHeight: 44)
                .foregroundStyle(.white)
                .background(
                    player == nil || previewImage == nil
                        ? Color(uiColor: .tertiarySystemFill)
                        : chatTheme.accent,
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
            }
            .buttonStyle(.plain)
            .disabled(player == nil || previewImage == nil || isSending)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var videoAspectRatio: CGFloat {
        VideoAttachmentLayout.aspectRatio(
            widthPixels: attachment.widthPixels,
            heightPixels: attachment.heightPixels
        )
    }

    private var previewImage: UIImage? {
        AttachmentPreviewDataURL.decode(attachment.previewURL).flatMap(UIImage.init(data:))
    }
}
