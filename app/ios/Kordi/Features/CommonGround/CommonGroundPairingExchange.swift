import Foundation

/// The Tap exchange between two phones, independent of the radio. The
/// transport reports peers and messages; the exchange decides when to send
/// this phone's code, redeems the other phone's code once, and opens the
/// match when both sides have redeemed.
///
/// 1. Connected: each phone sends `hello` (can it range, which account).
/// 2. Both can range: they swap NearbyInteraction tokens and wait until the
///    phones are closer than `CommonGroundProximity.pairDistance`. Otherwise
///    discovery alone is enough.
/// 3. Close: each phone sends its code, redeems the other's, then sends
///    `paired`. A new code (before the old one expires) is sent again.
/// 4. Redeemed and `paired` received, or `peerWait` after redeeming: done.
@MainActor
final class CommonGroundPairingExchange {
    typealias Redeem = @MainActor (String) async -> CommonGroundRedeemOutcome

    /// A code is replaced this long before it expires.
    nonisolated static let refreshMargin: TimeInterval = 20

    private struct Peer {
        var ranging: Bool?
        var near = false
        var sentCode: String?
        var theirCode: String?
        var paired = false
    }

    let me: String
    private(set) var localRanging: Bool
    private let redeem: Redeem
    private let peerWait: Duration

    /// Sends a message to one peer.
    var send: (CommonGroundPairMessage, String) -> Void = { _, _ in }
    /// This phone's NearbyInteraction token, archived; nil when it cannot range.
    var token: () -> Data? = { nil }
    /// The other phone's NearbyInteraction token arrived.
    var onPeerToken: (Data, String) -> Void = { _, _ in }
    /// Both phones are close and codes are going out.
    var onPairing: () -> Void = {}
    var onMatch: (CommonGroundPersonCard) -> Void = { _ in }
    var onError: (String) -> Void = { _ in }

    private(set) var ownCode: String?
    private(set) var expiry: Date?
    /// The one peer this phone pairs with; others are ignored.
    private(set) var engaged: String?
    private var peers: [String: Peer] = [:]
    /// Codes already redeemed or being redeemed, normalized.
    private var tried: Set<String> = []
    private var redeeming = false
    private(set) var redeemed: CommonGroundPersonCard?
    private(set) var finished = false
    private var refused = false

    init(me: String, localRanging: Bool, peerWait: Duration = .seconds(4), redeem: @escaping Redeem) {
        self.me = me
        self.localRanging = localRanging
        self.peerWait = peerWait
        self.redeem = redeem
    }

    // MARK: Code

    func setCode(_ code: String, expiry: Date?) {
        ownCode = code
        self.expiry = expiry
        if let engaged { sendCodeIfReady(engaged) }
    }

    func needsRefresh(now: Date = Date()) -> Bool {
        guard !finished else { return false }
        guard let expiry else { return ownCode == nil }
        return expiry.timeIntervalSince(now) < Self.refreshMargin
    }

    // MARK: Transport events

    func connected(_ peer: String) {
        guard !finished, engaged == nil || engaged == peer else { return }
        engaged = peer
        if peers[peer] == nil { peers[peer] = Peer() }
        send(.hello(ranging: localRanging, account: me), peer)
    }

    func disconnected(_ peer: String) {
        guard engaged == peer else { return }
        engaged = nil
        peers[peer] = nil
    }

    /// Whether this phone can still range; NearbyInteraction may stop.
    func setLocalRanging(_ ranging: Bool) {
        guard ranging != localRanging else { return }
        localRanging = ranging
        if let engaged {
            send(.hello(ranging: ranging, account: me), engaged)
            advance(engaged)
        }
    }

    /// Distance to the engaged peer in metres, nil when unknown.
    func distance(_ meters: Float?, peer: String) {
        guard peer == engaged else { return }
        peers[peer]?.near = CommonGroundProximity.isNear(meters)
        advance(peer)
    }

    func mode(for peer: String) -> CommonGroundProximity {
        CommonGroundProximity.mode(localSupportsRanging: localRanging, peerSupportsRanging: peers[peer]?.ranging ?? false)
    }

    func receive(_ message: CommonGroundPairMessage, from peer: String) {
        guard !finished, !refused else { return }
        if engaged == nil { connected(peer) }
        guard peer == engaged else { return }
        switch message.kind {
        case .hello:
            if message.account == me {
                refused = true
                onError(CommonGroundPairCopy.yourself)
                return
            }
            let first = peers[peer]?.ranging == nil
            peers[peer]?.ranging = message.ranging ?? false
            if first, mode(for: peer) == .distance, let data = token() { send(.token(data), peer) }
            advance(peer)
        case .token:
            if let data = message.token, mode(for: peer) == .distance { onPeerToken(data, peer) }
        case .code:
            guard let code = message.code.flatMap(CommonGroundPairCodeText.display) else { return }
            if CommonGroundPairCodeText.same(code, ownCode) { return }
            peers[peer]?.theirCode = code
            advance(peer)
        case .paired:
            peers[peer]?.paired = true
            finishIfReady(peer)
        }
    }

    // MARK: Steps

    private func isClose(_ peer: String) -> Bool {
        guard let state = peers[peer], state.ranging != nil else { return false }
        return mode(for: peer) == .discovery || state.near
    }

    private func advance(_ peer: String) {
        guard isClose(peer) else { return }
        sendCodeIfReady(peer)
        redeemIfReady(peer)
    }

    private func sendCodeIfReady(_ peer: String) {
        guard !finished, isClose(peer), let ownCode, peers[peer]?.sentCode != ownCode else { return }
        if peers[peer]?.sentCode == nil { onPairing() }
        peers[peer]?.sentCode = ownCode
        send(.code(ownCode), peer)
    }

    private func redeemIfReady(_ peer: String) {
        guard !finished, !redeeming, redeemed == nil, isClose(peer),
              let code = peers[peer]?.theirCode,
              let key = CommonGroundPairCodeText.normalized(code), !tried.contains(key) else { return }
        tried.insert(key)
        redeeming = true
        Task { @MainActor in
            let outcome = await redeem(code)
            redeeming = false
            guard !finished else { return }
            switch outcome {
            case .paired(let card):
                redeemed = card
                if engaged == peer { send(.paired, peer) }
                finishIfReady(peer)
                if !finished { waitForPeer() }
            case .codeGone:
                // The other phone replaced its code; its next one is sent.
                if let engaged { redeemIfReady(engaged) }
            case .failed(let message):
                onError(message)
            }
        }
    }

    private func finishIfReady(_ peer: String) {
        guard let redeemed, peers[peer]?.paired == true || engaged != peer else { return }
        finish(redeemed)
    }

    /// The pairing stands after one redemption, so the match opens even if
    /// the other phone's `paired` never arrives.
    private func waitForPeer() {
        let wait = peerWait
        Task { @MainActor in
            try? await Task.sleep(for: wait)
            if let redeemed { finish(redeemed) }
        }
    }

    private func finish(_ card: CommonGroundPersonCard) {
        guard !finished else { return }
        finished = true
        onMatch(card)
    }
}
