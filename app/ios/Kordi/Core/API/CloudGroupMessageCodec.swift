import Foundation

struct CloudGroupStructuredContent: Codable, Hashable {
    let tools: [AgentExecutionTool]?
}

struct CloudGroupParticipant: Codable, Hashable, Identifiable {
    let accountId: String
    let displayName: String
    let avatarUrl: String?
    let role: String?

    var id: String { accountId }
}

struct CloudGroupMessagePayload: Codable, Hashable {
    let id: String
    let senderAccountId: String
    let text: String
    let createdAtMs: Double
    let senderKind: String?
    let senderDisplayName: String?
    let deliveryState: String?
    let replyToMessageId: String?
    let requestId: String?
    let attachments: [CloudMessageAttachment]?
    let mentions: [MessageMention]?
    let messageAction: MessageActionMetadata?
    let targetCloudAgentId: String?
    let targetCloudAgentName: String?
    let targetCloudAgentOwnerAccountId: String?
    let targetCloudAgentOwnerName: String?
    let agentRuntimeRoute: CloudModelRouting?
    let messageKind: String?
    let voiceMessage: VoiceMessage?
    let structuredContent: CloudGroupStructuredContent?

    init(
        id: String,
        senderAccountId: String,
        text: String,
        createdAtMs: Double,
        senderKind: String?,
        senderDisplayName: String?,
        deliveryState: String?,
        replyToMessageId: String?,
        requestId: String?,
        attachments: [CloudMessageAttachment]? = nil,
        mentions: [MessageMention]? = nil,
        messageAction: MessageActionMetadata? = nil,
        targetCloudAgentId: String? = nil,
        targetCloudAgentName: String? = nil,
        targetCloudAgentOwnerAccountId: String? = nil,
        targetCloudAgentOwnerName: String? = nil,
        agentRuntimeRoute: CloudModelRouting? = nil,
        messageKind: String? = nil,
        voiceMessage: VoiceMessage? = nil,
        structuredContent: CloudGroupStructuredContent? = nil
    ) {
        self.id = id
        self.senderAccountId = senderAccountId
        self.text = text
        // JSON numbers produced from Date can contain sub-millisecond
        // fractions. Replicated timestamps cross native SQLite command
        // boundaries that require Int64 milliseconds, so normalize once when
        // constructing an outbound group message.
        self.createdAtMs = createdAtMs.rounded(.towardZero)
        self.senderKind = senderKind
        self.senderDisplayName = senderDisplayName
        self.deliveryState = deliveryState
        self.replyToMessageId = replyToMessageId
        self.requestId = requestId
        self.attachments = attachments
        self.mentions = mentions
        self.messageAction = messageAction
        self.targetCloudAgentId = targetCloudAgentId
        self.targetCloudAgentName = targetCloudAgentName
        self.targetCloudAgentOwnerAccountId = targetCloudAgentOwnerAccountId
        self.targetCloudAgentOwnerName = targetCloudAgentOwnerName
        self.agentRuntimeRoute = agentRuntimeRoute
        self.messageKind = messageKind
        self.voiceMessage = voiceMessage
        self.structuredContent = structuredContent
    }
}

struct CloudGroupForkPayload: Codable, Hashable {
    let forkSessionId: String
    let parentSessionId: String
    let parentMessageId: String?
    let createdAtMs: Double?
}

struct CloudGroupMemberJoin: Codable, Hashable {
    let eventId: String
    let accountId: String
    let displayName: String
    let createdAtMs: Double
}

struct CloudGroupControlEnvelope: Codable, Hashable {
    let kind: String
    let groupId: String
    let groupSpaceId: String?
    let groupTitle: String?
    let createdByAccountId: String
    let actor: CloudGroupParticipant
    let participants: [CloudGroupParticipant]
    let memberJoins: [CloudGroupMemberJoin]?
    let fork: CloudGroupForkPayload?
    let message: CloudGroupMessagePayload?

    init(
        kind: String,
        groupId: String,
        groupSpaceId: String?,
        groupTitle: String?,
        createdByAccountId: String,
        actor: CloudGroupParticipant,
        participants: [CloudGroupParticipant],
        memberJoins: [CloudGroupMemberJoin]? = nil,
        fork: CloudGroupForkPayload? = nil,
        message: CloudGroupMessagePayload?
    ) {
        self.kind = kind
        self.groupId = groupId
        self.groupSpaceId = groupSpaceId
        self.groupTitle = groupTitle
        self.createdByAccountId = createdByAccountId
        self.actor = actor
        self.participants = participants
        self.memberJoins = memberJoins
        self.fork = fork
        self.message = message
    }
}

