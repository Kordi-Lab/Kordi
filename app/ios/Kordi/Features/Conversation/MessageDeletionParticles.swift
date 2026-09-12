import SwiftUI
import UIKit
import MetalKit

@MainActor
final class MessageDeleteCaptureFrames {
    var frames: [String: CGRect] = [:]
    var rows: [String: CGRect] = [:]
    var attachments: [String: CGRect] = [:]
    private var captureGate: MessageDeleteDisplayGate?

    func afterSourceRestored(_ completion: @escaping () -> Void) {
        cancelPendingCapture()
        captureGate = MessageDeleteDisplayGate { [weak self] in
            self?.captureGate = nil
            completion()
        }
    }

    func cancelPendingCapture() {
        captureGate?.cancel()
        captureGate = nil
    }
}

@MainActor
private final class MessageDeleteDisplayGate: NSObject {
    private var link: CADisplayLink?
    private var framesRemaining = 2
    private var completion: (() -> Void)?
    private var timeout: DispatchWorkItem?

    init(completion: @escaping () -> Void) {
        self.completion = completion
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        self.link = link
        link.add(to: .main, forMode: .common)
        let timeout = DispatchWorkItem { [weak self] in self?.finish() }
        self.timeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: timeout)
    }

    @objc private func tick() {
        framesRemaining -= 1
        if framesRemaining <= 0 { finish() }
    }

    private func finish() {
        let action = completion
        cancel()
        action?()
    }

    func cancel() {
        link?.invalidate()
        link = nil
        timeout?.cancel()
        timeout = nil
        completion = nil
    }
}

struct MessageDeleteSnapshot: Identifiable {
    let id = UUID()
    let messageID: String
    let image: UIImage
    let frame: CGRect
    var attachmentID: String? = nil

    @MainActor
    static func capture(messageID: String, frame: CGRect, attachmentID: String? = nil) -> Self? {
        guard let captured = captureImage(frame: frame) else { return nil }
        return Self(messageID: messageID, image: captured.image, frame: captured.frame, attachmentID: attachmentID)
    }

    @MainActor
    static func captureImage(frame: CGRect) -> (image: UIImage, frame: CGRect)? {
        guard !frame.isEmpty,
              let window = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene }).flatMap(\.windows)
                .first(where: \.isKeyWindow),
              let root = window.rootViewController?.view else { return nil }
        let clipped = frame.intersection(window.bounds).integral
        guard !clipped.isEmpty, !clipped.isNull else { return nil }
        let localFrame = root.convert(clipped, from: window)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: clipped.size, format: format)
        let image = renderer.image { context in
            context.cgContext.translateBy(x: -localFrame.minX, y: -localFrame.minY)
            // Capture only the app root, excluding the stationary overlay attached to the window.
            root.drawHierarchy(in: root.bounds, afterScreenUpdates: false)
        }
        return (image, clipped)
    }
}

enum MessageDeleteReflow {
    static func offsets(before: [String: CGRect], after: [String: CGRect]) -> [String: CGFloat] {
        before.reduce(into: [:]) { result, entry in
            guard let destination = after[entry.key] else { return }
            let offset = entry.value.minY - destination.minY
            if abs(offset) >= 0.5 { result[entry.key] = offset }
        }
    }
}

enum MessageDeleteParticleGeometry {
    static let duration: TimeInterval = 0.8
    static let maximumParticles = 3_200

    static func grid(width: Int, height: Int) -> (cellSize: Int, columns: Int, rows: Int) {
        guard width > 0, height > 0 else { return (3, 0, 0) }
        var cell = max(3, Int(ceil(sqrt(Double(width) * Double(height) / Double(maximumParticles)))))
        while ((width + cell - 1) / cell) * ((height + cell - 1) / cell) > maximumParticles {
            cell += 1
        }
        return (cell, (width + cell - 1) / cell, (height + cell - 1) / cell)
    }
}

