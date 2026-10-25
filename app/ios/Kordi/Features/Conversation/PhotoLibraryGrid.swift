import Photos
import SwiftUI
import UIKit

/// UIKit grid for the photo picker. Reused cells keep thumbnails steady while
/// the selection changes. Tapping the corner circle selects, tapping the photo
/// opens it, and a horizontal drag selects a run like the Photos app.
struct PhotoLibraryGrid: UIViewRepresentable {
    let library: PhotoLibraryAssets
    let selectedIDs: [String]
    let editedImages: [String: UIImage]
    let stillOnlyIDs: Set<String>
    let accent: Color
    let onSelectionChange: ([String]) -> Void
    let onToggleLive: (String) -> Void
    let onOpen: (Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UICollectionView {
        let view = UICollectionView(frame: .zero, collectionViewLayout: PhotoLibraryGridLayout())
        view.backgroundColor = .systemBackground
        view.alwaysBounceVertical = true
        view.allowsSelection = false
        view.register(PhotoLibraryGridCell.self, forCellWithReuseIdentifier: PhotoLibraryGridCell.reuseID)
        context.coordinator.attach(to: view)
        return view
    }

    func updateUIView(_ view: UICollectionView, context: Context) {
        context.coordinator.update(with: self, in: view)
    }

    static func dismantleUIView(_ view: UICollectionView, coordinator: Coordinator) {
        coordinator.detach()
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate,
        UICollectionViewDataSourcePrefetching, UIGestureRecognizerDelegate {
        private let imageManager = PHCachingImageManager()
        private weak var collectionView: UICollectionView?
        private weak var dragRecognizer: UIPanGestureRecognizer?
        private var parent: PhotoLibraryGrid?
        private var dragSelection: PhotoLibraryDragSelection?
        private var autoscroll: CADisplayLink?
        private var autoscrollTimestamp: CFTimeInterval = 0

        func attach(to view: UICollectionView) {
            collectionView = view
            view.dataSource = self
            view.delegate = self
            view.prefetchDataSource = self
            let drag = UIPanGestureRecognizer(target: self, action: #selector(handleDrag))
            drag.maximumNumberOfTouches = 1
            drag.delegate = self
            view.addGestureRecognizer(drag)
            dragRecognizer = drag
            view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(handleTap)))
        }

        func detach() {
            stopAutoscroll()
            imageManager.stopCachingImagesForAllAssets()
        }

        func update(with grid: PhotoLibraryGrid, in view: UICollectionView) {
            let previous = parent
            parent = grid
            guard let previous, previous.library === grid.library else {
                imageManager.stopCachingImagesForAllAssets()
                view.reloadData()
                return
            }
            if previous.editedImages.keys != grid.editedImages.keys {
                view.reconfigureItems(at: view.indexPathsForVisibleItems)
                return
            }
            guard previous.selectedIDs != grid.selectedIDs
                    || previous.stillOnlyIDs != grid.stillOnlyIDs
                    || previous.accent != grid.accent else { return }
            // Update visible cells in place; reloading would flash thumbnails.
            for case let cell as PhotoLibraryGridCell in view.visibleCells {
                guard let indexPath = view.indexPath(for: cell) else { continue }
                configureOverlay(cell, at: indexPath.item)
            }
        }

        // MARK: Data source

        func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
            parent?.library.count ?? 0
        }

        func collectionView(
            _ collectionView: UICollectionView,
            cellForItemAt indexPath: IndexPath
        ) -> UICollectionViewCell {
            let cell = collectionView.dequeueReusableCell(
                withReuseIdentifier: PhotoLibraryGridCell.reuseID,
                for: indexPath
            )
            guard let cell = cell as? PhotoLibraryGridCell,
                  let asset = parent?.library.asset(at: indexPath.item) else { return cell }
            cell.show(asset: asset)
            configureOverlay(cell, at: indexPath.item)
            if let edited = parent?.editedImages[asset.localIdentifier] {
                cell.showImage(edited)
            } else {
                requestThumbnail(for: asset, into: cell, in: collectionView)
            }
            return cell
        }

        func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
            imageManager.startCachingImages(
                for: assets(at: indexPaths), targetSize: thumbnailSize(in: collectionView),
                contentMode: .aspectFill, options: Self.thumbnailOptions
            )
        }