enum CloudGroupMessageCodec {
    static let prefix = "kordi-cloud-group:"
    private static let supportedKinds: Set<String> = [
        "group-invite",
        "group-message",
        "group-update",
        "group-title-update",
        "session-title-update",
        "session-fork"
    ]
    private final class ParsedEnvelopeBox: NSObject {
        let envelope: CloudGroupControlEnvelope?

        init(_ envelope: CloudGroupControlEnvelope?) {
            self.envelope = envelope
        }
    }
    private static let parsedEnvelopeCache: NSCache<NSString, ParsedEnvelopeBox> = {
        let cache = NSCache<NSString, ParsedEnvelopeBox>()
        cache.countLimit = 4_096
        cache.totalCostLimit = 16 * 1_024 * 1_024
        return cache
    }()

    static func encode(_ envelope: CloudGroupControlEnvelope) throws -> String {
        prefix + base64URL(try JSONEncoder().encode(envelope))
    }

    static func parse(_ body: String) -> CloudGroupControlEnvelope? {
        guard body.hasPrefix(prefix) else { return nil }
        let cacheKey = body as NSString
        if let cached = parsedEnvelopeCache.object(forKey: cacheKey) {
            return cached.envelope
        }

        let parsed: CloudGroupControlEnvelope? = {
            guard let data = dataFromBase64URL(String(body.dropFirst(prefix.count))),
                  let envelope = try? JSONDecoder().decode(CloudGroupControlEnvelope.self, from: data),
                  supportedKinds.contains(envelope.kind),
                  !envelope.groupId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !envelope.createdByAccountId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !envelope.actor.accountId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !envelope.participants.isEmpty else {
                return nil
            }
            if envelope.kind == "group-message", envelope.message == nil { return nil }
            return envelope
        }()
        parsedEnvelopeCache.setObject(
            ParsedEnvelopeBox(parsed),
            forKey: cacheKey,
            cost: min(body.utf8.count, 256 * 1_024)
        )
        return parsed
    }

    static func displayText(_ body: String) -> String? {
        parse(body)?.message?.text
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
        if remainder > 0 { normalized += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: normalized)
    }
}

enum CloudGroupAgentLifecycleProjector {
    private struct ResponseKey: Hashable {
        let requestId: String
        let senderAccountId: String
    }

    static func visibleMessageIds(in payloads: [CloudGroupMessagePayload]) -> Set<String> {
        var visibleIds = Set<String>()
        var preferredByKey: [ResponseKey: CloudGroupMessagePayload] = [:]

        for payload in payloads.sorted(by: messagePrecedes) {
            guard payload.senderKind == "agent",
                  let requestId = payload.requestId?.nonEmpty else {
                visibleIds.insert(payload.id)
                continue
            }
            let key = ResponseKey(
                requestId: requestId,
                senderAccountId: payload.senderAccountId
            )
            preferredByKey[key] = preferredByKey[key]
                .map { preferredResponse($0, payload) }
                ?? payload
        }

        visibleIds.formUnion(preferredByKey.values.map(\.id))
        return visibleIds
    }

    static func readRequestIds(in payloads: [CloudGroupMessagePayload]) -> Set<String> {
        Set(payloads.compactMap { payload in
            payload.senderKind == "agent" && payload.deliveryState != "queued"
                ? payload.requestId?.nonEmpty
                : nil
        })
    }

    private static func preferredResponse(
        _ existing: CloudGroupMessagePayload,
        _ candidate: CloudGroupMessagePayload
    ) -> CloudGroupMessagePayload {
        let existingIsProcessing = existing.deliveryState == "processing"
        let candidateIsProcessing = candidate.deliveryState == "processing"
        if existingIsProcessing != candidateIsProcessing {
            return existingIsProcessing ? candidate : existing
        }
        if existingIsProcessing {
            let existingLength = visibleTextLength(existing.text)
            let candidateLength = visibleTextLength(candidate.text)
            if existingLength != candidateLength {
                return candidateLength > existingLength ? candidate : existing
            }
        }
        return messagePrecedes(existing, candidate) ? candidate : existing
    }

    private static func visibleTextLength(_ text: String) -> Int {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return CloudMessageCodec.isAgentProcessingPlaceholder(trimmed) ? 0 : trimmed.count
    }

    private static func messagePrecedes(
        _ left: CloudGroupMessagePayload,
        _ right: CloudGroupMessagePayload
    ) -> Bool {
        left.createdAtMs < right.createdAtMs
            || (left.createdAtMs == right.createdAtMs && left.id < right.id)
    }
}
