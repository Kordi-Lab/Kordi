import Foundation

enum MessageAuthor: String, Codable, Hashable {
    case me
    case person
    case agent
}

enum MessageDeliveryState: String, Codable, Hashable {
    case sending
    case sent
    case delivered
    case read
    case failed
    case cancelled

    var label: String {
        switch self {
        case .sending: "Sending"
        case .sent: "Sent"
        case .delivered: "Delivered"
        case .read: "Read"
        case .failed: "Failed to send"
        case .cancelled: "Canceled"
        }
    }
}

enum ChatAttachmentKind: String, Codable, Hashable {
    case image
    case file
}

struct ChatAttachment: Identifiable, Codable, Hashable {
    let attachmentId: String
    let name: String
    let kind: ChatAttachmentKind
    let mimeType: String?
    let sizeBytes: Int64?
    let previewURL: String?

    var id: String { attachmentId }

    var formatLabel: String {
        if let extensionName = URL(fileURLWithPath: name).pathExtension.nonEmpty {
            return extensionName.uppercased()
        }
        if let subtype = mimeType?.split(separator: "/").last?.trimmingCharacters(in: .whitespacesAndNewlines),
           !subtype.isEmpty {
            return subtype.uppercased()
        }
        return kind == .image ? "IMAGE" : "FILE"
    }

    var sizeLabel: String? {
        guard let sizeBytes, sizeBytes >= 0 else { return nil }
        return ByteCountFormatter.string(fromByteCount: sizeBytes, countStyle: .file)
    }
}

struct MessageActionSource: Codable, Hashable, Identifiable {
    let sourceSessionId: String
    let sourceMessageId: String
    let sourceMessageKind: String?
    let senderLabel: String
    let textPreview: String
    let attachmentCount: Int
    let createdAtMs: Double?
    let timeLabel: String?

    var id: String { "\(sourceSessionId):\(sourceMessageId)" }

    init(
        sourceSessionId: String,
        sourceMessageId: String,
        sourceMessageKind: String? = "text",
        senderLabel: String,
        textPreview: String,
        attachmentCount: Int,
        createdAtMs: Double? = nil,
        timeLabel: String? = nil
    ) {
        self.sourceSessionId = sourceSessionId
        self.sourceMessageId = sourceMessageId
        self.sourceMessageKind = sourceMessageKind
        self.senderLabel = senderLabel
        self.textPreview = textPreview
        self.attachmentCount = attachmentCount
        self.createdAtMs = createdAtMs
        self.timeLabel = timeLabel
    }
}

struct MessageActionMetadata: Codable, Hashable {
    let schemaVersion: Int
    let kind: String
    let source: MessageActionSource

    static func quote(_ source: MessageActionSource) -> MessageActionMetadata {
        MessageActionMetadata(schemaVersion: 1, kind: "quote", source: source)
    }

    static func forward(_ source: MessageActionSource) -> MessageActionMetadata {
        MessageActionMetadata(schemaVersion: 1, kind: "forward", source: source)
    }

    var replyToMessageId: String? {
        kind == "quote" ? source.sourceMessageId : nil
    }
}

struct PendingAttachment: Identifiable, Hashable, @unchecked Sendable {
    let id: String
    let name: String
    let kind: ChatAttachmentKind
    let mimeType: String?
    let data: Data
    let previewURL: String?

    var sizeBytes: Int64 { Int64(data.count) }

    var optimisticAttachment: ChatAttachment {
        ChatAttachment(
            attachmentId: "pending:\(id)",
            name: name,
            kind: kind,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            previewURL: previewURL
        )
    }
}

enum ComposerMentionKind: String, Hashable {
    case person
    case agent
}

struct ComposerMentionTarget: Identifiable, Hashable {
    let id: String
    let displayName: String
    let kind: ComposerMentionKind
    let accountId: String
    let agentId: String?
    let ownerName: String?
    let avatarSource: String?

    var mentionText: String { "@\(displayName)" }
}

enum ChatCallActivityEvent: String, Codable, Hashable {
    case started
    case ended
}

struct ChatCallActivity: Hashable {
    let event: ChatCallActivityEvent
    let callId: String?

    init?(messageKind: String?) {
        guard let messageKind = messageKind?.trimmingCharacters(in: .whitespacesAndNewlines),
              !messageKind.isEmpty else { return nil }
        if messageKind == "call" {
            event = .started
            callId = nil
            return
        }
        let components = messageKind.split(
            separator: ".",
            maxSplits: 2,
            omittingEmptySubsequences: false
        )
        guard components.count == 3,
              components[0] == "call",
              let parsedEvent = ChatCallActivityEvent(rawValue: String(components[1])),
              !components[2].isEmpty else { return nil }
        event = parsedEvent
        callId = String(components[2])
    }

