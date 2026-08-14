import Foundation

enum CloudDirectMessageProjector {
    static func project(
        _ messages: [CloudMessageDTO],
        conversation: ConversationSummary,
        ownAccountId: String
    ) -> [ChatMessage] {
        let sorted = messages.sorted { parseCloudDate($0.createdAt) < parseCloudDate($1.createdAt) }
        let cancellations = Dictionary(
            sorted.compactMap { message -> (String, CloudMessageDTO)? in
                guard let requestId = CloudMessageCodec.agentCancelEnvelope(message.body)?.requestId.nonEmpty else {
                    return nil
                }
                return (requestId, message)
            },
            uniquingKeysWith: { first, _ in first }
        )
        let responseRequestIds = Set(sorted.compactMap { CloudMessageCodec.agentResponseRequestId($0.body)?.nonEmpty })
        var visibleResponseKeys = Set<String>()
        var result: [ChatMessage] = []

        for wire in sorted {
            if CloudMessageCodec.isAgentControl(wire.body) || CloudGroupMessageCodec.parse(wire.body) != nil {
                continue
            }
            if let requestId = CloudMessageCodec.agentResponseRequestId(wire.body)?.nonEmpty {
                let responseKey = "\(requestId):\(wire.fromAccountId)"
                guard visibleResponseKeys.insert(responseKey).inserted else { continue }
            }

            result.append(map(wire, conversation: conversation, ownAccountId: ownAccountId))

            guard let cancel = cancellations[wire.messageId],
                  !responseRequestIds.contains(wire.messageId) else { continue }
            let targetAccountId = CloudMessageCodec.directEnvelope(wire.body)?.targetCloudAgentOwnerAccountId?.nonEmpty
                ?? conversation.peerAccountId.nonEmpty
                ?? ownAccountId
            let cancelledBy: String
            if cancel.fromAccountId == wire.fromAccountId {
                cancelledBy = "sender"
            } else if cancel.fromAccountId == targetAccountId {
                cancelledBy = "agent owner"
            } else {
                cancelledBy = "participant"
            }
            result.append(ChatMessage(
                id: "cloud-agent-cancelled:\(wire.messageId):\(cancel.messageId)",
                conversationId: conversation.id,
                author: .agent,
                authorName: conversation.agentDisplayName?.nonEmpty ?? "Kordi",
                text: "Request canceled by \(cancelledBy).",
                createdAt: parseCloudDate(cancel.createdAt),
                deliveryState: .cancelled,
                errorMessage: nil,
                requestMessageId: wire.messageId
            ))
        }

        return result.sorted {
            $0.createdAt < $1.createdAt || ($0.createdAt == $1.createdAt && $0.id < $1.id)
        }
    }

    private static func map(
        _ message: CloudMessageDTO,
        conversation: ConversationSummary,
        ownAccountId: String
    ) -> ChatMessage {
        let isAgentResponse = CloudMessageCodec.isAgentResponse(message.body)
        let responseRequestId = isAgentResponse ? CloudMessageCodec.agentResponseRequestId(message.body) : nil
        let author: MessageAuthor = isAgentResponse ? .agent : (message.fromAccountId == ownAccountId ? .me : .person)
        let state = CloudMessageStateProjector.deliveryState(for: message, ownAccountId: ownAccountId)
        let authorName: String
        switch author {
        case .me:
            authorName = "You"
        case .agent:
            authorName = conversation.agentDisplayName?.nonEmpty ?? "Kordi"
        case .person:
            authorName = conversation.ownerDisplayName?.nonEmpty ?? conversation.displayName
        }
        let messageAction = CloudMessageCodec.directEnvelope(message.body)?.messageAction
        return ChatMessage(
            id: message.messageId,
            conversationId: conversation.id,
            author: author,
            authorName: authorName,
            text: CloudMessageCodec.displayText(message.body),
            createdAt: parseCloudDate(message.createdAt),
            deliveryState: state,
            errorMessage: nil,
            requestMessageId: responseRequestId,
            attachments: message.attachments.map(\.chatAttachment),
            replyToMessageId: messageAction?.replyToMessageId ?? responseRequestId,
            messageAction: messageAction,
            messageKind: message.messageKind
        )
    }
}

extension CloudMessageAttachment {
    var chatAttachment: ChatAttachment {
        ChatAttachment(
            attachmentId: attachmentId,
            name: name,
            kind: inferredChatAttachmentKind,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            previewURL: previewUrl
        )
    }

    var inferredChatAttachmentKind: ChatAttachmentKind {
        let normalizedKind = kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalizedKind == "image" || normalizedKind == "photo" {
            return .image
        }
        if mimeType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("image/") == true {
            return .image
        }
        let imageExtensions: Set<String> = ["avif", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]
        if imageExtensions.contains(URL(fileURLWithPath: name).pathExtension.lowercased()) {
            return .image
        }
        return .file
    }
}