// SwiftUI has no public API for snapshotting an existing row's UIView subtree.
// A paired capture, while its layout is retained, removes the unchanged wallpaper
// and empty avatar/spacing regions without reconstructing text, stickers or media.
enum MessageDeleteSnapshotMask {
    static func image(source: CGImage, background: CGImage) -> CGImage? {
        let width = source.width
        let height = source.height
        guard width == background.width, height == background.height,
              width > 0, height > 0,
              var foreground = rgba(source), let behind = rgba(background) else { return nil }
        var hasContent = false
        for index in stride(from: 0, to: foreground.count, by: 4) {
            let difference = max(
                abs(Int(foreground[index]) - Int(behind[index])),
                abs(Int(foreground[index + 1]) - Int(behind[index + 1])),
                abs(Int(foreground[index + 2]) - Int(behind[index + 2]))
            )
            if difference <= 2 {
                foreground[index] = 0
                foreground[index + 1] = 0
                foreground[index + 2] = 0
                foreground[index + 3] = 0
            } else {
                hasContent = true
            }
        }
        guard hasContent,
              let provider = CGDataProvider(data: Data(foreground) as CFData) else { return nil }
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
                .union(.byteOrder32Big),
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent
        )
    }

    private static func rgba(_ image: CGImage) -> [UInt8]? {
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let success = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        return success ? bytes : nil
    }
}

struct MessageDeleteParticleOverlay: View {
    let snapshot: MessageDeleteSnapshot
    let reduceMotion: Bool
    let onRemoveSource: () -> Bool
    let onInstallOffsets: () -> Bool
    let onAnimate: (TimeInterval) -> Bool
    let onComplete: () -> Void

    private var usesReducedMotion: Bool {
        #if DEBUG
        reduceMotion || (ProcessInfo.processInfo.arguments.contains("--preview-data")
            && ProcessInfo.processInfo.arguments.contains("--preview-particle-fade"))
        #else
        reduceMotion
        #endif
    }

