import SwiftUI

/// Tap and pair, one to one. Tap: "Hold near another iPhone" over the card
/// being shared while two phones swap codes nearby. QR: your code as a QR
/// code with the short code under it, Scan, and a field for their code.
/// Closing the sheet stops the radio and the code refresh.
struct CommonGroundTapSheet: View {
    enum Mode: String, CaseIterable, Identifiable {
        case tap = "Tap"
        case qr = "QR"
        var id: Self { self }
    }

    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    let cardWidth: CGFloat
    let onPaired: (CommonGroundPersonCard) -> Void
    let onProblem: (CommonGroundPairError) -> Void
    @StateObject private var controller = CommonGroundTapController()
    @State private var mode: Mode = .tap
    @State private var scanning = false
    @State private var typed = ""
    @State private var typedError: String?
    @State private var scanError: String?

    private var card: CommonGroundWalletCard? {
        model.walletCards.first { $0.id == model.walletSelectedID }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Picker("Mode", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 200)
                Spacer(minLength: 0)
                closeButton
            }
            .padding(.top, 20)
            ScrollView {
                VStack(spacing: 16) {
                    if mode == .tap { tap } else { qr }
                }
                .padding(.top, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            if mode == .qr {
                Button("Scan") { scanError = nil; scanning = true }
                    .buttonStyle(CommonGroundPrimaryButtonStyle())
                    .padding(.bottom, 8)
            }
        }
        .padding(.horizontal, 16)
        .onAppear {
            controller.start(model: model, onMatch: paired, onProblem: problem)
            controller.setRadio(mode == .tap)
        }
        .onDisappear { controller.stop() }
        .onChange(of: mode) { _, next in controller.setRadio(next == .tap) }
        .fullScreenCover(isPresented: $scanning) {
            CommonGroundScanView(error: scanError, busy: controller.busy) { code in
                Task { scanError = await controller.redeem(code) }
            }
        }
    }

    private func paired(_ card: CommonGroundPersonCard) {
        scanning = false
        onPaired(card)
    }

    private func problem(_ problem: CommonGroundPairError) {
        scanning = false
        onProblem(problem)
    }

    private var closeButton: some View {
        Button { dismiss() } label: {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
    }

    // MARK: Tap

    private var tap: some View {
        VStack(spacing: 18) {
            ZStack {
                CommonGroundTapPulse()
                if let card { smallCard(card) }
            }
            .frame(height: 290)
            VStack(spacing: 4) {
                switch controller.phase {
                case .searching:
                    Text("Hold near another iPhone").font(.title3.weight(.bold))
                    Text("Both phones unlocked").foregroundStyle(.secondary)
                case .pairing:
                    Text("Pairing…").font(.title3.weight(.bold))
                    Text("Keep the phones together").foregroundStyle(.secondary)
                case .failed(let message):
                    Text("Hold near another iPhone").font(.title3.weight(.bold))
                    Text(message).foregroundStyle(.red)
                }
            }
            .multilineTextAlignment(.center)
            .accessibilityElement(children: .combine)
        }
    }

    private func smallCard(_ card: CommonGroundWalletCard) -> some View {
        let zoom: CGFloat = 0.5
        return ProfileCardView(
            design: card.design,
            icon: card.icon,
            kindDesign: card.kindDesign,
            name: card.name,
            focus: card.focus,
            bottom: .topics(card.topics),
            width: cardWidth
        )
        .scaleEffect(zoom)
        .frame(width: cardWidth * zoom, height: cardWidth * ProfileCardView.aspect * zoom)
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        .accessibilityLabel("Sharing \(card.name)")
    }

    // MARK: QR

    @ViewBuilder private var qr: some View {
        let display = controller.code.flatMap { CommonGroundPairCodeText.display($0.code) }
        VStack(spacing: 2) {
            Group {
                if let display {
                    CommonGroundQRImage(text: CommonGroundPairCodeText.link(display))
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(width: 208, height: 208)
            .padding(14)
            .background(.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.08), radius: 12, y: 8)
            .padding(.top, 14)
            Text(display ?? " ")
                .font(.system(size: 24, weight: .semibold, design: .monospaced))
                .tracking(2.4)
                .textSelection(.enabled)
                .padding(.top, 16)
            Text("Valid for 2 minutes")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        CommonGroundTheirCodeField(text: $typed, error: typedError, busy: controller.busy) { code in
            Task { typedError = await controller.redeem(code) }
        }
        .padding(.top, 12)
        .onChange(of: typed) { _, _ in typedError = nil }
    }
}

/// Three rings easing outward from the card; still rings with reduced motion.
struct CommonGroundTapPulse: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var moving = false
    private let colors: [Color] = [.pink, .cyan, KordiTheme.brandAmber]

    var body: some View {
        ZStack {
            ForEach(colors.indices, id: \.self) { index in
                Circle()
                    .stroke(colors[index].opacity(0.7), lineWidth: 1.5)
                    .frame(width: 150, height: 150)
                    .scaleEffect(reduceMotion ? 1 + CGFloat(index) * 0.3 : (moving ? 1.9 : 0.8))
                    .opacity(reduceMotion ? 0.5 - Double(index) * 0.12 : (moving ? 0 : 0.9))
                    .animation(
                        reduceMotion ? nil : .easeOut(duration: 2.4).repeatForever(autoreverses: false).delay(Double(index) * 0.8),
                        value: moving
                    )
            }
        }
        .accessibilityHidden(true)
        .onAppear { if !reduceMotion { moving = true } }
    }
}
