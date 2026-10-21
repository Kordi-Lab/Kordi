import Foundation
import UIKit

/// Synthetic photos, files and links in the chat with Maya for
/// `--preview-contact-profile`, so the profile's shared pages have content.
extension PreviewData {
    static func contactProfileSharedMessages(now: Date) -> [ChatMessage] {
#if DEBUG
        guard ProcessInfo.processInfo.arguments.contains("--preview-contact-profile") else { return [] }
        let day: TimeInterval = 86_400
        var messages: [ChatMessage] = []

        func add(_ id: String, daysAgo: Double, mine: Bool, text: String = "", attachments: [ChatAttachment] = []) {
            messages.append(ChatMessage(
                id: "cp-\(id)", conversationId: "person:acct_maya", author: mine ? .me : .person,
                authorName: mine ? "You" : "Maya Chen", text: text,
                createdAt: now.addingTimeInterval(-daysAgo * day - 3_600), deliveryState: .read,
                errorMessage: nil, requestMessageId: nil, attachments: attachments
            ))
        }
        func photo(_ index: Int) -> ChatAttachment {
            ChatAttachment(
                attachmentId: "att_cp_photo_\(index)", name: "Photo-\(index).png", kind: .image,
                mimeType: "image/png", sizeBytes: 240_000, widthPixels: 600, heightPixels: 600,
                previewURL: contactProfilePhotoDataURL(seed: index)
            )
        }
        func file(_ id: String, _ name: String, _ mime: String, _ size: Int64) -> ChatAttachment {
            ChatAttachment(attachmentId: "att_cp_\(id)", name: name, kind: .file, mimeType: mime, sizeBytes: size, previewURL: nil)
        }

        add("photos-recent", daysAgo: 0.3, mine: false, attachments: (1...4).map(photo))
        add("photos-recent-2", daysAgo: 0.9, mine: true, attachments: (5...7).map(photo))
        add("video", daysAgo: 1.5, mine: false, attachments: [ChatAttachment(
            attachmentId: "att_cp_video", name: "Gripper-test.mp4", kind: .file, mimeType: "video/mp4",
            sizeBytes: 18_400_000, widthPixels: 1_080, heightPixels: 1_080, previewURL: contactProfilePhotoDataURL(seed: 8)
        )])
        add("photos-older", daysAgo: 34, mine: false, attachments: (9...12).map(photo))
        add("file-grant", daysAgo: 2, mine: false, attachments: [file("grant", "Grant draft v3.pdf", "application/pdf", 1_240_000)])
        add("file-inventory", daysAgo: 5, mine: true, attachments: [file("inventory", "Lab inventory.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 48_000)])
        add("file-notes", daysAgo: 36, mine: false, attachments: [file("notes", "Manipulation notes.md", "text/markdown", 6_100)])
        add("link-survey", daysAgo: 1, mine: false, text: "Worth reading: [Sim-to-real transfer survey](https://arxiv.org/abs/2009.13303)")
        add("link-seminar", daysAgo: 3, mine: true, text: "Seminar this week https://cemse.kaust.edu.sa/events and the [Franka setup guide](https://frankaemika.github.io/docs/)")
        add("link-repeat", daysAgo: 4, mine: false, text: "Again: https://arxiv.org/abs/2009.13303")
        add("link-dataset", daysAgo: 6, mine: false, text: "[Tabletop grasping dataset](https://huggingface.co/datasets) for the lab")
        add("link-code", daysAgo: 35, mine: true, text: "[Diffusion policy code](https://github.com/real-stanford/diffusion_policy)")
        add("link-cfp", daysAgo: 40, mine: false, text: "[RSS call for papers](https://roboticsconference.org/)")
        add("link-old", daysAgo: 400, mine: false, text: "[Tactile sensing review](https://www.nature.com/articles/s41586-020-2861-0)")
        return messages.sorted { $0.createdAt < $1.createdAt }
#else
        return []
#endif
    }

    private static func contactProfilePhotoDataURL(seed: Int) -> String? {
        let hues: [CGFloat] = [0.58, 0.08, 0.38, 0.78, 0.12, 0.55, 0.98]
        let hue = hues[seed % hues.count]
        let size = CGSize(width: 240, height: 240)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            let colors = [
                UIColor(hue: hue, saturation: 0.32, brightness: 0.78, alpha: 1).cgColor,
                UIColor(hue: hue, saturation: 0.42, brightness: 0.46, alpha: 1).cgColor,
            ] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            }
            UIColor(white: 1, alpha: 0.22).setFill()
            let radius = CGFloat(50 + (seed * 13) % 40)
            context.cgContext.fillEllipse(in: CGRect(x: 40 + CGFloat(seed * 17 % 80), y: 30 + CGFloat(seed * 29 % 90), width: radius, height: radius))
        }
        guard let data = image.pngData() else { return nil }
        return "data:image/png;base64,\(data.base64EncodedString())"
    }
}
