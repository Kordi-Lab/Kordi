import Photos
import SwiftUI
import UIKit

struct PhotoLibraryImageEditor: View {
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
        .safeAreaInset(edge: .top, spacing: 0) { editorHeader }
        .safeAreaInset(edge: .bottom, spacing: 0) { editorToolbar }
        .task(id: asset.localIdentifier) { await loadImage() }
        .statusBarHidden(false)
    }

    private var editorHeader: some View {
        ZStack {
            Text("Edit Photo")
                .font(.headline)
                .foregroundStyle(.white)
            HStack {
                Button("Cancel") { dismiss() }
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
            editorButton("Crop", systemImage: "crop", isActive: isCropping, action: startCropping)
            editorButton("Draw", systemImage: "paintbrush", isActive: isDrawing, action: toggleDrawing)
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

    private func startCropping() {
        guard !isCropping else { return }
        if cropRect.width >= 0.999, cropRect.height >= 0.999 {
            cropRect = PhotoEditorCrop.initial
        }
        isCropping = true
        isDrawing = false
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
                        draw([PhotoEditorStroke(points: activePoints)], in: &context, size: size)
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
            for point in points.dropFirst() { path.addLine(to: point) }
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
