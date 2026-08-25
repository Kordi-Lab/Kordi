import Foundation
import ImageIO
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

struct PhotoLibraryEdit {
    let image: UIImage
    let data: Data
    let suggestedName: String
}

struct PhotoEditorStroke: Identifiable, Equatable {
    let id = UUID()
    var points: [CGPoint]
}

enum PhotoEditorCropCorner {
    case topLeading
    case topTrailing
    case bottomLeading
    case bottomTrailing
}

enum PhotoEditorCrop {
    static let full = CGRect(x: 0, y: 0, width: 1, height: 1)
    static let minimumSide: CGFloat = 0.12

    static func moved(_ rect: CGRect, translation: CGSize, canvasSize: CGSize) -> CGRect {
        guard canvasSize.width > 0, canvasSize.height > 0 else { return rect }
        return CGRect(
            x: min(max(0, rect.minX + translation.width / canvasSize.width), 1 - rect.width),
            y: min(max(0, rect.minY + translation.height / canvasSize.height), 1 - rect.height),
            width: rect.width,
            height: rect.height
        )
    }

    static func resized(
        _ rect: CGRect,
        corner: PhotoEditorCropCorner,
        translation: CGSize,
        canvasSize: CGSize
    ) -> CGRect {
        guard canvasSize.width > 0, canvasSize.height > 0 else { return rect }
        let dx = translation.width / canvasSize.width
        let dy = translation.height / canvasSize.height
        var minX = rect.minX
        var minY = rect.minY
        var maxX = rect.maxX
        var maxY = rect.maxY
        switch corner {
        case .topLeading:
            minX = min(max(0, minX + dx), maxX - minimumSide)
            minY = min(max(0, minY + dy), maxY - minimumSide)
        case .topTrailing:
            maxX = max(min(1, maxX + dx), minX + minimumSide)
            minY = min(max(0, minY + dy), maxY - minimumSide)
        case .bottomLeading:
            minX = min(max(0, minX + dx), maxX - minimumSide)
            maxY = max(min(1, maxY + dy), minY + minimumSide)
        case .bottomTrailing:
            maxX = max(min(1, maxX + dx), minX + minimumSide)
            maxY = max(min(1, maxY + dy), minY + minimumSide)
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
}

enum PhotoEditorRenderer {
    static func downsampledImage(data: Data, maximumPixelSize: CGFloat = 4_096) -> UIImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: image)
    }

    static func applying(_ strokes: [PhotoEditorStroke], to image: UIImage) -> UIImage {
        guard !strokes.isEmpty else { return image }
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = 1
        return UIGraphicsImageRenderer(size: image.size, format: format).image { context in
            UIColor.white.setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: image.size))
            image.draw(in: CGRect(origin: .zero, size: image.size))

