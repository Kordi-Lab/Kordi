import Foundation
import MultipeerConnectivity
import NearbyInteraction

/// The radio under Tap: MultipeerConnectivity finds a nearby phone running
/// Tap and opens an encrypted session; NearbyInteraction, where both phones
/// support precise ranging, measures the distance. Discovery info holds a
/// random session id only, never a code. Delegate calls hop to the main actor
/// and feed a `CommonGroundPairingExchange`.
final class CommonGroundNearbyTransport: NSObject {
    static let serviceType = "kordi-cg"

    /// Whether this phone measures distance; false on simulators and older phones.
    static var supportsRanging: Bool { NISession.deviceCapabilities.supportsPreciseDistanceMeasurement }

    private let sessionID = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8)).lowercased()
    private let peerID: MCPeerID
    private let session: MCSession
    private let advertiser: MCNearbyServiceAdvertiser
    private let browser: MCNearbyServiceBrowser
    private var niSession: NISession?
    private var peers: [String: MCPeerID] = [:]
    private var rangingPeer: String?
    private weak var exchange: CommonGroundPairingExchange?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    override init() {
        peerID = MCPeerID(displayName: sessionID)
        session = MCSession(peer: peerID, securityIdentity: nil, encryptionPreference: .required)
        advertiser = MCNearbyServiceAdvertiser(peer: peerID, discoveryInfo: ["s": sessionID], serviceType: Self.serviceType)
        browser = MCNearbyServiceBrowser(peer: peerID, serviceType: Self.serviceType)
        super.init()
        session.delegate = self
        advertiser.delegate = self
        browser.delegate = self
    }

    @MainActor
    func start(_ exchange: CommonGroundPairingExchange) {
        self.exchange = exchange
        exchange.send = { [weak self] message, peer in self?.send(message, to: peer) }
        exchange.token = { [weak self] in self?.localToken() }
        exchange.onPeerToken = { [weak self] data, peer in self?.range(with: data, peer: peer) }
        if Self.supportsRanging {
            let ni = NISession()
            ni.delegate = self
            niSession = ni
        }
        advertiser.startAdvertisingPeer()
        browser.startBrowsingForPeers()
    }

    func stop() {
        exchange = nil
        advertiser.stopAdvertisingPeer()
        browser.stopBrowsingForPeers()
        session.disconnect()
        niSession?.invalidate()
        niSession = nil
        peers = [:]
    }

    private func send(_ message: CommonGroundPairMessage, to peer: String) {
        guard let target = peers[peer], let data = try? encoder.encode(message) else { return }
        try? session.send(data, toPeers: [target], with: .reliable)
    }

    private func localToken() -> Data? {
        guard let token = niSession?.discoveryToken else { return nil }
        return try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true)
    }

    private func range(with data: Data, peer: String) {
        guard let niSession,
              let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self, from: data) else { return }
        rangingPeer = peer
        niSession.run(NINearbyPeerConfiguration(peerToken: token))
    }

    private func onMain(_ work: @escaping @MainActor (CommonGroundPairingExchange) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let exchange = self?.exchange else { return }
            MainActor.assumeIsolated { work(exchange) }
        }
    }
}

extension CommonGroundNearbyTransport: MCSessionDelegate {
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        let name = peerID.displayName
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch state {
            case .connected: peers[name] = peerID
            case .notConnected: peers[name] = nil
            default: return
            }
            guard let exchange else { return }
            MainActor.assumeIsolated {
                if state == .connected { exchange.connected(name) } else { exchange.disconnected(name) }
            }
        }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        guard let message = try? decoder.decode(CommonGroundPairMessage.self, from: data) else { return }
        let name = peerID.displayName
        onMain { $0.receive(message, from: name) }
    }

    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

extension CommonGroundNearbyTransport: MCNearbyServiceAdvertiserDelegate, MCNearbyServiceBrowserDelegate {
    /// The phone with the smaller session id invites; the other accepts,
    /// so two phones never invite each other at once.
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        guard peerID.displayName != sessionID, sessionID < peerID.displayName, session.connectedPeers.isEmpty else { return }
        browser.invitePeer(peerID, to: session, withContext: nil, timeout: 20)
    }

    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {}

    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID,
                    withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        let accept = session.connectedPeers.isEmpty
        invitationHandler(accept, accept ? session : nil)
    }
}

extension CommonGroundNearbyTransport: NISessionDelegate {
    func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard let peer = rangingPeer else { return }
        let distance = nearbyObjects.first?.distance
        onMain { $0.distance(distance, peer: peer) }
    }

    func session(_ session: NISession, didRemove nearbyObjects: [NINearbyObject], reason: NINearbyObject.RemovalReason) {
        guard let peer = rangingPeer else { return }
        onMain { $0.distance(nil, peer: peer) }
    }

    /// Ranging stopped (permission off, or the session ended): pair on
    /// discovery instead, and tell the other phone.
    func session(_ session: NISession, didInvalidateWith error: Error) {
        onMain { $0.setLocalRanging(false) }
    }
}
