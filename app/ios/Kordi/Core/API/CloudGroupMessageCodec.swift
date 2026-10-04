import Foundation

struct CloudGroupStructuredContent: Codable, Hashable {
    let tools: [AgentExecutionTool]?
}

struct CloudGroupParticipant: Codable, Hashable, Identifiable {
    let accountId: String
    let displayName: String
    let avatarUrl: String?
    let agentId: String?
    let agentDisplayName: String?
    let agentAvatarUrl: String?
    let role: String?
    let joinedAt: String?

    var id: String { accountId }

    init(
        accountId: String,
        displayName: String,
        avatarUrl: String?,
        agentId: String? = nil,
        agentDisplayName: String? = nil,
        agentAvatarUrl: String? = nil,
        role: String?,
        joinedAt: String? = nil
    ) {
        self.accountId = accountId
        self.displayName = displayName
        self.avatarUrl = avatarUrl
        self.agentId = agentId
        self.agentDisplayName = agentDisplayName
        self.agentAvatarUrl = agentAvatarUrl
        self.role = role
        self.joinedAt = joinedAt
    }

    static func canonicalPrecedes(
        _ left: CloudGroupParticipant,
        _ right: CloudGroupParticipant
    ) -> Bool {
        let leftJoinedAt = left.joinedAt?.nonEmpty
        let rightJoinedAt = right.joinedAt?.nonEmpty
        if leftJoinedAt != rightJoinedAt {
            if let leftJoinedAt, let rightJoinedAt { return leftJoinedAt < rightJoinedAt }
            return leftJoinedAt != nil
        }
        return left.accountId < right.accountId
    }
}

struct CloudGroupMessagePayload: Codable, Hashable {
    let id: String
    let senderAccountId: String
    let text: String
    let createdAtMs: Double
    let senderKind: String?
    let senderAgentId: String?
    let senderOwnerAccountId: String?
    let senderOwnerName: String?
    let senderDisplayName: String?
    let deliveryState: String?
    let replyToMessageId: String?
    let requestId: String?
    let attachments: [CloudMessageAttachment]?
    let mentions: [MessageMention]?
    let forkSnapshot: Bool?
    let messageAction: MessageActionMetadata?
    var targetCloudAgentId: String?
    let targetCloudAgentName: String?
    var targetCloudAgentOwnerAccountId: String?
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
        senderAgentId: String? = nil,
        senderOwnerAccountId: String? = nil,
        senderOwnerName: String? = nil,
        senderDisplayName: String?,
        deliveryState: String?,
        replyToMessageId: String?,
        requestId: String?,
        attachments: [CloudMessageAttachment]? = nil,
        mentions: [MessageMention]? = nil,
        forkSnapshot: Bool? = nil,
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
        self.senderAgentId = senderAgentId
        self.senderOwnerAccountId = senderOwnerAccountId
        self.senderOwnerName = senderOwnerName
        self.senderDisplayName = senderDisplayName
        self.deliveryState = deliveryState
        self.replyToMessageId = replyToMessageId
        self.requestId = requestId
        self.attachments = attachments?.filter { $0.attachmentId != voiceMessage?.mediaId }
        self.mentions = mentions
        self.forkSnapshot = forkSnapshot
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

struct CloudGroupMemberJoin: Codable, Hashable {
    let eventId: String
    let accountId: String
    let displayName: String
    let createdAtMs: Double
}

/// A member leaving a group, posted by the leaver in a `group-update`.
/// `createdAtMs` is whole milliseconds; a fractional value from another
/// client is truncated when read.
struct CloudGroupMemberLeave: Codable, Hashable {
    let eventId: String
    let accountId: String
    let createdAtMs: Int64

    init(eventId: String, accountId: String, createdAtMs: Int64) {
        self.eventId = eventId
        self.accountId = accountId
        self.createdAtMs = createdAtMs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventId = try container.decode(String.self, forKey: .eventId)
        accountId = try container.decode(String.self, forKey: .accountId)
        if let whole = try? container.decode(Int64.self, forKey: .createdAtMs) {
            createdAtMs = whole
        } else {
            let value = try container.decode(Double.self, forKey: .createdAtMs)
            guard value.isFinite, abs(value) < 9.0e15 else {
                throw DecodingError.dataCorruptedError(
                    forKey: .createdAtMs, in: container, debugDescription: "Out of range"
                )
            }
            createdAtMs = Int64(value.rounded(.towardZero))
        }
    }

    private enum CodingKeys: String, CodingKey {
        case eventId, accountId, createdAtMs
    }
}

/// Decodes one list element without failing the surrounding list.
private struct LenientElement<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

struct CloudGroupSessionTitleSnapshot: Codable, Hashable {
    let title: String
    let titleSource: String
    let titleRevision: Int
    let titlePolicyVersion: Int
    let updatedAtMs: Double
    let updatedByAccountId: String
}

struct CloudGroupControlEnvelope: Codable, Hashable {
    let kind: String
    let groupId: String
    let groupSpaceId: String?
    let groupTitle: String?
    let createdByAccountId: String
    let actor: CloudGroupParticipant
    let participants: [CloudGroupParticipant]
    let sessionTitle: CloudGroupSessionTitleSnapshot?
    let sessionTitleSyncOnly: Bool?
    let channelCreated: Bool?
    let memberJoins: [CloudGroupMemberJoin]?
    let memberLeaves: [CloudGroupMemberLeave]?
    let message: CloudGroupMessagePayload?

    private enum CodingKeys: String, CodingKey {
        case kind, groupId, groupSpaceId, groupTitle, createdByAccountId, actor, participants
        case sessionTitle, sessionTitleSyncOnly, channelCreated, memberJoins, memberLeaves, message
    }

