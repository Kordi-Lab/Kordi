import Foundation
import ImageIO
import SwiftUI
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import Kordi

private actor EmojiFixtureSource {
    let data: Data
    var blocked: Bool
    private(set) var calls = 0
    private var pending: [CheckedContinuation<Data, Never>] = []
    private var observers: [(Int, CheckedContinuation<Void, Never>)] = []

    init(data: Data, blocked: Bool = false) {
        self.data = data
        self.blocked = blocked
    }

    func load() async -> Data {
        calls += 1
        let ready = observers.filter { $0.0 <= calls }
        observers.removeAll { $0.0 <= calls }
        ready.forEach { $0.1.resume() }
        if blocked { return await withCheckedContinuation { pending.append($0) } }
        return data
    }

    func waitForCalls(_ count: Int) async {
        if calls >= count { return }
        await withCheckedContinuation { observers.append((count, $0)) }
    }

    func release() {
        blocked = false
        let continuations = pending
        pending.removeAll()
        continuations.forEach { $0.resume(returning: data) }
    }
}

@MainActor
struct EmojiAnimationTests {
    private func fixture() throws -> Data {
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(
            data, UTType.gif.identifier as CFString, 3, nil
        ))
        for (color, delay) in zip([UIColor.red, .green, .blue], [0.03, 0.2, 0.05]) {
            let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
                color.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
            }
            CGImageDestinationAddImage(destination, try #require(image.cgImage), [
                kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay],
            ] as CFDictionary)
        }
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private func request(_ id: String = "fixture", pixels: Int = 24) -> EmojiAnimationRequest {
        EmojiAnimationRequest(
            identifier: id, revision: "test-v1", pixelSize: pixels, animated: true,
            sources: [.init(url: URL(string: "https://fonts.gstatic.com/fixture.gif")!, mediaType: "image/gif")]
        )
    }

    private func ready(_ stream: AsyncStream<EmojiAnimationPhase>) async throws -> PreparedEmojiAnimation {
        var result: PreparedEmojiAnimation?
        for await phase in stream {
            if case .ready(let animation) = phase { result = animation }
        }
        return try #require(result)
    }

    @Test func repeatedEmojiSharePreparationAndFirstFrame() async throws {
        let source = EmojiFixtureSource(data: try fixture(), blocked: true)
        let repository = EmojiAnimationRepository(disk: .init(directory: nil)) { _ in await source.load() }
        let first = await repository.phases(for: request())
        let second = await repository.phases(for: request())
        await source.waitForCalls(1)
        #expect(await source.calls == 1)
        await source.release()

        var firstPhases: [EmojiAnimationPhase] = []
        for await phase in first { firstPhases.append(phase) }
        guard case .firstFrame = try #require(firstPhases.first) else {
            Issue.record("A first frame must be published before the prepared animation.")
            return
        }
        guard case .ready(let firstAnimation) = try #require(firstPhases.last) else {
            Issue.record("Preparation must complete.")
            return
        }
        let secondAnimation = try await ready(second)
        #expect(firstAnimation === secondAnimation)
        #expect(firstAnimation.frames.count == 3)
        #expect(await source.calls == 1)
    }

    @Test func cancellingOneCopyDoesNotCancelAnotherCopy() async throws {
        let source = EmojiFixtureSource(data: try fixture(), blocked: true)
        let repository = EmojiAnimationRepository(disk: .init(directory: nil)) { _ in await source.load() }
        let first = await repository.phases(for: request())
        let second = await repository.phases(for: request())
        let cancelledConsumer = Task { for await _ in first {} }
        await source.waitForCalls(1)
        cancelledConsumer.cancel()
        await cancelledConsumer.value
        await source.release()
        let animation = try await ready(second)
        #expect(animation.frames.count == 3)
        #expect(await source.calls == 1)
    }

    @Test func preparationConcurrencyIsBounded() async throws {
        let source = EmojiFixtureSource(data: try fixture(), blocked: true)
        let repository = EmojiAnimationRepository(disk: .init(directory: nil), concurrency: 2) {
            _ in await source.load()
        }
        let streams = await [
            repository.phases(for: request("one")),
            repository.phases(for: request("two")),
            repository.phases(for: request("three")),
        ]
        await source.waitForCalls(2)
        #expect(await source.calls == 2)
        await source.release()
        for stream in streams { _ = try await ready(stream) }
        #expect(await source.calls == 3)
    }

    @Test func preparedFramesSurviveRepositoryRecreationWithoutFetchingSource() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = EmojiAnimationDiskCache(directory: directory)
        let source = EmojiFixtureSource(data: try fixture())
        let original = EmojiAnimationRepository(disk: disk) { _ in await source.load() }
        let prepared = try await ready(await original.phases(for: request()))
        let reopened = EmojiAnimationRepository(disk: disk) { _ in throw URLError(.notConnectedToInternet) }
        let restored = try await ready(await reopened.phases(for: request()))
        #expect(restored.frames.count == prepared.frames.count)
        #expect(restored.durations == prepared.durations)
        #expect(restored.frames[0].size == prepared.frames[0].size)
        #expect(await source.calls == 1)
    }

    @Test func corruptPreparedCacheFallsBackToSource() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = EmojiAnimationDiskCache(directory: directory)
        let source = EmojiFixtureSource(data: try fixture())
        let repository = EmojiAnimationRepository(disk: disk) { _ in await source.load() }
        _ = try await ready(await repository.phases(for: request()))
        let manifest = directory.appendingPathComponent(request().cacheKey).appendingPathComponent("frames.plist")
        try Data("invalid".utf8).write(to: manifest)
        let reopened = EmojiAnimationRepository(disk: disk) { _ in await source.load() }
        #expect(try await ready(await reopened.phases(for: request())).frames.count == 3)
        #expect(await source.calls == 2)
    }

    @Test func cacheIdentityIncludesSizeRevisionAndAnimationMode() {
        let base = request()
        #expect(base.cacheKey != request(pixels: 48).cacheKey)
        #expect(base.cacheKey != EmojiAnimationRequest(
            identifier: base.identifier, revision: "test-v2", pixelSize: base.pixelSize,
            animated: true, sources: base.sources
        ).cacheKey)
        #expect(base.cacheKey != EmojiAnimationRequest(
            identifier: base.identifier, revision: base.revision, pixelSize: base.pixelSize,
            animated: false, sources: base.sources
        ).cacheKey)
    }

    @Test func diskCacheEvictsOldEntriesWithinItsBudget() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = EmojiAnimationDiskCache(
            directory: directory, maximumBytes: 64 * 1_024, maximumEntries: 1
        )
        let source = EmojiFixtureSource(data: try fixture())
        let repository = EmojiAnimationRepository(disk: disk) { _ in await source.load() }
        _ = try await ready(await repository.phases(for: request("older")))
        _ = try await ready(await repository.phases(for: request("newer")))
        #expect(!FileManager.default.fileExists(
            atPath: directory.appendingPathComponent(request("older").cacheKey).path
        ))
        #expect(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent(request("newer").cacheKey).path
        ))
        let reopened = EmojiAnimationRepository(disk: disk) { _ in await source.load() }
        _ = try await ready(await reopened.phases(for: request("older")))
        #expect(await source.calls == 3)
    }

    @Test func failedLoadFinishesWithoutRemovingTheCallerFallback() async {
        let repository = EmojiAnimationRepository(disk: .init(directory: nil)) { _ in
            throw URLError(.notConnectedToInternet)
        }
        var count = 0
        for await _ in await repository.phases(for: request()) { count += 1 }
        #expect(count == 0)
    }

    @Test func frameClockPreservesVariableDelaysAndJoinsCurrentFrame() throws {
        let data = try fixture()
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let frames = try (0..<3).map {
            try #require(AnimatedImageDecoder.frame(from: source, index: $0, maximumPixelSize: 24))
        }
        let animation = PreparedEmojiAnimation(frames: frames, durations: [0.03, 0.2, 0.05])
        #expect(animation.frameIndex(at: 0.02) == 0)
        #expect(animation.frameIndex(at: 0.04) == 1)
        #expect(animation.frameIndex(at: 0.22) == 1)
        #expect(animation.frameIndex(at: 0.24) == 2)
        #expect(animation.frameIndex(at: 0.29) == 0)

        let coordinator = EmojiPlaybackCoordinator()
        let first = EmojiAnimationRenderView()
        let second = EmojiAnimationRenderView()
        coordinator.attach(first, key: "joy", animation: animation)
        coordinator.tick(at: 100)
        coordinator.tick(at: 100.1)
        coordinator.attach(second, key: "joy", animation: animation)
        #expect((second.layer.contents as AnyObject?) === frames[1].cgImage)
        coordinator.detach(first, key: "joy")
        #expect(coordinator.animation(for: "joy") === animation)
        coordinator.detach(second, key: "joy")
        #expect(coordinator.animation(for: "joy") == nil)
    }

    @Test func aRepeatedVisibleEmojiHasAFullSizeRenderSurfaceImmediately() throws {
        let data = try fixture()
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let frame = try #require(AnimatedImageDecoder.frame(
            from: source, index: 0, maximumPixelSize: 66
        ))
        let animation = PreparedEmojiAnimation(frames: [frame, frame], durations: [0.1, 0.1])
        let request = request("visible-\(UUID().uuidString)", pixels: 66)
        let existingCopy = EmojiAnimationRenderView()
        EmojiPlaybackCoordinator.shared.attach(existingCopy, key: request.cacheKey, animation: animation)
        defer { EmojiPlaybackCoordinator.shared.detach(existingCopy, key: request.cacheKey) }

        let host = UIHostingController(rootView: SharedEmojiAnimationView(
            request: request, fallback: "😂", size: 22
        ))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.isHidden = false
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        func renderSurface(in view: UIView) -> EmojiAnimationRenderView? {
            if let surface = view as? EmojiAnimationRenderView { return surface }
            return view.subviews.lazy.compactMap { renderSurface(in: $0) }.first
        }
        let surface = try #require(renderSurface(in: host.view))
        #expect(surface.bounds.size == CGSize(width: 22, height: 22))
        #expect(surface.layer.contents != nil)
    }
}
