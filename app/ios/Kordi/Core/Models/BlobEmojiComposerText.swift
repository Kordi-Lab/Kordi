import UIKit

private extension NSAttributedString.Key {
    static let blobEmojiToken = NSAttributedString.Key("ai.kordi.blobEmojiToken")
}

enum BlobEmojiComposerText {
    private static let pattern = try! NSRegularExpression(
        pattern: ":blob:([A-Za-z0-9_-]+):"
    )

    static func plainText(_ value: String) -> String {
        let result = NSMutableString(string: value)
        for match in matches(in: value).reversed() {
            result.replaceCharacters(in: match.range, with: "Emoji")
        }
        return result as String
    }

    static func attributedString(_ value: String, font: UIFont) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let source = value as NSString
        var cursor = 0
        for match in matches(in: value) {
            if match.range.location > cursor {
                result.append(styled(source.substring(with: NSRange(
                    location: cursor,
                    length: match.range.location - cursor
                )), font: font))
            }
            let attachment = NSTextAttachment()
            attachment.image = BlobEmojiCatalog.previewImage(
                for: match.emoji,
                size: font.lineHeight
            ) ?? UIImage(systemName: "face.smiling")
            attachment.bounds = CGRect(
                x: 0,
                y: font.descender * 0.35,
                width: font.lineHeight,
                height: font.lineHeight
            )
            let fragment = NSMutableAttributedString(attachment: attachment)
            fragment.addAttribute(
                .blobEmojiToken,
                value: source.substring(with: match.range),
                range: NSRange(location: 0, length: fragment.length)
            )
            result.append(fragment)
            cursor = NSMaxRange(match.range)
        }
        if cursor < source.length {
            result.append(styled(source.substring(from: cursor), font: font))
        }
        return result
    }

    static func rawText(_ value: NSAttributedString) -> String {
        var result = ""
        var cursor = 0
        while cursor < value.length {
            var range = NSRange()
            if let token = value.attribute(
                .blobEmojiToken,
                at: cursor,
                effectiveRange: &range
            ) as? String {
                result += token
            } else {
                result += (value.string as NSString).substring(with: range)
            }
            cursor = NSMaxRange(range)
        }
        return result
    }

    static func containsUnrenderedToken(_ value: NSAttributedString) -> Bool {
        !matches(in: value.string).isEmpty
    }

    static func resetTypingAttributes(of textView: UITextView, font: UIFont? = nil) {
        var attributes = textView.typingAttributes
        let font = font ?? UIFont.preferredFont(forTextStyle: .body)
        guard (attributes[.font] as? UIFont) != font
            || (attributes[.foregroundColor] as? UIColor) != UIColor.label
            || attributes[.blobEmojiToken] != nil || attributes[.attachment] != nil else { return }
        attributes[.font] = font
        attributes[.foregroundColor] = UIColor.label
        attributes.removeValue(forKey: .blobEmojiToken)
        attributes.removeValue(forKey: .attachment)
        textView.typingAttributes = attributes
    }

    static func renderedSelection(
        forRaw selection: NSRange,
        in value: String
    ) -> NSRange {
        let start = renderedLocation(forRaw: selection.location, in: value)
        let end = renderedLocation(
            forRaw: selection.location + selection.length,
            in: value
        )
        return NSRange(location: start, length: max(0, end - start))
    }

    static func rawSelection(
        forRendered selection: NSRange,
        in value: String
    ) -> NSRange {
        let start = rawLocation(forRendered: selection.location, in: value)
        let end = rawLocation(
            forRendered: selection.location + selection.length,
            in: value
        )
        return NSRange(location: start, length: max(0, end - start))
    }

    private static func renderedLocation(forRaw location: Int, in value: String) -> Int {
        var removed = 0
        for match in matches(in: value) {
            if location < match.range.location { break }
            if location <= NSMaxRange(match.range) {
                return match.range.location - removed
                    + (location - match.range.location > match.range.length / 2 ? 1 : 0)
            }
            removed += match.range.length - 1
        }
        return max(0, min((value as NSString).length - removed, location - removed))
    }

    private static func rawLocation(forRendered location: Int, in value: String) -> Int {
        var removed = 0
        for match in matches(in: value) {
            let renderedStart = match.range.location - removed
            if location < renderedStart { break }
            if location <= renderedStart + 1 {
                return location == renderedStart
                    ? match.range.location
                    : NSMaxRange(match.range)
            }
            removed += match.range.length - 1
        }
        return max(0, min((value as NSString).length, location + removed))
    }

    private static func matches(in value: String) -> [BlobEmojiTokenMatch] {
        let source = value as NSString
        return pattern.matches(
            in: value,
            range: NSRange(location: 0, length: source.length)
        ).compactMap { match in
            guard match.numberOfRanges == 2 else { return nil }
            let id = source.substring(with: match.range(at: 1))
            return BlobEmojiCatalog.byID[id].map {
                BlobEmojiTokenMatch(range: match.range, emoji: $0)
            }
        }
    }

    private static func styled(_ value: String, font: UIFont) -> NSAttributedString {
        NSAttributedString(string: value, attributes: [
            .font: font,
            .foregroundColor: UIColor.label
        ])
    }
}

private struct BlobEmojiTokenMatch {
    let range: NSRange
    let emoji: BlobEmoji
}

