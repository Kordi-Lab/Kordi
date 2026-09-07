import PhotosUI
import SwiftUI

struct LivePhotoSurface: View {
    let load: () async throws -> PHLivePhoto
    @State private var photo: PHLivePhoto?
    @State private var loading = false
    @State private var failed = false
    @State private var playRequest = 0
    @State private var request = 0

    var body: some View {
        ZStack(alignment: .bottom) {
            if let photo {
                NativeLivePhotoView(photo: photo, playRequest: playRequest)
                    .accessibilityLabel("Live Photo")
            }
            VStack(spacing: 8) {
                if failed { Text("Live playback unavailable. Try again.").font(.caption) }
                Button {
                    if photo != nil { playRequest += 1 }
                    else { request += 1 }
                } label: {
                    Label(loading ? "Loading Live Photo" : "Live", systemImage: "livephoto")
                        .padding(.horizontal, 16).frame(minHeight: 44)
                        .background(.ultraThinMaterial, in: Capsule())
                }
                .disabled(loading)
                .accessibilityHint("Plays motion and sound. You can also press and hold the loaded photo.")
            }
            .padding(.bottom, 12)
        }
        .task(id: request) {
            guard request > 0 else { return }
            loading = true
            failed = false
            defer { loading = false }
            do {
                let result = try await load()
                try Task.checkCancellation()
                photo = result
                playRequest += 1
            } catch {
                if !Task.isCancelled { failed = true }
            }
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
        view.isMuted = false
        return view
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

    var body: some View {
        NavigationStack {
            VStack {
                ZStack {
                    if let image { Image(uiImage: image).resizable().scaledToFit() }
                    LivePhotoSurface { try await LivePhotoMedia.fromLibrary(asset) }
                }
                Toggle("Send still image only", isOn: $sendsStillOnly)
                    .padding()
            }
            .navigationTitle("Review Live Photo")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .task {
            if let data = try? await PhotoLibraryAttachmentLoader.imageData(for: asset) { image = UIImage(data: data) }
        }
    }
}
