import Photos
import UIKit

/// The picker's photos, read lazily so opening a large library does not
/// enumerate every asset on the main thread.
final class PhotoLibraryAssets {
    let fetchResult: PHFetchResult<PHAsset>

    init(fetchResult: PHFetchResult<PHAsset>) {
        self.fetchResult = fetchResult
    }

    var count: Int { fetchResult.count }

    func asset(at index: Int) -> PHAsset? {
        index >= 0 && index < fetchResult.count ? fetchResult.object(at: index) : nil
    }

    func id(at index: Int) -> String? { asset(at: index)?.localIdentifier }

    /// Assets for the given identifiers, in the identifiers' order.
    static func assets(for ids: [String]) -> [PHAsset] {
        guard !ids.isEmpty else { return [] }
        var byID: [String: PHAsset] = [:]
        PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil).enumerateObjects { asset, _, _ in
            byID[asset.localIdentifier] = asset
        }
        return ids.compactMap { byID[$0] }
    }
}

/// A drag across the photo grid selects a run of photos, as in Photos. The
/// first photo decides whether the drag selects or deselects, and photos that
/// leave the dragged run return to their state from before the drag.
struct PhotoLibraryDragSelection {
    let anchorIndex: Int
    let selects: Bool
    let baseline: [String]

    init(anchorIndex: Int, anchorID: String, baseline: [String]) {
        self.anchorIndex = anchorIndex
        self.selects = !baseline.contains(anchorID)
        self.baseline = baseline
    }

    /// Photos join in drag order, so their numbers follow the finger.
    func selection(through index: Int, count: Int, id: (Int) -> String?) -> [String] {
        guard anchorIndex >= 0, anchorIndex < count else { return baseline }
        let end = min(max(index, 0), count - 1)
        let indices = anchorIndex <= end
            ? Array(anchorIndex...end)
            : Array((end...anchorIndex).reversed())
        let run = indices.compactMap(id)
        if selects {
            return baseline + run.filter { !baseline.contains($0) }
        }
        let removed = Set(run)
        return baseline.filter { !removed.contains($0) }
    }
}

enum PhotoLibraryGridMetrics {
    static let columns = 4
    static let spacing: CGFloat = 2
    /// The selection circle's tap target in a cell's top-trailing corner.
    static let selectionHitSide: CGFloat = 44

    static func itemSide(width: CGFloat, scale: CGFloat) -> CGFloat {
        let available = width - spacing * CGFloat(columns - 1)
        guard available > 0, scale > 0 else { return 0 }
        return floor(available / CGFloat(columns) * scale) / scale
    }

    /// The photo under a point in content coordinates. Points in the gaps
    /// between photos resolve to a neighbour so a drag never skips one.
    static func index(at point: CGPoint, itemSide: CGFloat, width: CGFloat, count: Int) -> Int? {
        guard count > 0, itemSide > 0 else { return nil }
        let columnPitch = (width - itemSide) / CGFloat(columns - 1)
        let column = min(max(Int(((point.x - itemSide / 2) / columnPitch).rounded()), 0), columns - 1)
        let row = max(Int(floor(point.y / (itemSide + spacing))), 0)
        return min(row * columns + column, count - 1)
    }
}
