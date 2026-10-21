import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

struct ContactProfileTileLabel: View {
    let title: String
    let systemImage: String
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .medium))
                .frame(height: 22)
            Text(title)
                .font(.caption.weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(isEnabled ? KordiTheme.signalBlue : Color(uiColor: .tertiaryLabel))
        .frame(maxWidth: .infinity)
        .frame(height: ContactProfileMetrics.tileHeight)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct ContactProfileTileButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ContactProfileTileLabel(title: title, systemImage: systemImage)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}

/// Share: the Kordi ID as a QR code, with a copy button.
struct ContactProfileShareSheet: View {
    @Environment(\.dismiss) private var dismiss
    let name: String
    let kordiId: String
    @State private var copied = false

    var body: some View {
        VStack(spacing: 16) {
            Text(name)
                .font(.headline)
                .lineLimit(1)
                .padding(.top, 28)
            if let image = Self.qrImage(for: kordiId) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 200, height: 200)
                    .padding(12)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .accessibilityLabel("QR code for Kordi ID \(kordiId)")
            }
            Text(ContactProfilePresentation.formattedKordiId(kordiId))
                .font(.body.monospacedDigit())
                .foregroundStyle(.secondary)
            Button {
                UIPasteboard.general.string = kordiId
                copied = true
            } label: {
                Label(copied ? "Copied" : "Copy Kordi ID", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 12))
            .padding(.horizontal, 20)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: .systemBackground))
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    static func qrImage(for text: String) -> UIImage? {
        guard !text.isEmpty else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

/// The pushed page keeps the standard bar transparent, so the tinted header
/// runs under the status bar and the back button floats on it, as on the
/// session details page.
struct ContactProfilePageBar: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .toolbarBackground(.hidden, for: .navigationBar)
                .scrollEdgeEffectHidden(true, for: .top)
        } else {
            content.toolbarBackground(.hidden, for: .navigationBar)
        }
    }
}
