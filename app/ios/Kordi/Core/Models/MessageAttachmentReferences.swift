import Foundation

/// Attachment ids whose files a message can place in the local attachment
/// cache: the attachments themselves, Live Photo companions, and voice audio.
enum MessageAttachmentReferences {
    static func ids(in message: ChatMessage) -> Set<String> {
        var ids = Set(message.attachments.flatMap { [$0.attachmentId] + ($0.livePhoto?.attachmentIds ?? []) })
        if let mediaId = message.voiceMessage?.mediaId { ids.insert(mediaId) }
        ids.remove("")
        return ids
    }

    static func ids(in message: CloudMessageDTO) -> Set<String> {
        var ids = Set(message.attachments.flatMap { [$0.attachmentId] + ($0.livePhoto?.attachmentIds ?? []) })
        if let mediaId = message.voiceMessage?.mediaId { ids.insert(mediaId) }
        ids.remove("")
        return ids
    }

    /// The candidate ids that no remaining message on this device uses.
    static func released(
        _ candidates: Set<String>,
        keptBy cloudMessages: some Sequence<CloudMessageDTO>,
        rendered renderedMessages: some Sequence<ChatMessage>
    ) -> Set<String> {
        guard !candidates.isEmpty else { return [] }
        var released = candidates
        for message in cloudMessages where !released.isEmpty {
            released.subtract(ids(in: message))
        }
        for message in renderedMessages where !released.isEmpty {
            released.subtract(ids(in: message))
        }
        return released
    }
}
