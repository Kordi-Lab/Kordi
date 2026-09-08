import Observation
import PhotosUI
import SwiftUI

@MainActor @Observable
final class LivePhotoPlayback {
    private(set) var photo: PHLivePhoto?
    private(set) var isLoading = false
    private(set) var failed = false
    private(set) var playRequest = 0
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    func play(load: @escaping @MainActor () async throws -> PHLivePhoto) {
        if photo != nil { playRequest += 1; return }
        guard !isLoading else { return }
        isLoading = true
        failed = false
        loadTask = Task { [weak self] in
            do {
                let result = try await load()
                try Task.checkCancellation()
                self?.photo = result
                self?.playRequest += 1
            } catch {
                if !Task.isCancelled { self?.failed = true }
            }
            if !Task.isCancelled { self?.isLoading = false; self?.loadTask = nil }
        }
    }

    func reset() {
        loadTask?.cancel()
        loadTask = nil
        photo = nil
        isLoading = false
        failed = false
        playRequest = 0
    }
}

struct LivePhotoPlaybackButton: View {
    let playback: LivePhotoPlayback
    let onPlay: () -> Void

    var body: some View {
        Button(action: onPlay) {
            HStack(spacing: 8) {
                if playback.isLoading { ProgressView().tint(.white) }
                else { Image(systemName: "livephoto") }
            }
            .font(.system(size: 22, weight: .medium))
            .frame(width: 44, height: 44)
            .foregroundStyle(.white)
            .background(.white.opacity(0.12), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(playback.isLoading)
        .accessibilityLabel("Play Live Photo")
        .accessibilityHint("Plays motion and sound. Press and hold the loaded photo to play again.")
    }
}

struct LivePhotoImageSurface: View {
    let image: UIImage?
    let livePhoto: PHLivePhoto?
    let playRequest: Int
    let label: String

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .accessibilityLabel(label)
                }
                if let livePhoto {
                    NativeLivePhotoView(photo: livePhoto, playRequest: playRequest)
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .accessibilityLabel(label)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
    }
}

struct NativeLivePhotoView: UIViewRepresentable {
    let photo: PHLivePhoto
    let playRequest: Int
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> PHLivePhotoView {
        let view = PHLivePhotoView()
        view.contentMode = .scaleAspectFit
        view.clipsToBounds = true
        view.isMuted = false
        return view
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: PHLivePhotoView, context: Context) -> CGSize? {
        proposal.replacingUnspecifiedDimensions(by: .zero)
    }
    func updateUIView(_ view: PHLivePhotoView, context: Context) {
        if view.livePhoto !== photo { view.livePhoto = photo }
        if context.coordinator.playRequest != playRequest {
            context.coordinator.playRequest = playRequest
            view.startPlayback(with: .full)
        }
    }
    static func dismantleUIView(_ view: PHLivePhotoView, coordinator: Coordinator) {
        view.stopPlayback()
        view.livePhoto = nil
    }
    final class Coordinator { var playRequest = 0 }
}

struct LivePhotoLibraryReview: View {
    @Environment(\.dismiss) private var dismiss
    let asset: PHAsset
    @Binding var sendsStillOnly: Bool
    @State private var image: UIImage?
    @State private var playback = LivePhotoPlayback()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Review Live Photo").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .font(.body.weight(.semibold)).frame(minWidth: 44, minHeight: 44)
            }
            .padding(.horizontal, 20).padding(.vertical, 8)
            LivePhotoImageSurface(image: image, livePhoto: playback.photo, playRequest: playback.playRequest, label: "Selected Live Photo")
            VStack(spacing: 12) {
                if playback.failed { Text("Live playback unavailable. Try again.").font(.caption).foregroundStyle(.secondary) }
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(sendsStillOnly ? "Still photo" : "Live Photo").font(.subheadline.weight(.semibold))
                        Text(sendsStillOnly ? "Motion will not be sent" : "Motion and sound included")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    LivePhotoPlaybackButton(playback: playback) {
                        playback.play { try await LivePhotoMedia.fromLibrary(asset) }
                    }
                }
                Toggle("Send as Live Photo", isOn: Binding(get: { !sendsStillOnly }, set: { sendsStillOnly = !$0 }))
                    .tint(KordiTheme.signalBlue).font(.subheadline)
            }
            .padding(20)
        }
        .background(.black)
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .onDisappear { playback.reset() }
        .task {
            if let data = try? await PhotoLibraryAttachmentLoader.imageData(for: asset) { image = UIImage(data: data) }
        }
    }
}