    var body: some View {
        MessageDeleteParticleSurface(
            snapshot: snapshot, reduceMotion: usesReducedMotion,
            onRemoveSource: onRemoveSource, onInstallOffsets: onInstallOffsets,
            onAnimate: onAnimate, onComplete: onComplete
        )
        .frame(width: snapshot.frame.width, height: snapshot.frame.height)
        .position(x: snapshot.frame.midX, y: snapshot.frame.midY)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct MessageDeleteParticleSurface: UIViewRepresentable {
    let snapshot: MessageDeleteSnapshot
    let reduceMotion: Bool
    let onRemoveSource: () -> Bool
    let onInstallOffsets: () -> Bool
    let onAnimate: (TimeInterval) -> Bool
    let onComplete: () -> Void

    func makeUIView(context: Context) -> MessageDeleteParticleContainer {
        MessageDeleteParticleContainer(snapshot: snapshot, reduceMotion: reduceMotion,
                                       onRemoveSource: onRemoveSource, onInstallOffsets: onInstallOffsets,
            onAnimate: onAnimate, onComplete: onComplete)
    }

    func updateUIView(_ view: MessageDeleteParticleContainer, context: Context) {}

    static func dismantleUIView(_ view: MessageDeleteParticleContainer, coordinator: ()) {
        view.cancel()
    }
}

private final class MessageDeleteParticleContainer: UIView {
    private let snapshot: MessageDeleteSnapshot
    private let reduceMotion: Bool
    private let onRemoveSource: () -> Bool
    private let onInstallOffsets: () -> Bool
    private let onAnimate: (TimeInterval) -> Bool
    private let onComplete: () -> Void
    private let imageView = UIImageView()
    private var displayLink: CADisplayLink?
    private enum Phase { case background, layout, offsets }
    private var phase = Phase.background
    private var framesUntilCapture = 2
    private var frozenTimeline: UIView?
    private var preparation: Task<Void, Never>?
    private var particles: MessageDeleteParticleRenderer?

    init(snapshot: MessageDeleteSnapshot, reduceMotion: Bool,
         onRemoveSource: @escaping () -> Bool, onInstallOffsets: @escaping () -> Bool,
         onAnimate: @escaping (TimeInterval) -> Bool, onComplete: @escaping () -> Void) {
        self.snapshot = snapshot
        self.reduceMotion = reduceMotion
        self.onRemoveSource = onRemoveSource
        self.onInstallOffsets = onInstallOffsets
        self.onAnimate = onAnimate
        self.onComplete = onComplete
        super.init(frame: CGRect(origin: .zero, size: snapshot.frame.size))
        isUserInteractionEnabled = false
        backgroundColor = .clear
        imageView.image = snapshot.image
        imageView.frame = bounds
        imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(imageView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("Use the snapshot initializer.") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, displayLink == nil, preparation == nil else { return }
        waitForFrames()
    }

    private func waitForFrames() {
        framesUntilCapture = 2
        let link = CADisplayLink(target: self, selector: #selector(nextFrame))
        displayLink = link
        link.add(to: .main, forMode: .common)
    }

    @objc private func nextFrame() {
        framesUntilCapture -= 1
        guard framesUntilCapture <= 0 else { return }
        displayLink?.invalidate()
        displayLink = nil
        switch phase {
        case .layout:
            guard onInstallOffsets() else { cancel(); return }
            phase = .offsets
            waitForFrames()
            return
        case .offsets:
            guard onAnimate(MessageDeleteParticleGeometry.duration) else { cancel(); return }
            frozenTimeline?.removeFromSuperview()
            frozenTimeline = nil
            imageView.isHidden = true
            particles?.start(onComplete: onComplete)
            return
        case .background:
            break
        }
        // Two display boundaries let SwiftUI hide the retained source without moving
        // its neighbors. The stationary image covers that change until the mask is ready.
        guard let source = snapshot.image.cgImage,
              let background = MessageDeleteSnapshot.captureImage(frame: snapshot.frame)?.image.cgImage else {
            finishWithoutSnapshot()
            return
        }
        preparation = Task { [weak self] in
            let masked = await Task.detached(priority: .userInitiated) {
                MessageDeleteSnapshotMask.image(source: source, background: background)
            }.value
            let resources = await MessageDeleteParticleResources.prepared.value
            guard !Task.isCancelled, let self else { return }
            guard let masked else { self.finishWithoutSnapshot(); return }
            self.play(image: UIImage(cgImage: masked), resources: resources)
        }
    }

    private func play(image: UIImage, resources: MessageDeleteParticleResources?) {
        // The opaque stationary capture must be replaced before layout starts moving.
        imageView.image = image
        if !reduceMotion, let resources,
           let renderer = MessageDeleteParticleRenderer(image: image, resources: resources) {
            #if DEBUG
            renderer.onFirstFrame = { [snapshot] in
                MessageDeleteParticleDiagnostics.record(snapshot: snapshot)
            }
            #endif
            renderer.frame = bounds
            renderer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            renderer.isUserInteractionEnabled = false
            insertSubview(renderer, belowSubview: imageView)
            particles = renderer
            renderer.layoutIfNeeded()
            freezeTimeline()
            guard onRemoveSource() else { cancel(); return }
            phase = .layout
            waitForFrames()
        } else {
            #if DEBUG
            MessageDeleteParticleDiagnostics.record(snapshot: snapshot, status: reduceMotion ? "reduced-motion" : "unavailable")
            #endif
            guard onRemoveSource() else { cancel(); return }
            UIView.animate(withDuration: 0.18, animations: { self.imageView.alpha = 0 }) { _ in
                self.onComplete()
            }
        }
    }

    private func finishWithoutSnapshot() {
        #if DEBUG
        MessageDeleteParticleDiagnostics.record(snapshot: snapshot, status: "empty-capture")
        #endif
        imageView.isHidden = true
        _ = onRemoveSource()
        onComplete()
    }

    private func freezeTimeline() {
        guard let window, let root = window.rootViewController?.view,
              let frozen = root.snapshotView(afterScreenUpdates: false) else { return }
        var overlay: UIView = self
        while let parent = overlay.superview, parent !== window { overlay = parent }
        guard overlay.superview === window else { return }
        frozen.frame = root.convert(root.bounds, to: window)
        frozen.isUserInteractionEnabled = false
        window.insertSubview(frozen, belowSubview: overlay)
        frozenTimeline = frozen
    }

    func cancel() {
        displayLink?.invalidate()
        displayLink = nil
        preparation?.cancel()
        preparation = nil
        particles?.stop()
        frozenTimeline?.removeFromSuperview()
        frozenTimeline = nil
    }
}

final class MessageDeleteParticleResources: @unchecked Sendable {
    let device: MTLDevice
    let queue: MTLCommandQueue
    let pipeline: MTLRenderPipelineState

    static let prepared: Task<MessageDeleteParticleResources?, Never> = Task.detached(priority: .utility) {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue(),
              let library = try? device.makeLibrary(source: shaderSource, options: nil),
              let vertex = library.makeFunction(name: "messageDeleteParticleVertex"),
              let fragment = library.makeFunction(name: "messageDeleteParticleFragment") else { return nil }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        descriptor.colorAttachments[0].isBlendingEnabled = true
        descriptor.colorAttachments[0].sourceRGBBlendFactor = .one
        descriptor.colorAttachments[0].sourceAlphaBlendFactor = .one
        descriptor.colorAttachments[0].destinationRGBBlendFactor = .oneMinusSourceAlpha
        descriptor.colorAttachments[0].destinationAlphaBlendFactor = .oneMinusSourceAlpha
        guard let pipeline = try? device.makeRenderPipelineState(descriptor: descriptor) else { return nil }
        return MessageDeleteParticleResources(device: device, queue: queue, pipeline: pipeline)
    }

    private init(device: MTLDevice, queue: MTLCommandQueue, pipeline: MTLRenderPipelineState) {
        self.device = device
        self.queue = queue
        self.pipeline = pipeline
    }
    private static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;

    struct ParticleVertex {
        float4 position [[position]];
        float2 textureCoordinate;
        float alpha;
    };

    constant float2 particleQuad[6] = {
        float2(0, 0), float2(1, 0), float2(0, 1),
        float2(1, 0), float2(0, 1), float2(1, 1)
    };

    float randomValue(uint value) {
        value ^= value >> 16;
        value *= 0x7feb352du;
        value ^= value >> 15;
        value *= 0x846ca68bu;
        value ^= value >> 16;
        return float(value) / 4294967295.0;
    }

    vertex ParticleVertex messageDeleteParticleVertex(
        uint vertexID [[vertex_id]],
        uint particleID [[instance_id]],
        constant float2 &size [[buffer(0)]],
        constant float &elapsed [[buffer(1)]],
        constant uint &columns [[buffer(2)]],
        constant uint &rows [[buffer(3)]],
        constant uint &usesReducedMotion [[buffer(4)]],
        constant float &cellSize [[buffer(5)]]
    ) {
        uint column = particleID % columns;
        uint row = particleID / columns;
        float2 corner = particleQuad[vertexID];
        float randomA = randomValue(particleID * 3u + 1u);
        float randomB = randomValue(particleID * 3u + 2u);
        float randomC = randomValue(particleID * 3u + 3u);
        bool reduceMotion = usesReducedMotion != 0;
        float rowFraction = (float(row) + 0.5) / float(rows);
        float activation = reduceMotion
            ? 0.0
            : clamp(rowFraction * 0.68 + (randomA - 0.5) * 0.14, 0.0, 0.76);
        float activationTime = activation * 0.8;
        float age = max(0.0, elapsed - activationTime);
        float fadeDuration = reduceMotion ? 0.18 : max(0.12, 0.8 - activationTime);
        float progress = smoothstep(0.0, fadeDuration, age);
        float angle = randomB * 6.2831853;
        float speed = 34.0 + randomC * 54.0;
        float2 velocity = float2(cos(angle), sin(angle)) * speed;
        float2 offset = reduceMotion
            ? float2(0.0)
            : velocity * age + float2(0.0, -65.0) * age * age;
        float particleSize = reduceMotion ? 1.0 : 1.0 - progress * 0.58;
        float2 origin = float2(float(column), float(row)) * cellSize;
        float2 tileSize = min(float2(cellSize), size - origin);
        float2 center = origin + tileSize * 0.5 + offset;
        float2 position = center + (corner - 0.5) * tileSize * particleSize;

        ParticleVertex result;
        result.position = float4(
            position.x / size.x * 2.0 - 1.0,
            1.0 - position.y / size.y * 2.0,
            0.0,
            1.0
        );
        result.textureCoordinate = (origin + corner * tileSize) / size;
        result.alpha = 1.0 - progress;
        return result;
    }

    fragment half4 messageDeleteParticleFragment(
        ParticleVertex input [[stage_in]],
        texture2d<half> snapshot [[texture(0)]]
    ) {
        constexpr sampler textureSampler(coord::normalized, address::clamp_to_edge, filter::linear);
        return snapshot.sample(textureSampler, input.textureCoordinate) * half(input.alpha);
    }
    """
}

private final class MessageDeleteParticleRenderer: MTKView, MTKViewDelegate {
    private let resources: MessageDeleteParticleResources
    private let texture: MTLTexture
    private let grid: (cellSize: Int, columns: Int, rows: Int)
    var onFirstFrame: (() -> Void)?
    private var startedAt: CFTimeInterval?
    private var onComplete: (() -> Void)?

    init?(image: UIImage, resources: MessageDeleteParticleResources) {
        guard let cgImage = image.cgImage,
              let texture = try? MTKTextureLoader(device: resources.device).newTexture(
                cgImage: cgImage, options: [.SRGB: false]
              ) else { return nil }
        self.resources = resources
        self.texture = texture
        self.grid = MessageDeleteParticleGeometry.grid(width: cgImage.width, height: cgImage.height)
        super.init(frame: CGRect(origin: .zero, size: image.size), device: resources.device)
        backgroundColor = .clear
        isOpaque = false
        clearColor = MTLClearColorMake(0, 0, 0, 0)
        colorPixelFormat = .bgra8Unorm
        framebufferOnly = true
        preferredFramesPerSecond = 60
        enableSetNeedsDisplay = false
        isPaused = true
        delegate = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("Use init(image:resources:).") }

    func start(onComplete: @escaping () -> Void) {
        self.onComplete = onComplete
        startedAt = CACurrentMediaTime()
        isPaused = false
        draw()
    }

    func stop() {
        isPaused = true
        onComplete = nil
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard let startedAt else { return }
        let duration = MessageDeleteParticleGeometry.duration
        var elapsed = Float(min(duration, CACurrentMediaTime() - startedAt))
        // Finish even when a drawable is temporarily unavailable (for example on lock).
        if elapsed >= Float(duration) {
            isPaused = true
            let completion = onComplete
            onComplete = nil
            DispatchQueue.main.async { completion?() }
            return
        }
        guard let descriptor = currentRenderPassDescriptor, let drawable = currentDrawable,
              let buffer = resources.queue.makeCommandBuffer(),
              let encoder = buffer.makeRenderCommandEncoder(descriptor: descriptor) else { return }
        var size = SIMD2<Float>(Float(texture.width), Float(texture.height))
        var columns = UInt32(grid.columns)
        var rows = UInt32(grid.rows)
        var reduceMotion: UInt32 = 0
        var cellSize = Float(grid.cellSize)
        encoder.setRenderPipelineState(resources.pipeline)
        encoder.setVertexBytes(&size, length: MemoryLayout<SIMD2<Float>>.stride, index: 0)
        encoder.setVertexBytes(&elapsed, length: MemoryLayout<Float>.stride, index: 1)
        encoder.setVertexBytes(&columns, length: MemoryLayout<UInt32>.stride, index: 2)
        encoder.setVertexBytes(&rows, length: MemoryLayout<UInt32>.stride, index: 3)
        encoder.setVertexBytes(&reduceMotion, length: MemoryLayout<UInt32>.stride, index: 4)
        encoder.setVertexBytes(&cellSize, length: MemoryLayout<Float>.stride, index: 5)
        encoder.setFragmentTexture(texture, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6,
                               instanceCount: grid.columns * grid.rows)
        encoder.endEncoding()
        buffer.present(drawable)
        buffer.commit()
        if let onFirstFrame {
            self.onFirstFrame = nil
            onFirstFrame()
        }
    }
}

#if DEBUG
@MainActor
private enum MessageDeleteParticleDiagnostics {
    private static var probe: UIView?

    static func record(snapshot: MessageDeleteSnapshot, status: String = "rendered") {
        guard ProcessInfo.processInfo.arguments.contains("--preview-data"),
              ProcessInfo.processInfo.arguments.contains("--preview-particle-probe"),
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .flatMap(\.windows).first(where: \.isKeyWindow) else { return }
        probe?.removeFromSuperview()
        let marker = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        marker.isUserInteractionEnabled = false
        marker.isAccessibilityElement = true
        marker.accessibilityIdentifier = "deletion-particles-" + status
        marker.accessibilityLabel = "Deletion particles rendered"
        marker.accessibilityValue = snapshot.messageID + ":" + (snapshot.attachmentID ?? "message")
        window.addSubview(marker)
        probe = marker
    }
}
#endif