            let cgContext = context.cgContext
            cgContext.setStrokeColor(UIColor.systemRed.cgColor)
            cgContext.setFillColor(UIColor.systemRed.cgColor)
            cgContext.setLineCap(.round)
            cgContext.setLineJoin(.round)
            let lineWidth = max(3, min(image.size.width, image.size.height) * 0.006)
            cgContext.setLineWidth(lineWidth)
            for stroke in strokes where !stroke.points.isEmpty {
                let points = stroke.points.map {
                    CGPoint(x: $0.x * image.size.width, y: $0.y * image.size.height)
                }
                if points.count == 1, let point = points.first {
                    let radius = lineWidth / 2
                    cgContext.fillEllipse(
                        in: CGRect(
                            x: point.x - radius,
                            y: point.y - radius,
                            width: radius * 2,
                            height: radius * 2
                        )
                    )
                    continue
                }
                cgContext.beginPath()
                cgContext.move(to: points[0])
                for point in points.dropFirst() {
                    cgContext.addLine(to: point)
                }
                cgContext.strokePath()
            }
        }
    }

    static func rotatedClockwise(_ image: UIImage) -> UIImage {
        let size = CGSize(width: image.size.height, height: image.size.width)
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: size))
            context.cgContext.translateBy(x: size.width / 2, y: size.height / 2)
            context.cgContext.rotate(by: .pi / 2)
            image.draw(
                in: CGRect(
                    x: -image.size.width / 2,
                    y: -image.size.height / 2,
                    width: image.size.width,
                    height: image.size.height
                )
            )
        }
    }

    static func cropped(_ image: UIImage, to normalizedRect: CGRect) -> UIImage {
        let normalized = normalizedRect.standardized.intersection(PhotoEditorCrop.full)
        guard normalized.width > 0,
              normalized.height > 0,
              normalized.width < 0.999 || normalized.height < 0.999 else { return image }
        let cropRect = CGRect(
            x: normalized.minX * image.size.width,
            y: normalized.minY * image.size.height,
            width: normalized.width * image.size.width,
            height: normalized.height * image.size.height
        ).integral
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = 1
        return UIGraphicsImageRenderer(size: cropRect.size, format: format).image { context in
            UIColor.white.setFill()
            context.cgContext.fill(CGRect(origin: .zero, size: cropRect.size))
            image.draw(at: CGPoint(x: -cropRect.minX, y: -cropRect.minY))
        }
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

private enum PhotoLibraryAttachmentLoader {
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

private struct PhotoLibraryImageEditor: View {
    @Environment(\.dismiss) private var dismiss

    let asset: PHAsset
    @Binding var edit: PhotoLibraryEdit?

    @State private var image: UIImage?
    @State private var strokes: [PhotoEditorStroke] = []
    @State private var cropRect = PhotoEditorCrop.full
    @State private var isCropping = false
    @State private var isDrawing = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let image {
                PhotoEditorCanvas(
                    image: image,
                    isDrawing: isDrawing,
                    isCropping: isCropping,
                    strokes: $strokes,
                    cropRect: $cropRect
                )
            } else if let errorMessage {
                ContentUnavailableView(
                    "Photo unavailable",
                    systemImage: "photo.badge.exclamationmark",
                    description: Text(errorMessage)
                )
                .foregroundStyle(.white)
            } else {
                ProgressView("Opening photo")
                    .tint(.white)
                    .foregroundStyle(.white)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            editorHeader
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            editorToolbar
        }
        .task(id: asset.localIdentifier) {
            await loadImage()
        }
        .statusBarHidden(false)
    }

    private var editorHeader: some View {
        ZStack {
            Text("Edit Photo")
                .font(.headline)
                .foregroundStyle(.white)
            HStack {
                Button("Cancel") {
                    dismiss()
                }
                .frame(minHeight: 44)
                Spacer()
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 54)
        .background(Color.black.opacity(0.88))
    }

    private var editorToolbar: some View {
        HStack(spacing: 8) {
            editorButton("Rotate", systemImage: "rotate.right", action: rotateImage)
            editorButton(
                "Crop",
                systemImage: "crop",
                isActive: isCropping,
                action: toggleCropping
            )
            editorButton(
                "Draw",
                systemImage: "paintbrush",
                isActive: isDrawing,
                action: toggleDrawing
            )
            editorButton("Done", systemImage: "checkmark", isPrimary: true, action: finishEditing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color.black.opacity(0.88))
        .overlay(alignment: .top) {
            Divider().overlay(.white.opacity(0.16))
        }
    }

    private func editorButton(
        _ title: String,
        systemImage: String,
        isActive: Bool = false,
        isPrimary: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(.white)
                .background(
                    isPrimary
                        ? KordiTheme.signalBlue
                        : isActive ? KordiTheme.signalBlue.opacity(0.34) : Color.white.opacity(0.1),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .disabled(image == nil)
    }

    @MainActor
    private func loadImage() async {
        if let edit {
            image = edit.image
            return
        }
        do {
            let data = try await PhotoLibraryAttachmentLoader.imageData(for: asset)
            guard let loaded = PhotoEditorRenderer.downsampledImage(data: data) else {
                throw AttachmentTransferError.invalidImage
            }
            image = loaded
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func rotateImage() {
        guard let image else { return }
        let flattened = PhotoEditorRenderer.applying(strokes, to: image)
        self.image = PhotoEditorRenderer.rotatedClockwise(flattened)
        strokes = []
        cropRect = PhotoEditorCrop.full
        isCropping = false
    }

    private func toggleCropping() {
        isCropping.toggle()
        if isCropping { isDrawing = false }
    }

    private func toggleDrawing() {
        isDrawing.toggle()
        if isDrawing { isCropping = false }
    }

    private func finishEditing() {
        guard let image else { return }
        let flattened = PhotoEditorRenderer.applying(strokes, to: image)
        let cropped = PhotoEditorRenderer.cropped(flattened, to: cropRect)
        guard let data = cropped.jpegData(compressionQuality: 0.92) else {
            errorMessage = "Kordi could not save this edit. Try again."
            return
        }
        let originalName = PHAssetResource.assetResources(for: asset).first?.originalFilename
            ?? "Photo.jpg"
        edit = PhotoLibraryEdit(image: cropped, data: data, suggestedName: originalName)
        dismiss()
    }
}

private struct PhotoEditorCanvas: View {
    let image: UIImage
    let isDrawing: Bool
    let isCropping: Bool
    @Binding var strokes: [PhotoEditorStroke]
    @Binding var cropRect: CGRect

    @State private var activePoints: [CGPoint] = []

    var body: some View {
        GeometryReader { geometry in
            let imageSize = aspectFitSize(image.size, in: geometry.size)
            ZStack {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: imageSize.width, height: imageSize.height)
                    .accessibilityLabel("Photo being edited")

                Canvas { context, size in
                    draw(strokes, in: &context, size: size)
                    if !activePoints.isEmpty {
                        draw(
                            [PhotoEditorStroke(points: activePoints)],
                            in: &context,
                            size: size
                        )
                    }
                }
                .frame(width: imageSize.width, height: imageSize.height)
                .contentShape(Rectangle())
                .allowsHitTesting(isDrawing)
                .gesture(drawingGesture(size: imageSize))
                .accessibilityHidden(true)

                if isCropping {
                    PhotoEditorCropOverlay(cropRect: $cropRect)
                        .frame(width: imageSize.width, height: imageSize.height)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func aspectFitSize(_ content: CGSize, in container: CGSize) -> CGSize {
        guard content.width > 0, content.height > 0 else { return .zero }
        let scale = min(container.width / content.width, container.height / content.height)
        return CGSize(width: content.width * scale, height: content.height * scale)
    }

    private func drawingGesture(size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard isDrawing, size.width > 0, size.height > 0 else { return }
                let point = CGPoint(
                    x: min(1, max(0, value.location.x / size.width)),
                    y: min(1, max(0, value.location.y / size.height))
                )
                if let last = activePoints.last,
                   hypot(point.x - last.x, point.y - last.y) < 0.001 {
                    return
                }
                activePoints.append(point)
            }
            .onEnded { _ in
                guard !activePoints.isEmpty else { return }
                strokes.append(PhotoEditorStroke(points: activePoints))
                activePoints = []
            }
    }

    private func draw(
        _ strokes: [PhotoEditorStroke],
        in context: inout GraphicsContext,
        size: CGSize
    ) {
        let lineWidth = max(3, min(size.width, size.height) * 0.006)
        for stroke in strokes where !stroke.points.isEmpty {
            let points = stroke.points.map {
                CGPoint(x: $0.x * size.width, y: $0.y * size.height)
            }
            if points.count == 1, let point = points.first {
                context.fill(
                    Path(ellipseIn: CGRect(
                        x: point.x - lineWidth / 2,
                        y: point.y - lineWidth / 2,
                        width: lineWidth,
                        height: lineWidth
                    )),
                    with: .color(.red)
                )
                continue
            }
            var path = Path()
            path.move(to: points[0])
            for point in points.dropFirst() {
                path.addLine(to: point)
            }
            context.stroke(
                path,
                with: .color(.red),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round)
            )
        }
    }
}

private struct PhotoEditorCropOverlay: View {
    @Binding var cropRect: CGRect

    @State private var gestureStartRect: CGRect?

    var body: some View {
        GeometryReader { geometry in
            let frame = cropFrame(in: geometry.size)
            ZStack {
                Canvas { context, size in
                    drawOverlay(in: &context, size: size, cropFrame: frame)
                }
                .allowsHitTesting(false)

                Rectangle()
                    .fill(.clear)
                    .frame(width: frame.width, height: frame.height)
                    .contentShape(Rectangle())
                    .position(x: frame.midX, y: frame.midY)
                    .gesture(moveGesture(canvasSize: geometry.size))
                    .accessibilityLabel("Move crop area")
                    .accessibilityHint("Drag to reposition the crop")
                    .accessibilityAddTraits(.isButton)

                cropHandle(.topLeading, in: frame, canvasSize: geometry.size)
                cropHandle(.topTrailing, in: frame, canvasSize: geometry.size)
                cropHandle(.bottomLeading, in: frame, canvasSize: geometry.size)
                cropHandle(.bottomTrailing, in: frame, canvasSize: geometry.size)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Crop controls")
        }
    }

    private func cropFrame(in size: CGSize) -> CGRect {
        CGRect(
            x: cropRect.minX * size.width,
            y: cropRect.minY * size.height,
            width: cropRect.width * size.width,
            height: cropRect.height * size.height
        )
    }

    private func drawOverlay(
        in context: inout GraphicsContext,
        size: CGSize,
        cropFrame: CGRect
    ) {
        var outside = Path()
        outside.addRect(CGRect(origin: .zero, size: size))
        outside.addRect(cropFrame)
        context.fill(
            outside,
            with: .color(.black.opacity(0.52)),
            style: FillStyle(eoFill: true)
        )
        context.stroke(
            Path(cropFrame),
            with: .color(.white),
            style: StrokeStyle(lineWidth: 2)
        )
        var grid = Path()
        for fraction in [1.0 / 3.0, 2.0 / 3.0] {
            grid.move(to: CGPoint(x: cropFrame.minX + cropFrame.width * fraction, y: cropFrame.minY))
            grid.addLine(to: CGPoint(x: cropFrame.minX + cropFrame.width * fraction, y: cropFrame.maxY))
            grid.move(to: CGPoint(x: cropFrame.minX, y: cropFrame.minY + cropFrame.height * fraction))
            grid.addLine(to: CGPoint(x: cropFrame.maxX, y: cropFrame.minY + cropFrame.height * fraction))
        }
        context.stroke(grid, with: .color(.white.opacity(0.5)), lineWidth: 1)
    }

    private func moveGesture(canvasSize: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                let start = gestureStartRect ?? cropRect
                gestureStartRect = start
                cropRect = PhotoEditorCrop.moved(
                    start,
                    translation: value.translation,
                    canvasSize: canvasSize
                )
            }
            .onEnded { _ in gestureStartRect = nil }
    }

    private func cropHandle(
        _ corner: PhotoEditorCropCorner,
        in frame: CGRect,
        canvasSize: CGSize
    ) -> some View {
        Circle()
            .fill(.white)
            .frame(width: 14, height: 14)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .position(handlePosition(corner, in: frame))
            .gesture(resizeGesture(corner: corner, canvasSize: canvasSize))
            .accessibilityLabel("\(corner.accessibilityName) crop handle")
            .accessibilityHint("Drag to resize the crop")
            .accessibilityAddTraits(.isButton)
    }

    private func handlePosition(_ corner: PhotoEditorCropCorner, in frame: CGRect) -> CGPoint {
        switch corner {
        case .topLeading: CGPoint(x: frame.minX, y: frame.minY)
        case .topTrailing: CGPoint(x: frame.maxX, y: frame.minY)
        case .bottomLeading: CGPoint(x: frame.minX, y: frame.maxY)
        case .bottomTrailing: CGPoint(x: frame.maxX, y: frame.maxY)
        }
    }

    private func resizeGesture(
        corner: PhotoEditorCropCorner,
        canvasSize: CGSize
    ) -> some Gesture {
        DragGesture()
            .onChanged { value in
                let start = gestureStartRect ?? cropRect
                gestureStartRect = start
                cropRect = PhotoEditorCrop.resized(
                    start,
                    corner: corner,
                    translation: value.translation,
                    canvasSize: canvasSize
                )
            }
            .onEnded { _ in gestureStartRect = nil }
    }
}

private extension PhotoEditorCropCorner {
    var accessibilityName: String {
        switch self {
        case .topLeading: "Top left"
        case .topTrailing: "Top right"
        case .bottomLeading: "Bottom left"
        case .bottomTrailing: "Bottom right"
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
