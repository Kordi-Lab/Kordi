import PhotosUI
import SwiftUI

struct GroupAvatarPicker: View {
    let participants: [CloudGroupParticipant]
    let imageSource: String?
    var disabled = false
    let onChange: (String?) async throws -> Void

    @State private var selectedPhoto: PhotosPickerItem?
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 16) {
                GroupAvatarStack(participants: participants, size: 56, imageSource: imageSource)
                VStack(alignment: .leading, spacing: 4) {
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Text(imageSource == nil ? "Choose group image" : "Change group image")
                            .frame(minHeight: 44)
                    }
                    .disabled(disabled || isSaving)
                    if imageSource != nil {
                        Button("Remove image", role: .destructive) { save(nil) }
                            .frame(minHeight: 44)
                            .disabled(disabled || isSaving)
                    }
                }
                if isSaving { ProgressView().accessibilityLabel("Saving group image") }
            }
            Text("Without an image, the group uses a collage of its members.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let errorMessage {
                Text(errorMessage).font(.caption).foregroundStyle(.red)
                    .accessibilityLabel("Group image error: \(errorMessage)")
            }
        }
        .onChange(of: selectedPhoto) { _, photo in
            guard let photo else { return }
            isSaving = true
            errorMessage = nil
            Task { @MainActor in
                defer { isSaving = false; selectedPhoto = nil }
                do {
                    guard let data = try await photo.loadTransferable(type: Data.self),
                          let prepared = SignupAvatarRenderer.uploadedImage(from: data) else {
                        throw GroupAvatarPickerError(message: "Choose a valid image smaller than 2 MB.")
                    }
                    try await onChange(prepared.dataURL)
                } catch { errorMessage = error.localizedDescription }
            }
        }
    }

    private func save(_ image: String?) {
        isSaving = true
        errorMessage = nil
        Task { @MainActor in
            defer { isSaving = false }
            do { try await onChange(image) } catch { errorMessage = error.localizedDescription }
        }
    }
}

struct GroupAvatarPickerError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
