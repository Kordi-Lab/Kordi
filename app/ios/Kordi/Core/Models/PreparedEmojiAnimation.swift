import CryptoKit
import Foundation
import ImageIO
import UIKit

struct EmojiAnimationRequest: Hashable, Sendable {
    struct Source: Hashable, Sendable {
        let url: URL
        let mediaType: String?
    }

    let identifier: String
    let revision: String
    let pixelSize: Int
    let animated: Bool
    let sources: [Source]
    let cacheKey: String

    var previewKey: String { "\(identifier):\(revision)" }

    init(identifier: String, revision: String, pixelSize: Int, animated: Bool, sources: [Source]) {
        self.identifier = identifier
        self.revision = revision
        self.pixelSize = pixelSize
        self.animated = animated
        self.sources = sources
        let value = [
            "prepared-emoji-v1", "\(identifier):\(revision)", String(pixelSize), String(animated),
            sources.map { $0.url.absoluteString }.joined(separator: "|"),
        ].joined(separator: "|")
        self.cacheKey = SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// Immutable frames can be shared by every visible copy without copying pixels.
final class PreparedEmojiAnimation: Sendable {
    let frames: [UIImage]
    let durations: [TimeInterval]
    let frameEnds: [TimeInterval]
    let duration: TimeInterval
    let memoryCost: Int

    init(frames: [UIImage], durations: [TimeInterval]) {
        precondition(!frames.isEmpty && frames.count == durations.count)
        self.frames = frames
        self.durations = durations.map { max(0.02, $0.isFinite ? $0 : 0.1) }
        var end = 0.0
        self.frameEnds = self.durations.map { delay in
            end += delay
            return end
        }
        self.duration = end
        self.memoryCost = frames.reduce(0) { total, frame in
            total + (frame.cgImage.map { $0.bytesPerRow * $0.height } ?? 0)
        }
    }

    func frameIndex(at elapsed: TimeInterval) -> Int {
        guard elapsed.isFinite, elapsed > 0 else { return 0 }
        let position = elapsed.truncatingRemainder(dividingBy: duration)
        var lower = 0
        var upper = frameEnds.count
        while lower < upper {
            let middle = (lower + upper) / 2
            if frameEnds[middle] <= position { lower = middle + 1 } else { upper = middle }
        }
        return min(lower, frames.count - 1)
    }
}
