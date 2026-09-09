import Foundation
import ImageIO
import UIKit

enum EmojiAnimationPhase: Sendable {
    case firstFrame(UIImage)
    case ready(PreparedEmojiAnimation)
}

/// Shares preparation, including cancellation, across all copies of an emoji.
actor EmojiAnimationRepository {
    typealias SourceLoader = @Sendable (EmojiAnimationRequest.Source) async throws -> Data
    static let shared = EmojiAnimationRepository()

    private struct Job {
        let request: EmojiAnimationRequest
        let generation: UUID
        var subscribers: [UUID: AsyncStream<EmojiAnimationPhase>.Continuation]
        var task: Task<Void, Never>?
    }

    private let animations = NSCache<NSString, PreparedEmojiAnimation>()
    private let firstFrames = NSCache<NSString, UIImage>()
    private let disk: EmojiAnimationDiskCache
    private let sourceLoader: SourceLoader
    private let concurrency: Int
    private var jobs: [String: Job] = [:]
    private var pending: [String] = []
    private var activeCount = 0

    init(
        disk: EmojiAnimationDiskCache = .standard,
        concurrency: Int = 4,
        sourceLoader: @escaping SourceLoader = { source in
            try await EmojiAnimationRepository.loadSource(source)
        }
    ) {
        self.disk = disk
        self.concurrency = max(1, concurrency)
        self.sourceLoader = sourceLoader
        animations.totalCostLimit = 32 * 1_024 * 1_024
        animations.countLimit = 192
        firstFrames.totalCostLimit = 4 * 1_024 * 1_024
        firstFrames.countLimit = 512
    }

    func phases(for request: EmojiAnimationRequest) -> AsyncStream<EmojiAnimationPhase> {
        let (stream, continuation) = AsyncStream<EmojiAnimationPhase>.makeStream(
            bufferingPolicy: .bufferingNewest(2)
        )
        let key = request.cacheKey
        if let animation = animations.object(forKey: key as NSString) {
            continuation.yield(.ready(animation))
            continuation.finish()
            return stream
        }
        if let frame = firstFrames.object(forKey: request.previewKey as NSString) {
            continuation.yield(.firstFrame(frame))
        }
        let subscriber = UUID()
        if jobs[key] == nil {
            jobs[key] = Job(request: request, generation: UUID(), subscribers: [:])
            pending.append(key)
        }
        jobs[key]?.subscribers[subscriber] = continuation
        let generation = jobs[key]!.generation
        continuation.onTermination = { [weak self] termination in
            if case .cancelled = termination {
                Task { await self?.unsubscribe(key: key, generation: generation, subscriber: subscriber) }
            }
        }
        startPendingJobs()
        return stream
    }

    private func unsubscribe(key: String, generation: UUID, subscriber: UUID) {
        guard jobs[key]?.generation == generation else { return }
        jobs[key]?.subscribers.removeValue(forKey: subscriber)
        if jobs[key]?.subscribers.isEmpty == true {
            jobs[key]?.task?.cancel()
            jobs.removeValue(forKey: key)
            pending.removeAll { $0 == key }
        }
    }

    private func startPendingJobs() {
        while activeCount < concurrency, !pending.isEmpty {
            let key = pending.removeFirst()
            guard let job = jobs[key] else { continue }
            activeCount += 1
            let request = job.request
            let generation = job.generation
            let disk = self.disk
            let loader = sourceLoader
            let repository = self
            // A bounded, shared job must outlive any one view and perform ImageIO
            // and disk work away from both the main actor and the repository.
            jobs[key]?.task = Task.detached(priority: .userInitiated) {
                await Self.prepare(request, disk: disk, loader: loader) { phase in
                    await repository.publish(phase, request: request, generation: generation)
                }
                await repository.finish(key: key, generation: generation)
            }
        }
    }

    private func publish(
        _ phase: EmojiAnimationPhase,
        request: EmojiAnimationRequest,
        generation: UUID
    ) {
        guard let job = jobs[request.cacheKey], job.generation == generation else { return }
        switch phase {
        case .firstFrame(let frame):
            rememberFirstFrame(frame, key: request.previewKey)
        case .ready(let animation):
            animations.setObject(animation, forKey: request.cacheKey as NSString, cost: animation.memoryCost)
            rememberFirstFrame(animation.frames[0], key: request.previewKey)
        }
        for subscriber in job.subscribers.values { subscriber.yield(phase) }
    }

    private func rememberFirstFrame(_ frame: UIImage, key: String) {
        let cost = frame.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        firstFrames.setObject(frame, forKey: key as NSString, cost: cost)
    }

    private func finish(key: String, generation: UUID) {
        if let job = jobs[key], job.generation == generation {
            jobs.removeValue(forKey: key)
            for subscriber in job.subscribers.values { subscriber.finish() }
        }
        activeCount -= 1
        startPendingJobs()
    }

    private nonisolated static func prepare(
        _ request: EmojiAnimationRequest,
        disk: EmojiAnimationDiskCache,
        loader: SourceLoader,
        publish: @Sendable (EmojiAnimationPhase) async -> Void
    ) async {
        guard (1...512).contains(request.pixelSize), !Task.isCancelled else { return }
        if let frame = disk.firstFrame(for: request) { await publish(.firstFrame(frame)) }
        if let animation = disk.animation(for: request), !Task.isCancelled {
            await publish(.ready(animation))
            return
        }
        for source in request.sources {
            guard !Task.isCancelled else { return }
            guard let data = try? await loader(source), data.count <= 4 * 1_024 * 1_024,
                  !Task.isCancelled,
                  let imageSource = CGImageSourceCreateWithData(
                    data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary
                  ),
                  let first = AnimatedImageDecoder.frame(
                    from: imageSource, index: 0, maximumPixelSize: CGFloat(request.pixelSize)
                  ) else { continue }
            await publish(.firstFrame(first))
            let count = request.animated ? CGImageSourceGetCount(imageSource) : 1
            guard count > 0, count <= 600 else { return }
            var frames = [first]
            var durations = [AnimatedImageDecoder.frameDuration(source: imageSource, index: 0)]
            var cost = first.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
            for index in 1..<count {
                guard !Task.isCancelled else { return }
                let frame = autoreleasepool {
                    AnimatedImageDecoder.frame(
                        from: imageSource, index: index, maximumPixelSize: CGFloat(request.pixelSize)
                    )
                }
                guard let frame, let cgImage = frame.cgImage else { return }
                cost += cgImage.bytesPerRow * cgImage.height
                guard cost <= 32 * 1_024 * 1_024 else { return }
                frames.append(frame)
                durations.append(AnimatedImageDecoder.frameDuration(source: imageSource, index: index))
            }
            guard !Task.isCancelled else { return }
            let animation = PreparedEmojiAnimation(frames: frames, durations: durations)
            await publish(.ready(animation))
            // Publish before encoding PNG frames, so persistence never delays
            // the first presentation. The concurrency limit also bounds writers.
            disk.store(animation, for: request)
            return
        }
    }

    nonisolated static func loadSource(_ source: EmojiAnimationRequest.Source) async throws -> Data {
        if source.url.isFileURL {
            let values = try source.url.resourceValues(forKeys: [.fileSizeKey])
            guard let size = values.fileSize, size <= 4 * 1_024 * 1_024 else {
                throw CocoaError(.fileReadTooLarge)
            }
            return try Data(contentsOf: source.url, options: .mappedIfSafe)
        }
        guard source.url.scheme == "https", source.url.host == "fonts.gstatic.com" else {
            throw URLError(.unsupportedURL)
        }
        var request = URLRequest(url: source.url, cachePolicy: .returnCacheDataElseLoad)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse,
              response.statusCode == 200,
              response.url?.scheme == "https", response.url?.host == "fonts.gstatic.com",
              response.mimeType == source.mediaType, data.count <= 4 * 1_024 * 1_024 else {
            throw URLError(.badServerResponse)
        }
        return data
    }
}
