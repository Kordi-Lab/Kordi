import Foundation

struct LivePhotoResource: Codable, Hashable, Sendable {
    let attachmentId: String
    let name: String
    let mimeType: String
    let sizeBytes: Int64

    var chatAttachment: ChatAttachment {
        ChatAttachment(attachmentId: attachmentId, name: name, kind: .file,
                       mimeType: mimeType, sizeBytes: sizeBytes, previewURL: nil)
    }
}

struct LivePhotoAttachment: Codable, Hashable, Sendable {
    let video: LivePhotoResource
    let playback: LivePhotoResource
    var attachmentIds: [String] { [video.attachmentId, playback.attachmentId] }
}

struct LivePhotoFiles: Hashable, Sendable {
    let videoURL: URL
    let playbackURL: URL

    func optimisticMetadata(draftID: String) -> LivePhotoAttachment {
        func resource(_ url: URL, suffix: String, mimeType: String) -> LivePhotoResource {
            let bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            return LivePhotoResource(attachmentId: "pending:\(draftID):\(suffix)", name: url.lastPathComponent,
                                     mimeType: mimeType, sizeBytes: Int64(bytes))
        }
        return LivePhotoAttachment(
            video: resource(videoURL, suffix: "motion", mimeType: "video/quicktime"),
            playback: resource(playbackURL, suffix: "playback", mimeType: "video/mp4")
        )
    }

    func discardOwnedFiles() {
        for url in [videoURL, playbackURL]
            where url.deletingLastPathComponent().standardizedFileURL == FileManager.default.temporaryDirectory.standardizedFileURL
                && url.lastPathComponent.hasPrefix("kordi-live-") {
            try? FileManager.default.removeItem(at: url)
        }
    }

    func attachment(playback: Bool, previewURL: String?) -> PendingAttachment {
        let url = playback ? playbackURL : videoURL
        return PendingAttachment(id: UUID().uuidString, name: playback ? "Live.mp4" : "Live.mov",
                                 kind: .file, mimeType: playback ? "video/mp4" : "video/quicktime",
                                 data: Data(), fileURL: url, previewURL: playback ? previewURL : nil)
    }
}
