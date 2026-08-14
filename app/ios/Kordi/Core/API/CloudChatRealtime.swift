import Foundation

enum CloudChatRealtimeFrame: Equatable {
    case hello(heartbeatIntervalMilliseconds: Int)
    case event(streamSequence: Int64)
    case heartbeatAcknowledged
    case resyncRequired(reason: String)
    case ignored
}

enum CloudChatRealtimeError: LocalizedError, Equatable {
    case invalidURL
    case invalidFrame
    case unexpectedHandshake
    case heartbeatNotAcknowledged
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            "Kordi Cloud returned an invalid realtime address."
        case .invalidFrame:
            "Kordi Cloud returned an invalid realtime frame."
        case .unexpectedHandshake:
            "Kordi Cloud did not complete the realtime handshake."
        case .heartbeatNotAcknowledged:
            "Kordi Cloud did not acknowledge realtime delivery."
        case .server(let code):
            "Kordi Cloud closed realtime delivery (\(code))."
        }
    }
}

enum CloudChatRealtimeProtocol {
    static let version = 2

    static func decodeFrame(_ data: Data) throws -> CloudChatRealtimeFrame {
        let frame = try JSONDecoder().decode(ServerFrame.self, from: data)
        switch frame.type {
        case "hello":
            guard frame.protocolVersion == version,
                  let interval = frame.heartbeatIntervalMilliseconds,
                  interval > 0 else {
                throw CloudChatRealtimeError.invalidFrame
            }
            return .hello(heartbeatIntervalMilliseconds: max(5_000, interval))
        case "event":
            guard let sequence = frame.streamSequence, sequence >= 0 else {
                throw CloudChatRealtimeError.invalidFrame
            }
            return .event(streamSequence: sequence)
        case "heartbeat_ack":
            return .heartbeatAcknowledged
        case "resync_required":
            return .resyncRequired(reason: frame.reason ?? "UNKNOWN")
        case "error":
            throw CloudChatRealtimeError.server(frame.code ?? "UNKNOWN")
        default:
            return .ignored
        }
    }

    private struct ServerFrame: Decodable {
        let type: String
        let protocolVersion: Int?
        let heartbeatIntervalMilliseconds: Int?
        let streamSequence: Int64?
        let reason: String?
        let code: String?

        enum CodingKeys: String, CodingKey {
            case type, reason, code
            case protocolVersion = "protocol_version"
            case heartbeatIntervalMilliseconds = "heartbeat_interval_ms"
            case streamSequence = "stream_seq"
        }
    }
}

enum CloudRealtimeRetryPolicy {
    static let maximumDelaySeconds = 15.0

    static func delaySeconds(attempt: Int, unitJitter: Double) -> Double {
        let safeAttempt = max(0, min(attempt, 30))
        let base = min(pow(2.0, Double(safeAttempt)), maximumDelaySeconds)
        let clampedJitter = min(max(unitJitter, 0), 1)
        return min(base * (0.8 + (0.4 * clampedJitter)), maximumDelaySeconds)
    }
}

actor CloudChatRealtimeConnection {
    private let task: URLSessionWebSocketTask
    private let deviceId: String
    private let cursor: String
    private let encoder = JSONEncoder()
    private var heartbeatAwaitingAcknowledgement = false

    init(task: URLSessionWebSocketTask, deviceId: String, cursor: String) {
        self.task = task
        self.deviceId = deviceId
        self.cursor = cursor
    }

    func start() async throws -> Int {
        task.resume()
        do {
            try await send(
                ClientFrame.connect(
                    protocolVersion: CloudChatRealtimeProtocol.version,
                    deviceId: deviceId,
                    cursor: cursor
                )
            )
            let frame = try await receive()
            guard case .hello(let interval) = frame else {
                throw CloudChatRealtimeError.unexpectedHandshake
            }
            return interval
        } catch {
            cancel()
            throw error
        }
    }

    func receive() async throws -> CloudChatRealtimeFrame {
        while true {
            let message = try await task.receive()
            let data: Data
            switch message {
            case .string(let text):
                data = Data(text.utf8)
            case .data(let value):
                data = value
            @unknown default:
                throw CloudChatRealtimeError.invalidFrame
            }
            let frame = try CloudChatRealtimeProtocol.decodeFrame(data)
            if frame == .heartbeatAcknowledged {
                heartbeatAwaitingAcknowledgement = false
            }
            if frame != .ignored { return frame }
        }
    }

    func sendHeartbeat(lastAppliedSequence: Int64) async throws {
        guard !heartbeatAwaitingAcknowledgement else {
            throw CloudChatRealtimeError.heartbeatNotAcknowledged
        }
        heartbeatAwaitingAcknowledgement = true
        do {
            try await send(.heartbeat(lastAppliedSequence: lastAppliedSequence))
        } catch {
            heartbeatAwaitingAcknowledgement = false
            throw error
        }
    }

    nonisolated func cancel() {
        task.cancel(with: .goingAway, reason: nil)
    }

    private func send(_ frame: ClientFrame) async throws {
        let data = try encoder.encode(frame)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CloudChatRealtimeError.invalidFrame
        }
        try await task.send(.string(text))
    }

    private enum ClientFrame: Encodable {
        case connect(protocolVersion: Int, deviceId: String, cursor: String)
        case heartbeat(lastAppliedSequence: Int64)

        enum CodingKeys: String, CodingKey {
            case type
            case protocolVersion = "protocol_version"
            case deviceId = "device_id"
            case cursor
            case lastAppliedSequence = "last_applied_seq"
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .connect(let protocolVersion, let deviceId, let cursor):
                try container.encode("connect", forKey: .type)
                try container.encode(protocolVersion, forKey: .protocolVersion)
                try container.encode(deviceId, forKey: .deviceId)
                try container.encode(cursor, forKey: .cursor)
            case .heartbeat(let lastAppliedSequence):
                try container.encode("heartbeat", forKey: .type)
                try container.encode(lastAppliedSequence, forKey: .lastAppliedSequence)
            }
        }
    }
}

struct CloudChatRealtimeSession {
    let connection: CloudChatRealtimeConnection
    let heartbeatIntervalMilliseconds: Int
}
