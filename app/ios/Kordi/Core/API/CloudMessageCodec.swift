import Foundation

enum CloudMessageCodec {
    static let directPrefix = "kordi-cloud-message:"
    static let agentResponsePrefix = "kordi-cloud-agent-response:"
    static let agentCancelPrefix = "kordi-cloud-agent-cancel:"

    struct DirectEnvelope: Codable, Equatable {
        let schemaVersion: Int
        let kind: String
        let text: String
        let targetCloudAgentId: String?
        let targetCloudAgentName: String?
        let targetCloudAgentOwnerAccountId: String?
        let targetCloudAgentOwnerName: String?
        let agentRuntimeRoute: CloudModelRouting?
        let messageAction: MessageActionMetadata?
    }

    private struct AgentResponseEnvelope: Codable {
        let text: String
        let requestId: String?
        let deliveryState: String?
    }

    struct AgentCancelEnvelope: Codable, Equatable {
        let kind: String
        let requestId: String
    }

    private final class ParsedMessageEnvelopeBox: NSObject {
        let direct: DirectEnvelope?
        let response: AgentResponseEnvelope?
        let cancel: AgentCancelEnvelope?

        init(
            direct: DirectEnvelope?,
            response: AgentResponseEnvelope?,
            cancel: AgentCancelEnvelope?
        ) {
            self.direct = direct
            self.response = response
            self.cancel = cancel
        }
    }

    private static let parsedEnvelopeCache: NSCache<NSString, ParsedMessageEnvelopeBox> = {
        let cache = NSCache<NSString, ParsedMessageEnvelopeBox>()
        cache.countLimit = 24_000
        cache.totalCostLimit = 24 * 1_024 * 1_024
        return cache
    }()

    static func encodeDirect(
        text: String,
        agentId: String?,
        agentName: String?,
        ownerAccountId: String?,
        ownerName: String?,
        agentRuntimeRoute: CloudModelRouting? = nil,
        messageAction: MessageActionMetadata? = nil
    ) throws -> String {
        let envelope = DirectEnvelope(
            schemaVersion: 1,
            kind: "message",
            text: text,
            targetCloudAgentId: agentId,
            targetCloudAgentName: agentName,
            targetCloudAgentOwnerAccountId: ownerAccountId,
            targetCloudAgentOwnerName: ownerName,
            agentRuntimeRoute: agentRuntimeRoute,
            messageAction: messageAction
        )
        return directPrefix + base64URL(try JSONEncoder().encode(envelope))
    }

    static func displayText(_ body: String) -> String {
        let parsed = parsedEnvelopes(body)
        if let envelope = parsed.direct {
            return envelope.text
        }
        if let envelope = parsed.response {
            return envelope.text
        }
        return body
    }

    static func isAgentResponse(_ body: String) -> Bool {
        parsedEnvelopes(body).response != nil
    }

    static func isTerminalAgentResponse(_ body: String) -> Bool {
        guard let response = parsedEnvelopes(body).response else { return false }
        return response.deliveryState != "processing"
    }

    static func agentResponseDeliveryState(_ body: String) -> CloudAgentLifecycleState? {
        guard let response = parsedEnvelopes(body).response else { return nil }
        switch response.deliveryState?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "processing":
            return .processing
        case "failed":
            return .failed
        case "cancelled":
            return .cancelled
        default:
            // Legacy responses omitted deliveryState and were terminal.
            return .complete
        }
    }

    static func agentResponseRequestId(_ body: String) -> String? {
        parsedEnvelopes(body).response?.requestId
    }

    static func agentCancelEnvelope(_ body: String) -> AgentCancelEnvelope? {
        guard let envelope = parsedEnvelopes(body).cancel,
              envelope.kind == "agent-cancel",
              !envelope.requestId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return envelope
    }

    static func isAgentControl(_ body: String) -> Bool {
        agentCancelEnvelope(body) != nil
    }

    static func directEnvelope(_ body: String) -> DirectEnvelope? {
        parsedEnvelopes(body).direct
    }

    private static func parsedEnvelopes(_ body: String) -> ParsedMessageEnvelopeBox {
        let key = body as NSString
        if let cached = parsedEnvelopeCache.object(forKey: key) { return cached }
        let parsed = ParsedMessageEnvelopeBox(
            direct: decodeEnvelope(body, prefix: directPrefix),
            response: decodeEnvelope(body, prefix: agentResponsePrefix),
            cancel: decodeEnvelope(body, prefix: agentCancelPrefix)
        )
        parsedEnvelopeCache.setObject(
            parsed,
            forKey: key,
            cost: min(body.utf8.count, 128 * 1_024)
        )
        return parsed
    }

    private static func decodeEnvelope<T: Decodable>(_ body: String, prefix: String) -> T? {
        guard body.hasPrefix(prefix) else { return nil }
        let encoded = String(body.dropFirst(prefix.count))
        guard let data = dataFromBase64URL(encoded) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func dataFromBase64URL(_ value: String) -> Data? {
        var normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.count % 4
        if remainder > 0 {
            normalized += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: normalized)
    }
}

