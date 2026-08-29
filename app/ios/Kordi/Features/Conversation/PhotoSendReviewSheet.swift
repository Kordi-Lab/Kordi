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
    @Environment(\.dismiss) private var dismiss
    let allowsSeparateMessages: Bool
    let onSend: ([PendingAttachment], PhotoSendGrouping) async -> Bool
    let onError: (String) -> Void

    @State private var authorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @State private var assets: [PHAsset] = []
    @State private var selectedAssetIDs: [String] = []
    @State private var editedPhotos: [String: PhotoLibraryEdit] = [:]
    @State private var editingRequest: PhotoEditorRequest?
    @State private var grouping: PhotoSendGrouping = .combined
    @State private var isSending = false

    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: 2),
        count: 4
    )

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
                    ProgressView("Loading photos")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        .interactiveDismissDisabled(isSending)
        .fullScreenCover(item: $editingRequest) { request in
            PhotoLibraryImageEditor(
                asset: request.asset,
                edit: $editedPhotos[request.id]
            )
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
                Button("Close", systemImage: "xmark") {
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

    private var photoGrid: some View {
        Group {
            if assets.isEmpty {
                ContentUnavailableView(
                    "No photos",
                    systemImage: "photo.on.rectangle.angled",
                    description: Text("Photos in your library will appear here.")
                )
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 2) {
                        ForEach(assets, id: \.localIdentifier) { asset in
                            photoCell(asset)
                        }
                    }
                }
            }
        }
    }

    private func photoCell(_ asset: PHAsset) -> some View {
        let selectionIndex = selectedAssetIDs.firstIndex(of: asset.localIdentifier)
        return Button {
            selectedAssetIDs = PhotoLibrarySelection.toggling(
                asset.localIdentifier,
                in: selectedAssetIDs
            )
        } label: {
            PhotoLibraryThumbnail(
                asset: asset,
                editedImage: editedPhotos[asset.localIdentifier]?.image
            )
                .overlay(alignment: .topTrailing) {
                    ZStack {
                        Circle()
                            .fill(selectionIndex == nil ? .black.opacity(0.24) : KordiTheme.signalBlue)
                        Circle()
                            .stroke(.white, lineWidth: 2)
                        if let selectionIndex {
                            Text("\(selectionIndex + 1)")
                                .font(.caption.bold())
                                .foregroundStyle(.white)
                        }
                    }
                    .frame(width: 27, height: 27)
                    .padding(6)
                }
                .overlay {
                    if selectionIndex != nil {
                        Rectangle()
                            .stroke(KordiTheme.signalBlue, lineWidth: 3)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Photo")
        .accessibilityValue(selectionIndex.map { "Selected \($0 + 1)" } ?? "Not selected")
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

    private var sendBar: some View {
        VStack(spacing: 0) {
            Divider()
            if allowsSeparateMessages, selectedAssetIDs.count > 1 {
                Button {
                    grouping = grouping == .combined ? .separate : .combined
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: grouping == .combined ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(grouping == .combined ? KordiTheme.signalBlue : .secondary)
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
                Spacer(minLength: 8)
                Button("Edit", systemImage: "pencil") {
                    beginEditingSelection()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(KordiTheme.signalBlue)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
                .buttonStyle(.plain)
                .opacity(selectedAssetIDs.isEmpty ? 0 : 1)
                .disabled(selectedAssetIDs.isEmpty || isSending)
                .accessibilityHidden(selectedAssetIDs.isEmpty)
                .accessibilityHint("Edits the most recently selected photo")
                Spacer(minLength: 8)
                Button {
                    sendSelection()
                } label: {
                    Text("Send (\(selectedAssetIDs.count))")
                        .fontWeight(.semibold)
                        .padding(.horizontal, 18)
                        .frame(minHeight: 44)
                        .foregroundStyle(.white)
                        .background(
                            selectedAssetIDs.isEmpty
                                ? Color(uiColor: .tertiarySystemFill)
                                : KordiTheme.signalBlue,
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
              let asset = assets.first(where: { $0.localIdentifier == id }) else { return }
        editingRequest = PhotoEditorRequest(asset: asset)
    }

    @MainActor
    private func loadLibrary() async {
        if authorizationStatus == .notDetermined {
            authorizationStatus = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        guard authorizationStatus == .authorized || authorizationStatus == .limited else { return }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: .image, options: options)
        var fetched: [PHAsset] = []
        fetched.reserveCapacity(result.count)
        result.enumerateObjects { asset, _, _ in
            fetched.append(asset)
        }
        assets = fetched
        if ProcessInfo.processInfo.arguments.contains("--preview-photo-send"),
           selectedAssetIDs.isEmpty {
            selectedAssetIDs = fetched.prefix(4).map(\.localIdentifier)
        }
    }

    @MainActor
    private func sendSelection() {
        guard !selectedAssetIDs.isEmpty, !isSending else { return }
        isSending = true
        let selectedAssets = selectedAssetIDs.compactMap { id in
            assets.first(where: { $0.localIdentifier == id })
        }
        let batches = PhotoSelectionPreparationPlan.batches(
            for: selectedAssets,
            grouping: grouping
        )
        let selectedEdits = editedPhotos.filter { selectedAssetIDs.contains($0.key) }
        dismiss()
        Task {
            await Task.yield()
            do {
                for batch in batches {
                    let attachments = try await PhotoLibraryAttachmentLoader.load(
                        batch,
                        edits: selectedEdits
                    )
                    guard await onSend(attachments, grouping) else { return }
                }
            } catch {
                onError(error.localizedDescription)
            }
        }
    }
}

private struct PhotoLibraryThumbnail: View {
    private static let imageManager = PHCachingImageManager()

    let asset: PHAsset
    let editedImage: UIImage?
    @State private var image: UIImage?
    @State private var requestID = PHInvalidImageRequestID

    var body: some View {
        Rectangle()
            .fill(Color(uiColor: .secondarySystemFill))
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let displayImage = editedImage ?? image {
                    Image(uiImage: displayImage)
                        .resizable()
                        .scaledToFill()
                }
            }
            .clipped()
            .onAppear(perform: requestImage)
            .onDisappear {
                Self.imageManager.cancelImageRequest(requestID)
            }
    }

    private func requestImage() {
        guard image == nil, editedImage == nil else { return }
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        requestID = Self.imageManager.requestImage(
            for: asset,
            targetSize: CGSize(width: 320, height: 320),
            contentMode: .aspectFill,
            options: options
        ) { result, _ in
            guard let result else { return }
            Task { @MainActor in image = result }
        }
    }
}

enum PhotoLibraryAttachmentLoader {
    static func load(
        _ assets: [PHAsset],
        edits: [String: PhotoLibraryEdit] = [:]
    ) async throws -> [PendingAttachment] {
        var attachments: [PendingAttachment] = []
        attachments.reserveCapacity(assets.count)
        for (index, asset) in assets.enumerated() {
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
            Color.black
            if let preview = AttachmentPreviewDataURL.decode(attachment.previewURL),
               let image = UIImage(data: preview) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .accessibilityHidden(true)
            }
            if let player {
                VideoPlayer(player: player)
            } else if playbackFailed {
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
                    player == nil ? Color(uiColor: .tertiarySystemFill) : KordiTheme.signalBlue,
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
            }
            .buttonStyle(.plain)
            .disabled(player == nil || isSending)
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
}
