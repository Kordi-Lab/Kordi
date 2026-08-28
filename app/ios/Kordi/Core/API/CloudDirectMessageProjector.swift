import Foundation

enum CloudDirectMessageProjector {
    static func project(
        _ messages: [CloudMessageDTO],
        conversation: ConversationSummary,
        ownAccountId: String
    ) -> [ChatMessage] {
        let sorted = CloudAgentLifecycleProjector.visibleRows(messages)
        let executionByResponseKey = CloudAgentLifecycleProjector
            .executionByResponseKey(in: messages)
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
        let requestCreatedAtById = Dictionary(
            uniqueKeysWithValues: sorted.compactMap { message -> (String, Date)? in
                guard !CloudMessageCodec.isAgentResponse(message.body) else { return nil }
                return (message.messageId, parseCloudDate(message.createdAt))
            }
        )
        var result: [ChatMessage] = []

        for wire in sorted {
            if wire.messageKind == CloudMessageCodec.agentSessionIdentityMessageKind
                || CloudMessageCodec.isAgentControl(wire.body)
                || CloudGroupMessageCodec.parse(wire.body) != nil {
                continue
            }

            let responseRequestId = CloudMessageCodec.agentResponseRequestId(wire.body)?.nonEmpty
            let anchoredCreatedAt = responseRequestId
                .flatMap { requestCreatedAtById[$0] }
                .map { $0.addingTimeInterval(0.001) }
            let ownerExecution = CloudAgentLifecycleProjector
                .responseKey(for: wire)
                .flatMap { executionByResponseKey[$0] }
                .map {
                    CloudAgentLifecycleProjector.execution(
                        $0,
                        finalizedFor: wire
                    )
                }
            result.append(map(
                wire,
                conversation: conversation,
                ownAccountId: ownAccountId,
                createdAt: anchoredCreatedAt,
                ownerExecution: ownerExecution
            ))

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
                conversationSequence: cancel.conversationSequence,
                author: .agent,
                authorName: conversation.agentDisplayName?.nonEmpty ?? "Kordi",
                text: "Request canceled by \(cancelledBy).",
                createdAt: parseCloudDate(cancel.createdAt),
                deliveryState: .cancelled,
                errorMessage: nil,
                requestMessageId: wire.messageId
            ))
        }

        for index in result.indices where result[index].author == .me
            && responseRequestIds.contains(result[index].id) {
            result[index].deliveryState = .read
        }
        return result.sorted(by: ChatMessage.timelinePrecedes)
    }

    private static func map(
        _ message: CloudMessageDTO,
        conversation: ConversationSummary,
        ownAccountId: String,
        createdAt: Date? = nil,
        ownerExecution: AgentExecutionSnapshot? = nil
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
        let visibleOwnerExecution = isAgentResponse
            && message.fromAccountId == ownAccountId
            && message.toAccountId == ownAccountId
            ? ownerExecution ?? CloudMessageCodec.agentExecution(message.body)
            : nil
        return ChatMessage(
            id: message.messageId,
            clientMessageId: message.clientMessageId,
            conversationId: conversation.id,
            conversationSequence: message.conversationSequence,
            author: author,
            authorName: authorName,
            text: CloudMessageCodec.displayText(message.body),
            createdAt: createdAt ?? parseCloudDate(message.createdAt),
            deliveryState: state,
            errorMessage: nil,
            requestMessageId: responseRequestId,
            attachments: message.voiceMessage == nil
                ? message.attachments.map {
                    $0.chatAttachment(messageKind: CloudMessageCodec.canonicalMessageKind(message))
                }
                : [],
            replyToMessageId: messageAction?.replyToMessageId ?? responseRequestId,
            reactionTargetMessageId: message.messageId,
            messageAction: messageAction,
            mentions: MessageMention.rebased(
                CloudMessageCodec.directEnvelope(message.body)?.mentions ?? [],
                in: CloudMessageCodec.displayText(message.body)
            ),
            messageKind: CloudMessageCodec.canonicalMessageKind(message),
            voiceMessage: message.voiceMessage,
            agentExecution: visibleOwnerExecution,
            backgroundAgentSessions: CloudMessageCodec.backgroundAgentSessions(message.body),
            reactions: message.reactions
        )
    }
}

extension CloudMessageAttachment {
    var chatAttachment: ChatAttachment {
        chatAttachment(messageKind: nil)
    }

    func chatAttachment(messageKind: String?) -> ChatAttachment {
        ChatAttachment(
            attachmentId: attachmentId,
            name: name,
            kind: inferredChatAttachmentKind,
            subtype: messageKind == "sticker" ? .sticker : subtype,
            altText: altText,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            widthPixels: widthPixels,
            heightPixels: heightPixels,
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