enum CloudAgentLifecycleState: String, Equatable {
    case processing
    case complete
    case failed
    case cancelled

    var isTerminal: Bool { self != .processing }

    var activity: AgentActivity {
        switch self {
        case .processing:
            return .replying
        case .failed:
            return .failed
        case .complete, .cancelled:
            return .ready
        }
    }
}

/// Reduces append-only Cloud agent response rows into one monotonic lifecycle
/// slot per request and agent. A late processing heartbeat must never replace a
/// completed, failed, or cancelled response that another device already saw.
enum CloudAgentLifecycleProjector {
    private struct ResponseKey: Hashable {
        let requestId: String
        let fromAccountId: String
    }

    static func visibleRows(_ messages: [CloudMessageDTO]) -> [CloudMessageDTO] {
        let sorted = messages.sorted(by: messagePrecedes)
        var preferredByKey: [ResponseKey: CloudMessageDTO] = [:]
        for message in sorted {
            guard let key = responseKey(for: message) else { continue }
            guard let existing = preferredByKey[key] else {
                preferredByKey[key] = message
                continue
            }
            preferredByKey[key] = preferredResponse(existing, message)
        }

        var emittedResponseKeys = Set<ResponseKey>()
        return sorted.filter { message in
            guard let key = responseKey(for: message) else { return true }
            guard preferredByKey[key]?.messageId == message.messageId else { return false }
            return emittedResponseKeys.insert(key).inserted
        }
    }

    static func activity(in messages: [CloudMessageDTO]) -> AgentActivity {
        let visible = visibleRows(messages)
        let latestRequest = visible
            .filter { CloudMessageCodec.directEnvelope($0.body)?.targetCloudAgentId?.nonEmpty != nil }
            .max(by: messagePrecedes)
        if let latestRequest {
            return state(forRequestId: latestRequest.messageId, in: visible)?.activity ?? .replying
        }
        let latestResponse = visible
            .filter { CloudMessageCodec.isAgentResponse($0.body) }
            .max(by: messagePrecedes)
        return latestResponse
            .flatMap { CloudMessageCodec.agentResponseDeliveryState($0.body) }?
            .activity ?? .ready
    }

    static func state(
        forRequestId requestId: String,
        in messages: [CloudMessageDTO]
    ) -> CloudAgentLifecycleState? {
        visibleRows(messages)
            .filter { CloudMessageCodec.agentResponseRequestId($0.body) == requestId }
            .max(by: messagePrecedes)
            .flatMap { CloudMessageCodec.agentResponseDeliveryState($0.body) }
    }

    private static func responseKey(for message: CloudMessageDTO) -> ResponseKey? {
        guard let requestId = CloudMessageCodec.agentResponseRequestId(message.body)?.nonEmpty else {
            return nil
        }
        return ResponseKey(requestId: requestId, fromAccountId: message.fromAccountId)
    }

    private static func preferredResponse(
        _ existing: CloudMessageDTO,
        _ candidate: CloudMessageDTO
    ) -> CloudMessageDTO {
        let existingState = CloudMessageCodec.agentResponseDeliveryState(existing.body)
        let candidateState = CloudMessageCodec.agentResponseDeliveryState(candidate.body)
        if existingState?.isTerminal == true, candidateState == .processing {
            return existing
        }
        if existingState == .processing, candidateState?.isTerminal == true {
            return candidate
        }
        return messagePrecedes(existing, candidate) ? candidate : existing
    }

    private static func messagePrecedes(_ lhs: CloudMessageDTO, _ rhs: CloudMessageDTO) -> Bool {
        let lhsDate = parseCloudDate(lhs.createdAt)
        let rhsDate = parseCloudDate(rhs.createdAt)
        return lhsDate < rhsDate || (lhsDate == rhsDate && lhs.messageId < rhs.messageId)
    }
}
