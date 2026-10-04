import PhotosUI
import SwiftUI

struct GroupAvatarPicker: View {
    let participants: [CloudGroupParticipant]
    let imageSource: String?
    var size: CGFloat = 56
    var disabled = false
    let onChange: (String?) async throws -> Void

    @State private var selectedPhoto: PhotosPickerItem?
    @State private var isPhotoPickerPresented = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        Menu {
            Button("Upload photo", systemImage: "photo") {
                isPhotoPickerPresented = true
            }
            if imageSource != nil {
                Button("Remove image", systemImage: "trash", role: .destructive) { save(nil) }
            }
        } label: {
            GroupAvatarStack(participants: participants, size: size, imageSource: imageSource)
                .overlay(alignment: .bottomTrailing) {
                    Group {
                        if isSaving {
                            ProgressView().controlSize(.mini).tint(.white)
                        } else {
                            Image(systemName: "camera.fill")
                                .font(.system(size: 10, weight: .semibold))
                        }
                    }
                    .foregroundStyle(.white)
                    .frame(width: 21, height: 21)
                    .background(KordiTheme.signalBlue, in: .rect(cornerRadius: 6))
                    .overlay {
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(Color(uiColor: .systemBackground), lineWidth: 2)
                    }
                }
                .accessibilityHidden(true)
        }
        .buttonStyle(.plain)
        .disabled(disabled || isSaving)
        .accessibilityLabel(isSaving ? "Saving group image" : "Edit group avatar")
        .accessibilityHint("Upload or remove a group photo")
        .photosPicker(isPresented: $isPhotoPickerPresented, selection: $selectedPhoto, matching: .images)
        .alert("Could not update group image", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Try again.")
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