    static func messageKind(for event: ChatCallActivityEvent, callId: String) -> String {
        "call.\(event.rawValue).\(callId.lowercased())"
    }

    func matchesActiveCall(_ call: CloudCall?) -> Bool {
        guard event == .started, let call, call.state != .ended else { return false }
        return callId == nil || callId == call.id
    }
}

struct ChatMessage: Identifiable, Codable, Hashable {
    let id: String
    let conversationId: String
    let author: MessageAuthor
    let authorName: String
    var text: String
    let createdAt: Date
    var deliveryState: MessageDeliveryState
    var errorMessage: String?
    var requestMessageId: String?
    var readByCount: Int?
    var readByAccountIds: [String]
    var attachments: [ChatAttachment]
    var replyToMessageId: String?
    var messageAction: MessageActionMetadata?
    var messageKind: String?

    var callActivity: ChatCallActivity? {
        ChatCallActivity(messageKind: messageKind)
    }

    init(
        id: String,
        conversationId: String,
        author: MessageAuthor,
        authorName: String,
        text: String,
        createdAt: Date,
        deliveryState: MessageDeliveryState,
        errorMessage: String?,
        requestMessageId: String?,
        readByCount: Int? = nil,
        readByAccountIds: [String] = [],
        attachments: [ChatAttachment] = [],
        replyToMessageId: String? = nil,
        messageAction: MessageActionMetadata? = nil,
        messageKind: String? = nil
    ) {
        self.id = id
        self.conversationId = conversationId
        self.author = author
        self.authorName = authorName
        self.text = text
        self.createdAt = createdAt
        self.deliveryState = deliveryState
        self.errorMessage = errorMessage
        self.requestMessageId = requestMessageId
        self.readByCount = readByCount
        self.readByAccountIds = readByAccountIds
        self.attachments = attachments
        self.replyToMessageId = replyToMessageId
        self.messageAction = messageAction
        self.messageKind = messageKind
    }

    var actionSource: MessageActionSource {
        actionSource(sessionId: conversationId)
    }

    func actionSource(sessionId: String) -> MessageActionSource {
        let normalized = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let preview = normalized.count <= 220
            ? normalized
            : String(normalized.prefix(219)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
        return MessageActionSource(
            sourceSessionId: sessionId,
            sourceMessageId: id,
            sourceMessageKind: author == .agent ? "agent-turn" : "text",
            senderLabel: author == .me ? "You" : authorName,
            textPreview: preview,
            attachmentCount: attachments.count,
            createdAtMs: createdAt.timeIntervalSince1970 * 1_000,
            timeLabel: createdAt.formatted(.dateTime.hour().minute())
        )
    }

    /// Re-forwarding a forwarded message keeps the original attribution instead
    /// of turning the current sender into the source of the forwarded content.
    func forwardSource(sessionId: String) -> MessageActionSource {
        if let action = messageAction, action.kind == "forward" {
            return action.source
        }
        return actionSource(sessionId: sessionId)
    }

    enum CodingKeys: String, CodingKey {
        case id, conversationId, author, authorName, text, createdAt, deliveryState, errorMessage
        case requestMessageId, readByCount, readByAccountIds, attachments, replyToMessageId, messageAction
        case messageKind
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        conversationId = try container.decode(String.self, forKey: .conversationId)
        author = try container.decode(MessageAuthor.self, forKey: .author)
        authorName = try container.decode(String.self, forKey: .authorName)
        text = try container.decode(String.self, forKey: .text)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        deliveryState = try container.decode(MessageDeliveryState.self, forKey: .deliveryState)
        errorMessage = try container.decodeIfPresent(String.self, forKey: .errorMessage)
        requestMessageId = try container.decodeIfPresent(String.self, forKey: .requestMessageId)
        readByCount = try container.decodeIfPresent(Int.self, forKey: .readByCount)
        readByAccountIds = try container.decodeIfPresent([String].self, forKey: .readByAccountIds) ?? []
        attachments = try container.decodeIfPresent([ChatAttachment].self, forKey: .attachments) ?? []
        replyToMessageId = try container.decodeIfPresent(String.self, forKey: .replyToMessageId)
        messageAction = try container.decodeIfPresent(MessageActionMetadata.self, forKey: .messageAction)
        messageKind = try container.decodeIfPresent(String.self, forKey: .messageKind)
    }
}