        func collectionView(_ collectionView: UICollectionView, cancelPrefetchingForItemsAt indexPaths: [IndexPath]) {
            imageManager.stopCachingImages(
                for: assets(at: indexPaths), targetSize: thumbnailSize(in: collectionView),
                contentMode: .aspectFill, options: Self.thumbnailOptions
            )
        }

        // MARK: Tap

        @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
            guard let collectionView, let parent,
                  let indexPath = collectionView.indexPathForItem(at: recognizer.location(in: collectionView)),
                  let cell = collectionView.cellForItem(at: indexPath),
                  let id = parent.library.id(at: indexPath.item) else { return }
            let point = recognizer.location(in: cell)
            let hit = PhotoLibraryGridMetrics.selectionHitSide
            let isLive = parent.library.asset(at: indexPath.item)?.mediaSubtypes.contains(.photoLive) == true
            if point.x >= cell.bounds.width - hit, point.y <= hit {
                parent.onSelectionChange(PhotoLibrarySelection.toggling(id, in: parent.selectedIDs))
            } else if isLive, point.x <= hit, point.y >= cell.bounds.height - hit {
                // The Live badge turns motion on or off for this photo.
                parent.onToggleLive(id)
            } else {
                parent.onOpen(indexPath.item)
            }
        }

        // MARK: Drag selection

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard gestureRecognizer === dragRecognizer,
                  let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            let movement = velocity == .zero ? pan.translation(in: pan.view) : velocity
            // Vertical movement fails the drag at once so the grid scrolls normally.
            return ChatRowSwipeDirection.isHorizontal(movement)
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            gestureRecognizer === dragRecognizer && otherGestureRecognizer === collectionView?.panGestureRecognizer
        }

        @objc private func handleDrag(_ recognizer: UIPanGestureRecognizer) {
            guard let collectionView, let parent else { return }
            switch recognizer.state {
            case .began:
                let location = recognizer.location(in: collectionView)
                let translation = recognizer.translation(in: collectionView)
                let origin = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
                guard let index = index(at: origin, in: collectionView),
                      let id = parent.library.id(at: index) else { return }
                dragSelection = PhotoLibraryDragSelection(anchorIndex: index, anchorID: id, baseline: parent.selectedIDs)
                extendDrag(to: location, in: collectionView)
            case .changed:
                extendDrag(to: recognizer.location(in: collectionView), in: collectionView)
                updateAutoscroll(for: recognizer, in: collectionView)
            default:
                dragSelection = nil
                stopAutoscroll()
            }
        }

        private func extendDrag(to point: CGPoint, in collectionView: UICollectionView) {
            guard let dragSelection, let parent, let index = index(at: point, in: collectionView) else { return }
            let library = parent.library
            let selection = dragSelection.selection(through: index, count: library.count, id: library.id(at:))
            if selection != parent.selectedIDs { parent.onSelectionChange(selection) }
        }

        private func index(at point: CGPoint, in collectionView: UICollectionView) -> Int? {
            PhotoLibraryGridMetrics.index(
                at: point,
                itemSide: thumbnailSide(in: collectionView),
                width: collectionView.bounds.width,
                count: parent?.library.count ?? 0
            )
        }

        private func updateAutoscroll(for recognizer: UIPanGestureRecognizer, in collectionView: UICollectionView) {
            if autoscrollVelocity(for: recognizer, in: collectionView) == 0 {
                stopAutoscroll()
            } else if autoscroll == nil {
                let link = CADisplayLink(target: self, selector: #selector(stepAutoscroll))
                autoscrollTimestamp = CACurrentMediaTime()
                link.add(to: .main, forMode: .common)
                autoscroll = link
            }
        }

        /// Points per second toward the edge the finger rests near.
        private func autoscrollVelocity(for recognizer: UIPanGestureRecognizer, in collectionView: UICollectionView) -> CGFloat {
            let edge: CGFloat = 64
            let y = recognizer.location(in: collectionView).y - collectionView.bounds.minY
            let top = collectionView.adjustedContentInset.top
            let bottom = collectionView.bounds.height - collectionView.adjustedContentInset.bottom
            if y < top + edge { return -900 * min(1, (top + edge - y) / edge) }
            if y > bottom - edge { return 900 * min(1, (y - (bottom - edge)) / edge) }
            return 0
        }

        @objc private func stepAutoscroll(_ link: CADisplayLink) {
            guard let collectionView, let recognizer = dragRecognizer, dragSelection != nil else {
                stopAutoscroll()
                return
            }
            let now = CACurrentMediaTime()
            let elapsed = min(now - autoscrollTimestamp, 1.0 / 30)
            autoscrollTimestamp = now
            let velocity = autoscrollVelocity(for: recognizer, in: collectionView)
            let insets = collectionView.adjustedContentInset
            let minimum = -insets.top
            let maximum = max(minimum, collectionView.contentSize.height - collectionView.bounds.height + insets.bottom)
            let target = min(max(collectionView.contentOffset.y + velocity * elapsed, minimum), maximum)
            guard velocity != 0, abs(target - collectionView.contentOffset.y) > 0.01 else { return }
            collectionView.contentOffset.y = target
            extendDrag(to: recognizer.location(in: collectionView), in: collectionView)
        }

        private func stopAutoscroll() {
            autoscroll?.invalidate()
            autoscroll = nil
        }

        // MARK: Cells

        private func configureOverlay(_ cell: PhotoLibraryGridCell, at index: Int) {
            guard let parent, let id = parent.library.id(at: index) else { return }
            let position = parent.selectedIDs.firstIndex(of: id)
            cell.setSelection(number: position.map { $0 + 1 }, accent: UIColor(parent.accent))
            var actions = [
                UIAccessibilityCustomAction(name: position == nil ? "Select" : "Deselect") { [weak self] _ in
                    guard let parent = self?.parent else { return false }
                    parent.onSelectionChange(PhotoLibrarySelection.toggling(id, in: parent.selectedIDs))
                    return true
                }
            ]
            if parent.library.asset(at: index)?.mediaSubtypes.contains(.photoLive) == true, parent.editedImages[id] == nil {
                let liveName = parent.stillOnlyIDs.contains(id) ? "Turn Live on" : "Turn Live off"
                actions.append(UIAccessibilityCustomAction(name: liveName) { [weak self] _ in
                    self?.parent?.onToggleLive(id)
                    return self?.parent != nil
                })
            }
            cell.accessibilityCustomActions = actions
            cell.setStillOnly(parent.stillOnlyIDs.contains(id) || parent.editedImages[id] != nil)
        }

        private func requestThumbnail(
            for asset: PHAsset,
            into cell: PhotoLibraryGridCell,
            in collectionView: UICollectionView
        ) {
            let id = asset.localIdentifier
            cell.requestID = imageManager.requestImage(
                for: asset, targetSize: thumbnailSize(in: collectionView),
                contentMode: .aspectFill, options: Self.thumbnailOptions
            ) { [weak cell] image, _ in
                guard let image else { return }
                MainActor.assumeIsolated {
                    guard let cell, cell.assetID == id else { return }
                    cell.showImage(image)
                }
            }
        }

        private func assets(at indexPaths: [IndexPath]) -> [PHAsset] {
            indexPaths.compactMap { parent?.library.asset(at: $0.item) }
        }

        private func thumbnailSide(in collectionView: UICollectionView) -> CGFloat {
            PhotoLibraryGridMetrics.itemSide(
                width: collectionView.bounds.width,
                scale: collectionView.traitCollection.displayScale
            )
        }

        private func thumbnailSize(in collectionView: UICollectionView) -> CGSize {
            let side = thumbnailSide(in: collectionView) * max(collectionView.traitCollection.displayScale, 1)
            return CGSize(width: side, height: side)
        }

        private static let thumbnailOptions: PHImageRequestOptions = {
            let options = PHImageRequestOptions()
            options.deliveryMode = .opportunistic
            options.resizeMode = .fast
            options.isNetworkAccessAllowed = true
            return options
        }()
    }
}

