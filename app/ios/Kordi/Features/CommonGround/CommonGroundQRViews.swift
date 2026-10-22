import AVFoundation
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// A QR code image of `text`, drawn with square modules.
struct CommonGroundQRImage: View {
    let text: String

    var body: some View {
        if let image = Self.image(for: text) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .accessibilityLabel("Pairing QR code")
        } else {
            Color.white
        }
    }

    static func image(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

/// The other person's short code, typed: one field and Pair.
struct CommonGroundTheirCodeField: View {
    @Binding var text: String
    var error: String?
    var busy = false
    let onPair: (String) -> Void

    private var parsed: String? { CommonGroundPairCodeText.parse(text) }

    var body: some View {
        CommonGroundSection(title: "Their code") {
            HStack(spacing: 10) {
                TextField("Enter their code", text: $text)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { if let parsed { onPair(parsed) } }
                Button("Pair") { if let parsed { onPair(parsed) } }
                    .font(.subheadline.weight(.semibold))
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .disabled(parsed == nil || busy)
            }
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .frame(minHeight: 52)
        }
        if let error {
            Text(error)
                .font(.footnote)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        }
    }
}

/// Full-screen camera that reads a Kordi pairing code. With the camera off
/// it says so, links to Settings and keeps the short-code field.
struct CommonGroundScanView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var access = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var typed = ""
    var error: String?
    var busy = false
    let onCode: (String) -> Void

    private var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }

    var body: some View {
        Group {
            if access == .authorized, hasCamera {
                camera
            } else {
                off
            }
        }
        .task {
            guard access == .notDetermined, hasCamera else { return }
            _ = await AVCaptureDevice.requestAccess(for: .video)
            access = AVCaptureDevice.authorizationStatus(for: .video)
        }
    }

    private var camera: some View {
        ZStack {
            CommonGroundQRScanner { value in
                if let code = CommonGroundPairCodeText.parse(value) { onCode(code) }
            }
            .ignoresSafeArea()
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(.white, lineWidth: 4)
                .frame(width: 236, height: 236)
                .accessibilityHidden(true)
            VStack {
                HStack {
                    closeButton
                    Spacer()
                }
                Spacer()
                Text(error ?? "Point at a Kordi code")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 24)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 48)
            }
            .padding(16)
        }
        .background(Color.black)
    }

    private var off: some View {
        VStack(spacing: 16) {
            HStack { closeButton; Spacer() }
            VStack(spacing: 8) {
                Image(systemName: "video.slash")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)
                    .frame(width: 64, height: 64)
                    .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                Text(hasCamera ? CommonGroundPairCopy.cameraOff : "No camera here")
                    .font(.title3.weight(.bold))
                if hasCamera, access != .notDetermined {
                    Button("Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                }
            }
            .padding(.top, 24)
            CommonGroundTheirCodeField(text: $typed, error: error, busy: busy, onPair: onCode)
                .padding(.top, 18)
            Spacer()
        }
        .padding(16)
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
    }

    private var closeButton: some View {
        Button { dismiss() } label: {
            Image(systemName: "xmark")
                .font(.system(size: 14, weight: .bold))
                .frame(width: 40, height: 40)
                .sessionGlass(in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
    }
}

/// The camera preview reading QR codes; reports each distinct value once.
struct CommonGroundQRScanner: UIViewControllerRepresentable {
    let onValue: (String) -> Void

    func makeUIViewController(context: Context) -> Controller {
        let controller = Controller()
        controller.onValue = onValue
        return controller
    }

    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.onValue = onValue
    }

    final class Controller: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onValue: (String) -> Void = { _ in }
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private var seen: Set<String> = []

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            for case let object as AVMetadataMachineReadableCodeObject in objects {
                guard let value = object.stringValue, seen.insert(value).inserted else { continue }
                onValue(value)
            }
        }
    }
}
