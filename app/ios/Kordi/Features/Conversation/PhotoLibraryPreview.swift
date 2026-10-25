import Photos
import PhotosUI
import SwiftUI
import UIKit

/// Full-screen photo from the picker, in the style of Telegram's picker:
/// swipe between photos, select with the corner circle, turn Live off to send
/// a still, edit, or send.
struct PhotoLibraryPreview: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let library: PhotoLibraryAssets
    @Binding var index: Int
    @Binding var selectedIDs: [String]
    @Binding var stillOnlyIDs: Set<String>
    let editedImages: [String: UIImage]
    let isSending: Bool
    let onEdit: (PHAsset) -> Void
    let onSend: (String?) -> Void
    let onClose: () -> Void
    /// How far the photo has been dragged down to close the preview.
    @State private var dismissOffset: CGFloat = 0
    @State private var isClosing = false

    var body: some View {
        let asset = library.asset(at: index)
        // Same fades as the chat image viewer: the grid shows through quickly.
        let backdrop = isClosing ? 0 : 1 - min(dismissOffset / 260, 1)
        let chrome = isClosing ? 0 : 1 - min(dismissOffset / 120, 1)
        let dragScale = 1 - min(dismissOffset / 260, 1) * 0.2
        ZStack {
            Color.black.opacity(backdrop).ignoresSafeArea()
            PhotoLibraryPager(
                library: library,
                index: $index,
                editedImages: editedImages,
                stillOnlyIDs: stillOnlyIDs,
                onDismissOffset: { offset in
                    if offset == 0 {
                        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeOut(duration: 0.2)) { dismissOffset = 0 }
                    } else {
                        dismissOffset = offset
                    }
                },
                onDismiss: close
            )
            .ignoresSafeArea()
            // The same motion as the chat image viewer, applied by SwiftUI so
            // layout passes during the drag cannot fight a UIKit transform.
            .scaleEffect(dragScale * (isClosing ? 0.85 : 1))
            .opacity(isClosing ? 0 : 1)
            .offset(y: dismissOffset)
        }
        .overlay(alignment: .top) { topBar(asset).opacity(chrome) }
        .overlay(alignment: .bottom) { bottomBar(asset).opacity(chrome) }
        .environment(\.colorScheme, .dark)
        .accessibilityAction(.escape, close)
    }

    /// Shrinks and fades the photo with the backdrop, as the chat image viewer does.
    private func close() {
        guard !isClosing else { return }
        guard !UIAccessibility.isReduceMotionEnabled else { return onClose() }
        withAnimation(.easeOut(duration: 0.22)) { isClosing = true } completion: { onClose() }
    }

    private func topBar(_ asset: PHAsset?) -> some View {
        HStack(alignment: .top) {
            if let asset, asset.mediaSubtypes.contains(.photoLive) {
                liveToggle(asset.localIdentifier)
            }
            Spacer()
            if let id = asset?.localIdentifier {
                selectionButton(id)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
    }

    private func liveToggle(_ id: String) -> some View {
        let isEdited = editedImages[id] != nil
        let isLive = !stillOnlyIDs.contains(id) && !isEdited
        return Button {
            if isLive { stillOnlyIDs.insert(id) } else { stillOnlyIDs.remove(id) }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: isLive ? "livephoto" : "livephoto.slash")
                Text(isLive ? "Live on" : "Live off")
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .frame(minHeight: 32)
            .background(.black.opacity(0.45), in: Capsule())
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isEdited || isSending)
        .accessibilityLabel("Live Photo")
        .accessibilityValue(isLive ? "On" : "Off")
        .accessibilityHint(isEdited ? "Edited photos are sent as still images" : "Turn off to send a still photo")
    }

    private func selectionButton(_ id: String) -> some View {
        let position = selectedIDs.firstIndex(of: id)
        return Button {
            selectedIDs = PhotoLibrarySelection.toggling(id, in: selectedIDs)
        } label: {
            ZStack {
                Circle().fill(position == nil ? Color.black.opacity(0.24) : chatTheme.accent)
                Circle().stroke(.white, lineWidth: 2)
                if let position {
                    Text("\(position + 1)")
                        .font(.subheadline.bold())
                        .foregroundStyle(.white)
                        .minimumScaleFactor(0.6)
                }
            }
            .frame(width: 30, height: 30)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSending)
        .accessibilityLabel("Select photo")
        .accessibilityValue(position.map { "Selected \($0 + 1)" } ?? "Not selected")
    }

    private func bottomBar(_ asset: PHAsset?) -> some View {
        HStack(spacing: 12) {
            chromeButton("Back to photos", systemImage: "chevron.left", action: close)
            Spacer()
            Button {
                if let asset { onEdit(asset) }
            } label: {
                Label("Edit", systemImage: "crop.rotate")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18)
                    .frame(height: 48)
                    .background(.black.opacity(0.45), in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(asset == nil || isSending)
            Spacer()
            sendButton(currentID: asset?.localIdentifier)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func chromeButton(_ label: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 48, height: 48)
                .background(.black.opacity(0.45), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func sendButton(currentID: String?) -> some View {
        let count = selectedIDs.isEmpty ? 1 : selectedIDs.count
        return Button {
            onSend(currentID)
        } label: {
            Image(systemName: "arrow.up")
                .font(.body.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 48, height: 48)
                .background(chatTheme.accent, in: Circle())
                .overlay(alignment: .topTrailing) {
                    if selectedIDs.count > 1 {
                        Text("\(selectedIDs.count)")
                            .font(.caption2.bold())
                            .foregroundStyle(chatTheme.accent)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(.white, in: Capsule())
                            .offset(x: 4, y: -4)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(currentID == nil || isSending)
        .accessibilityLabel(count == 1 ? "Send photo" : "Send \(count) photos")
    }
}

/// Horizontal pager over the library. Live Photos play while pressed, unless
/// they will be sent as stills. Dragging down returns to the grid.
private struct PhotoLibraryPager: UIViewRepresentable {
    let library: PhotoLibraryAssets
    @Binding var index: Int
    let editedImages: [String: UIImage]
    let stillOnlyIDs: Set<String>
    let onDismissOffset: (CGFloat) -> Void
    let onDismiss: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(index: $index) }

    func makeUIView(context: Context) -> PagerCollectionView {
        let layout = PagerLayout()
        let view = PagerCollectionView(frame: .zero, collectionViewLayout: layout)
        view.backgroundColor = .clear
        view.isPagingEnabled = true
        view.showsHorizontalScrollIndicator = false
        view.contentInsetAdjustmentBehavior = .never
        view.register(PagerCell.self, forCellWithReuseIdentifier: PagerCell.reuseID)
        view.dataSource = context.coordinator
        view.delegate = context.coordinator
        view.onLayout = { [weak coordinator = context.coordinator, weak view] in
            guard let coordinator, let view else { return }
            coordinator.keepPage(in: view)
        }
        context.coordinator.attachDismissDrag(to: view)
        return view
    }

    func updateUIView(_ view: PagerCollectionView, context: Context) {
        let coordinator = context.coordinator
        let changed = coordinator.parent.map {
            $0.editedImages.keys != editedImages.keys || $0.stillOnlyIDs != stillOnlyIDs
        } ?? false
        coordinator.parent = self
        coordinator.index = $index
        if changed {
            view.reconfigureItems(at: view.indexPathsForVisibleItems)
        }
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate,
        UIGestureRecognizerDelegate {
        var parent: PhotoLibraryPager?
        var index: Binding<Int>
        private var lastWidth: CGFloat = 0
        private weak var dismissDrag: UIPanGestureRecognizer?
        private weak var pager: UICollectionView?

        init(index: Binding<Int>) { self.index = index }

        func attachDismissDrag(to view: UICollectionView) {
            let drag = UIPanGestureRecognizer(target: self, action: #selector(handleDismissDrag))
            drag.maximumNumberOfTouches = 1
            drag.delegate = self
            view.addGestureRecognizer(drag)
            dismissDrag = drag
            pager = view
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard gestureRecognizer === dismissDrag, let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            let movement = velocity == .zero ? pan.translation(in: pan.view) : velocity
            // Only a mostly downward drag closes; sideways movement pages.
            return movement.y > 0 && movement.y > abs(movement.x) * 1.25
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            gestureRecognizer === dismissDrag && otherGestureRecognizer === pager?.panGestureRecognizer
        }

        @objc private func handleDismissDrag(_ recognizer: UIPanGestureRecognizer) {
            guard let view = recognizer.view, let parent else { return }
            // Window coordinates: the view itself moves with the drag.
            let point = recognizer.translation(in: nil)
            let translation = CGSize(width: point.x, height: point.y)
            // Matches the chat image viewer: only a mostly downward drag counts.
            let distance = MediaPreviewDismissal.verticalOffset(for: translation)
            switch recognizer.state {
            case .began, .changed:
                parent.onDismissOffset(distance)
            case .ended where MediaPreviewDismissal.shouldDismiss(
                translation: translation,
                predictedEndTranslation: Self.predictedEnd(of: recognizer, from: translation),
                viewportHeight: view.bounds.height
            ):
                parent.onDismiss()
            default:
                parent.onDismissOffset(0)
            }
        }

        private static func predictedEnd(of recognizer: UIPanGestureRecognizer, from translation: CGSize) -> CGSize {
            let velocity = recognizer.velocity(in: nil)
            return CGSize(width: translation.width + velocity.x * 0.25, height: translation.height + velocity.y * 0.25)
        }

        func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
            parent?.library.count ?? 0
        }

        func collectionView(
            _ collectionView: UICollectionView,
            cellForItemAt indexPath: IndexPath
        ) -> UICollectionViewCell {
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: PagerCell.reuseID, for: indexPath)
            guard let cell = cell as? PagerCell, let parent,
                  let asset = parent.library.asset(at: indexPath.item) else { return cell }
            let id = asset.localIdentifier
            cell.show(
                asset: asset,
                edited: parent.editedImages[id],
                playsLive: !parent.stillOnlyIDs.contains(id),
                scale: collectionView.traitCollection.displayScale
            )
            return cell
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            let width = scrollView.bounds.width
            guard width > 0, scrollView.isDragging || scrollView.isDecelerating else { return }
            let page = Int((scrollView.contentOffset.x / width).rounded())
            let count = parent?.library.count ?? 0
            guard page >= 0, page < count, page != index.wrappedValue else { return }
            index.wrappedValue = page
        }

        /// Opens on the tapped photo and keeps the current page through size changes.
        func keepPage(in view: UICollectionView) {
            let width = view.bounds.width
            guard width > 0, width != lastWidth else { return }
            lastWidth = width
            view.collectionViewLayout.invalidateLayout()
            view.layoutIfNeeded()
            view.contentOffset = CGPoint(x: CGFloat(index.wrappedValue) * width, y: 0)
        }
    }

    final class PagerCollectionView: UICollectionView {
        var onLayout: (() -> Void)?

        override func layoutSubviews() {
            super.layoutSubviews()
            onLayout?()
        }
    }

    private final class PagerLayout: UICollectionViewFlowLayout {
        override init() {
            super.init()
            scrollDirection = .horizontal
            minimumLineSpacing = 0
            minimumInteritemSpacing = 0
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func prepare() {
            if let collectionView, collectionView.bounds.size != .zero, itemSize != collectionView.bounds.size {
                itemSize = collectionView.bounds.size
            }
            super.prepare()
        }

        override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
            newBounds.size != collectionView?.bounds.size
        }
    }

    private final class PagerCell: UICollectionViewCell {
        static let reuseID = "PhotoLibraryPagerCell"

        private let imageView = UIImageView()
        private let liveView = PHLivePhotoView()
        private var assetID: String?
        private var imageRequest = PHInvalidImageRequestID
        private var liveRequest = PHInvalidImageRequestID

        override init(frame: CGRect) {
            super.init(frame: frame)
            imageView.contentMode = .scaleAspectFit
            liveView.contentMode = .scaleAspectFit
            liveView.isMuted = false
            liveView.backgroundColor = .clear
            [imageView, liveView].forEach(contentView.addSubview)
            isAccessibilityElement = true
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func layoutSubviews() {
            super.layoutSubviews()
            imageView.frame = contentView.bounds
            liveView.frame = contentView.bounds
        }

        override func prepareForReuse() {
            super.prepareForReuse()
            cancelRequests()
            imageView.image = nil
            liveView.stopPlayback()
            liveView.livePhoto = nil
            assetID = nil
        }

        func show(asset: PHAsset, edited: UIImage?, playsLive: Bool, scale: CGFloat) {
            let id = asset.localIdentifier
            let isLive = asset.mediaSubtypes.contains(.photoLive)
            accessibilityLabel = isLive ? "Live Photo" : "Photo"
            if assetID != id {
                cancelRequests()
                imageView.image = nil
                liveView.livePhoto = nil
                assetID = id
            }
            let showsLive = isLive && playsLive && edited == nil
            liveView.isHidden = !showsLive
            if let edited {
                imageView.image = edited
                return
            }
            let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
            if imageView.image == nil {
                let options = PHImageRequestOptions()
                options.deliveryMode = .opportunistic
                options.isNetworkAccessAllowed = true
                imageRequest = PHImageManager.default().requestImage(
                    for: asset, targetSize: size, contentMode: .aspectFit, options: options
                ) { [weak self] image, _ in
                    guard let image else { return }
                    MainActor.assumeIsolated {
                        guard let self, self.assetID == id else { return }
                        self.imageView.image = image
                    }
                }
            }
            if showsLive, liveView.livePhoto == nil {
                let options = PHLivePhotoRequestOptions()
                options.deliveryMode = .highQualityFormat
                options.isNetworkAccessAllowed = true
                liveRequest = PHImageManager.default().requestLivePhoto(
                    for: asset, targetSize: size, contentMode: .aspectFit, options: options
                ) { [weak self] livePhoto, _ in
                    guard let livePhoto else { return }
                    MainActor.assumeIsolated {
                        guard let self, self.assetID == id else { return }
                        self.liveView.livePhoto = livePhoto
                    }
                }
            }
        }

        private func cancelRequests() {
            PHImageManager.default().cancelImageRequest(imageRequest)
            PHImageManager.default().cancelImageRequest(liveRequest)
            imageRequest = PHInvalidImageRequestID
            liveRequest = PHInvalidImageRequestID
        }
    }
}
