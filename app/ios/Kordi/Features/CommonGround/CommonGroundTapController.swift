import Foundation

/// Runs one Tap sheet: keeps a fresh pairing code for the selected card,
/// runs the nearby radio while the Tap tab shows, and redeems codes that
/// were typed or scanned.
@MainActor
final class CommonGroundTapController: ObservableObject {
    enum Phase: Equatable { case searching, pairing, failed(String) }

    @Published private(set) var code: CommonGroundPairCode?
    @Published private(set) var phase: Phase = .searching
    @Published private(set) var busy = false

    private weak var model: CommonGroundModel?
    private var exchange: CommonGroundPairingExchange?
    private var transport: CommonGroundNearbyTransport?
    private var refresher: Task<Void, Never>?
    /// The card the current code shares; a different card asks for a new code.
    private var codeProfileID: String?
    private var finished = false
    private let pollInterval: Duration

    init(pollInterval: Duration = .seconds(1)) { self.pollInterval = pollInterval }
    private var onMatch: (CommonGroundPersonCard) -> Void = { _ in }
    private var onProblem: (CommonGroundPairError) -> Void = { _ in }

    func start(
        model: CommonGroundModel,
        onMatch: @escaping (CommonGroundPersonCard) -> Void,
        onProblem: @escaping (CommonGroundPairError) -> Void
    ) {
        guard exchange == nil else { return }
        finished = false
        self.model = model
        self.onMatch = onMatch
        self.onProblem = onProblem
        let exchange = CommonGroundPairingExchange(
            me: model.me.accountId,
            localRanging: CommonGroundNearbyTransport.supportsRanging
        ) { [weak self, weak model] code in
            guard let model else { return .failed("") }
            return await model.redeemPairCode(code, ownCode: self?.code?.code)
        }
        exchange.onPairing = { [weak self] in self?.phase = .pairing }
        exchange.onMatch = { [weak self] card in self?.finish(card) }
        exchange.onError = { [weak self] message in self?.phase = .failed(message) }
        self.exchange = exchange
        refresher = Task { [weak self] in await self?.keepCodeFresh() }
    }

    /// The radio runs only while the Tap tab shows.
    func setRadio(_ on: Bool) {
        if on, transport == nil, let exchange {
            let transport = CommonGroundNearbyTransport()
            transport.start(exchange)
            self.transport = transport
        } else if !on, let transport {
            transport.stop()
            self.transport = nil
            if let peer = exchange?.engaged { exchange?.disconnected(peer) }
            if case .pairing = phase { phase = .searching }
        }
    }

    func stop() {
        setRadio(false)
        refresher?.cancel()
        refresher = nil
        exchange = nil
    }

    /// A typed or scanned code; returns the line to show when it fails.
    func redeem(_ code: String) async -> String? {
        guard let model, !busy else { return nil }
        busy = true
        defer { busy = false }
        switch await model.redeemPairCode(code, ownCode: self.code?.code) {
        case .paired(let card):
            finish(card)
            return nil
        case .codeGone:
            return CommonGroundPairCopy.expired
        case .failed(let message):
            return message
        }
    }

    private func finish(_ card: CommonGroundPersonCard) {
        guard !finished else { return }
        finished = true
        stop()
        onMatch(card)
    }

    /// Replaces the code shortly before it expires, or when another card is
    /// picked; waits a little after a failure instead of retrying every second.
    private func keepCodeFresh() async {
        while !Task.isCancelled {
            // Check before rotating a nearly expired code so a recent scan is not lost.
            if let code, let model, codeProfileID == model.pairingProfileID,
               let card = await model.completedPairCode(code.code) {
                guard !Task.isCancelled else { return }
                finish(card)
                return
            }
            guard !Task.isCancelled else { return }
            if let exchange, let model, exchange.needsRefresh() || codeProfileID != model.pairingProfileID {
                let asked = model.pairingProfileID
                switch await model.newPairCode() {
                case .success(let next):
                    codeProfileID = asked
                    code = next
                    exchange.setCode(next.code, expiry: next.expiry ?? Date().addingTimeInterval(120))
                    if case .failed = phase { phase = .searching }
                case .failure(.other(let message)):
                    if !message.isEmpty { phase = .failed(message) }
                    try? await Task.sleep(for: .seconds(5))
                case .failure(let problem):
                    stop()
                    onProblem(problem)
                    return
                }
            }
            try? await Task.sleep(for: pollInterval)
        }
    }
}