private final class PhotoLibraryGridLayout: UICollectionViewFlowLayout {
    override init() {
        super.init()
        minimumInteritemSpacing = PhotoLibraryGridMetrics.spacing
        minimumLineSpacing = PhotoLibraryGridMetrics.spacing
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func prepare() {
        if let collectionView {
            let side = PhotoLibraryGridMetrics.itemSide(
                width: collectionView.bounds.width,
                scale: collectionView.traitCollection.displayScale
            )
            if side > 0, itemSize.width != side { itemSize = CGSize(width: side, height: side) }
        }
        super.prepare()
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        newBounds.width != collectionView?.bounds.width
    }
}

private final class PhotoLibraryGridCell: UICollectionViewCell {
    static let reuseID = "PhotoLibraryGridCell"

    private let imageView = UIImageView()
    private let liveBadge = UIImageView()
    private let selectionCircle = UIView()
    private let selectionNumber = UILabel()
    private(set) var assetID: String?
    var requestID = PHInvalidImageRequestID
    private var isLivePhoto = false
    private var isStillOnly = false
    private var selectionPosition: Int?

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = .secondarySystemFill
        contentView.clipsToBounds = true
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true

        liveBadge.tintColor = .white
        liveBadge.contentMode = .center
        liveBadge.preferredSymbolConfiguration = .init(pointSize: 16, weight: .medium)
        liveBadge.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        liveBadge.layer.cornerRadius = 12

