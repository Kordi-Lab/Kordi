import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct CameraCapturePicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    let onVideo: (URL) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onImage: onImage, onVideo: onVideo, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        controller.cameraCaptureMode = .photo
        controller.videoQuality = .typeMedium
        controller.videoMaximumDuration = 60
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let onImage: (UIImage) -> Void
        let onVideo: (URL) -> Void
        let onCancel: () -> Void

        init(
            onImage: @escaping (UIImage) -> Void,
            onVideo: @escaping (URL) -> Void,
            onCancel: @escaping () -> Void
        ) {
            self.onImage = onImage
            self.onVideo = onVideo
            self.onCancel = onCancel
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage {
                onImage(image)
                return
            }
            if let url = info[.mediaURL] as? URL {
                onVideo(url)
                return
            }
            onCancel()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }
    }
}