    init(
        kind: String,
        groupId: String,
        groupSpaceId: String?,
        groupTitle: String?,
        createdByAccountId: String,
        actor: CloudGroupParticipant,
        participants: [CloudGroupParticipant],
        sessionTitle: CloudGroupSessionTitleSnapshot? = nil,
        sessionTitleSyncOnly: Bool? = nil,
        channelCreated: Bool? = nil,
        memberJoins: [CloudGroupMemberJoin]? = nil,
        memberLeaves: [CloudGroupMemberLeave]? = nil,
        message: CloudGroupMessagePayload?
    ) {
        self.kind = kind
        self.groupId = groupId
        self.groupSpaceId = groupSpaceId
        self.groupTitle = groupTitle
        self.createdByAccountId = createdByAccountId
        self.actor = actor
        self.participants = participants
        self.sessionTitle = sessionTitle
        self.sessionTitleSyncOnly = sessionTitleSyncOnly
        self.channelCreated = channelCreated
        self.memberJoins = memberJoins
        self.memberLeaves = memberLeaves
        self.message = message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        groupId = try container.decode(String.self, forKey: .groupId)
        groupSpaceId = try container.decodeIfPresent(String.self, forKey: .groupSpaceId)
        groupTitle = try container.decodeIfPresent(String.self, forKey: .groupTitle)
        createdByAccountId = try container.decode(String.self, forKey: .createdByAccountId)
        actor = try container.decode(CloudGroupParticipant.self, forKey: .actor)
        participants = try container.decode([CloudGroupParticipant].self, forKey: .participants)
        sessionTitle = try container.decodeIfPresent(CloudGroupSessionTitleSnapshot.self, forKey: .sessionTitle)
        sessionTitleSyncOnly = try container.decodeIfPresent(Bool.self, forKey: .sessionTitleSyncOnly)
        channelCreated = try container.decodeIfPresent(Bool.self, forKey: .channelCreated)
        memberJoins = try container.decodeIfPresent([CloudGroupMemberJoin].self, forKey: .memberJoins)
        // Leaves are informational here. A malformed entry from another
        // client never hides the rest of the envelope.
        let leaves = (try? container.decodeIfPresent(
            [LenientElement<CloudGroupMemberLeave>].self, forKey: .memberLeaves
        ))?.compactMap(\.value)
        memberLeaves = leaves?.isEmpty == false ? leaves : nil
        message = try container.decodeIfPresent(CloudGroupMessagePayload.self, forKey: .message)
    }
}

enum CloudGroupMessageCodec {
    static let prefix = "kordi-cloud-group:"

    /// The kind a group message is shown as. An AI access notice is
    /// recognized only by the kind the server stored for the message, so an
    /// envelope that claims that kind is shown as an ordinary message.
    static func projectedMessageKind(wireKind: String?, envelopeKind: String?) -> String? {
        if wireKind == ChatMessage.aiAccessNoticeMessageKind { return ChatMessage.aiAccessNoticeMessageKind }
        if envelopeKind == ChatMessage.aiAccessNoticeMessageKind { return nil }
        return envelopeKind
    }
    private static let supportedKinds: Set<String> = [
        "group-invite",
        "group-message",
        "group-update",
        "group-title-update",
        "session-title-update"
    ]

    static func titleUpdateNotice(
        for envelope: CloudGroupControlEnvelope
    ) -> (text: String, messageKind: String)? {
        let actorName = envelope.actor.displayName.nonEmpty ?? "Someone"
        if envelope.kind == "group-invite", envelope.channelCreated == true {
            return ("\(actorName) created this channel.", ChatMessage.channelCreatedMessageKind)
        }
        if envelope.kind == "group-title-update",
           let title = envelope.groupTitle?.nonEmpty {
            return (
                "\(actorName) changed the group name to \(title)",
                ChatMessage.groupTitleUpdateMessageKind
            )
        }
        if envelope.kind == "session-title-update",
           envelope.sessionTitleSyncOnly != true,
           let title = envelope.sessionTitle?.title.nonEmpty
            ?? envelope.groupTitle?.nonEmpty {
            return (
                "\(actorName) changed the channel name to \(title)",
                ChatMessage.channelTitleUpdateMessageKind
            )
        }
        return nil
    }
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
        var message = envelope.message
        if let source = message, let target = GroupAgentTarget.resolve(source, participants: envelope.participants) {
            message?.targetCloudAgentId = target.agentId
            message?.targetCloudAgentOwnerAccountId = target.ownerAccountId
        }
        let normalized = CloudGroupControlEnvelope(
            kind: envelope.kind,
            groupId: envelope.groupId,
            groupSpaceId: envelope.groupSpaceId,
            groupTitle: envelope.groupTitle,
            createdByAccountId: envelope.createdByAccountId,
            actor: transportParticipant(envelope.actor),
            participants: envelope.participants.map(transportParticipant),
            sessionTitle: envelope.kind == "group-title-update" ? nil : envelope.sessionTitle,
            sessionTitleSyncOnly: envelope.sessionTitleSyncOnly,
            channelCreated: envelope.channelCreated,
            memberJoins: envelope.memberJoins,
            memberLeaves: envelope.memberLeaves,
            message: message
        )
        return prefix + base64URL(try JSONEncoder().encode(normalized))
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

    private static func transportParticipant(
        _ participant: CloudGroupParticipant
    ) -> CloudGroupParticipant {
        CloudGroupParticipant(
            accountId: participant.accountId,
            displayName: participant.displayName,
            avatarUrl: nil,
            agentId: participant.agentId,
            agentDisplayName: participant.agentDisplayName,
            agentAvatarUrl: nil,
            role: participant.role,
            joinedAt: participant.joinedAt
        )
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