        selectionCircle.layer.cornerRadius = 13.5
        selectionCircle.layer.borderWidth = 2
        selectionCircle.layer.borderColor = UIColor.white.cgColor
        selectionCircle.isUserInteractionEnabled = false
        let bold = UIFont.preferredFont(forTextStyle: .caption1).fontDescriptor.withSymbolicTraits(.traitBold)
        selectionNumber.font = bold.map { UIFont(descriptor: $0, size: 0) } ?? .boldSystemFont(ofSize: 12)
        selectionNumber.textColor = .white
        selectionNumber.textAlignment = .center
        selectionNumber.adjustsFontSizeToFitWidth = true
        selectionNumber.minimumScaleFactor = 0.6

        [imageView, liveBadge, selectionCircle].forEach(contentView.addSubview)
        selectionCircle.addSubview(selectionNumber)
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let bounds = contentView.bounds
        imageView.frame = bounds
        liveBadge.frame = CGRect(x: 4, y: bounds.maxY - 28, width: 24, height: 24)
        selectionCircle.frame = CGRect(x: bounds.maxX - 33, y: 6, width: 27, height: 27)
        selectionNumber.frame = selectionCircle.bounds.insetBy(dx: 3, dy: 3)
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        PHImageManager.default().cancelImageRequest(requestID)
        requestID = PHInvalidImageRequestID
        imageView.image = nil
        assetID = nil
    }

    func show(asset: PHAsset) {
        assetID = asset.localIdentifier
        isLivePhoto = asset.mediaSubtypes.contains(.photoLive)
        updateLiveBadge()
        updateAccessibility()
    }

    func showImage(_ image: UIImage) {
        imageView.image = image
    }

    func setSelection(number: Int?, accent: UIColor) {
        selectionPosition = number
        selectionCircle.backgroundColor = number == nil ? UIColor.black.withAlphaComponent(0.24) : accent
        selectionNumber.text = number.map(String.init)
        updateAccessibility()
    }

    func setStillOnly(_ stillOnly: Bool) {
        isStillOnly = stillOnly
        updateLiveBadge()
    }

    private func updateLiveBadge() {
        liveBadge.isHidden = !isLivePhoto
        liveBadge.image = UIImage(systemName: isStillOnly ? "livephoto.slash" : "livephoto")
    }

    private func updateAccessibility() {
        accessibilityLabel = isLivePhoto ? "Live Photo" : "Photo"
        accessibilityValue = selectionPosition.map { "Selected \($0)" } ?? "Not selected"
        accessibilityTraits = selectionPosition == nil ? .button : [.button, .selected]
        accessibilityHint = "Opens the photo"
    }
}
